import cors from "cors";
import express from "express";
import { pathToFileURL } from "node:url";
import { STACKSPOTS_EVENTS, toPublicEvent } from "./catalog.js";
import { withProjectName } from "./sponsors.js";
import {
  compactStoredEvents,
  rebuildSponsorsFromEvents,
  connectRedis,
  getCachedContract,
  getCachedStats,
  forgetEventIdsForTx,
  getEventsByIds,
  getPotLives,
  setStoredInitPotSponsors,
  getSyncState,
  listAllEvents,
  listEventIds,
  listPots,
  setCachedContract,
  setCachedStats,
} from "./cache.js";
import { config, requireContract, resolveRequestContext } from "./config.js";
import { decodeClarityResult } from "./decoder.js";
import { serializeArgs } from "./encode.js";
import {
  callReadOnly,
  fetchAddressBalances,
  fetchTransaction,
  normalizeLog,
  parseContractId,
  parseFunctionName,
} from "./hiro.js";
import { networkFromPrincipal } from "./network.js";
import {
  initPayloadFromEvent,
  initPotPrintForPot,
  initPotPrintsForSponsor,
  loadLivePotDetails,
  loadSponsorPoolConfig,
  parseOptionalContractId,
  sponsorsFromPrintLogs,
  parseOptionalPrincipal,
} from "./potDetails.js";
import { computeStatistics } from "./stats.js";
import { runSyncAll, runSyncSafe } from "./sync.js";

function potContractOf(print) {
  return print?.contract ?? print?.["pot-contract"] ?? print?.["pot-treasury"] ?? print?.potAddress ?? null;
}

function liveHasInitFlag(live) {
  return Boolean(live && typeof live === "object" && Object.prototype.hasOwnProperty.call(live, "pot-is-init"));
}

async function ensurePotLive(prints, ctx) {
  const rows = await attachStoredLive(prints, ctx);
  return Promise.all(
    rows.map(async (print) => {
      if (!print || typeof print !== "object" || liveHasInitFlag(print.live)) {
        return print;
      }
      const potAddress = potContractOf(print);
      if (!potAddress) return { ...print, live: null };
      try {
        const live = await loadLivePotDetails({
          contractId: potAddress,
          owner: print["pot-owner"] ?? print.owner,
          stackspotsContract: ctx.contract,
          ctx,
          pot: {
            potAddress,
            potType: print["pot-type"] ?? print.type,
            values: print,
          },
        });
        return { ...print, live: live.hasDecoded ? live.values : null };
      } catch {
        return { ...print, live: null };
      }
    }),
  );
}

async function attachStoredLive(prints, ctx) {
  const rows = Array.isArray(prints) ? prints : [];
  const lives = await getPotLives(rows.map(potContractOf), ctx);
  return rows.map((print) => {
    if (!print || typeof print !== "object") return print;
    if (print.live && typeof print.live === "object") return print;
    const id = String(potContractOf(print) ?? "").trim().toLowerCase();
    const live = id ? lives.get(id) : null;
    return live ? { ...print, live } : print;
  });
}

function printPayload(event) {
  if (!event || typeof event !== "object") return event;
  const { sourceContract: _source, ...print } = event;
  return print;
}

const app = express();
app.use(cors());
app.use(express.json());

let syncing = false;
let poller = null;

function parseLimitOffset(query) {
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  return { limit, offset };
}

function requestContext(req) {
  return resolveRequestContext(req.query?.network ?? req.body?.network);
}

function networkEnvelope(ctx) {
  return {
    network: ctx.network,
    networkSource: ctx.networkSource,
    contract: ctx.contract,
    stacksApiUrl: ctx.stacksApiUrl,
  };
}

async function attachInitPotTickets(prints, ctx) {
  const out = [];
  for (const print of prints) {
    if (Array.isArray(print.sponsors) && print.sponsors.length) {
      out.push(print);
      continue;
    }
    try {
      const tx = await fetchTransaction(print.txid, ctx.stacksApiUrl);
      const logs = (tx?.events ?? []).map((item) => normalizeLog(item, print.contract));
      const sponsors = sponsorsFromPrintLogs(logs, print.contract);
      if (Array.isArray(sponsors)) {
        await setStoredInitPotSponsors(print.txid, print.contract, sponsors, ctx);
        out.push({ ...print, sponsors });
        continue;
      }
      await forgetEventIdsForTx(print.txid, ctx);
    } catch (error) {
      console.error("[sponsors] init-pot tickets", print.txid, error.message);
      await forgetEventIdsForTx(print.txid, ctx);
    }
    out.push(print);
  }
  return out;
}

app.get("/health", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    const sync = await getSyncState(ctx);
    res.json({
      ok: true,
      ...networkEnvelope(ctx),
      redis: true,
      contracts: config.contracts,
      defaultNetwork: config.defaultNetwork,
      sync,
    });
  } catch (error) {
    if (error.status === 400) {
      next(error);
      return;
    }
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/catalog", (req, res, next) => {
  try {
    const ctx = requestContext(req);
    res.json({
      ...networkEnvelope(ctx),
      events: STACKSPOTS_EVENTS,
      notes: {
        values: "Redis and every event response store only the print fields decoded from the hex, plus txid. Same shape for every known event type. No hex or other metadata. uint/int are strings; optional none is null; principals are strings; buffers are 0x-hex.",
        pots: "GET /pots defaults to initialized pots only (excludes pre-init), sorted latest→oldest by Stacks block height. Pass ?event= or ?status= to override. GET /pots/details returns only decoded read-only values (no contract wrapper, pot shell, or call metadata).",
        sponsors: "GET /sponsors returns cached sponsor-platform prints: decoded fields, txid, and project-name (the contract name after the dot in sponsor-contract).",
        network: "Pass ?network=mainnet or ?network=testnet to select STACKSPOTS_CONTRACT_MAINNET / STACKSPOTS_CONTRACT_TESTNET, Hiro host, and Redis namespace.",
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/events", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const eventName = req.query.event ? String(req.query.event) : null;
    const pot = req.query.pot ? String(req.query.pot) : null;
    const sponsor = req.query.sponsor ? String(req.query.sponsor) : null;
    const all = req.query.all === "1" || req.query.all === "true";
    const { limit, offset } = all
      ? { limit: 1_000_000, offset: 0 }
      : parseLimitOffset(req.query);
    const { ids, total } = await listEventIds({ ...ctx, eventName, pot, sponsor, offset, limit });
    const events = (await getEventsByIds(ids, ctx)).map(toPublicEvent).filter(Boolean);
    res.json({
      ...networkEnvelope(ctx),
      events,
      total,
      limit: all ? events.length : limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/events/:id", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const id = decodeURIComponent(req.params.id);
    const [event] = await getEventsByIds([id], ctx);
    if (!event) {
      res.status(404).json({ error: "Event not found", id, ...networkEnvelope(ctx) });
      return;
    }
    const publicRow = toPublicEvent(event);
    if (!publicRow) {
      res.status(404).json({ error: "Event not found", id, ...networkEnvelope(ctx) });
      return;
    }
    res.json({ ...networkEnvelope(ctx), event: publicRow });
  } catch (error) {
    next(error);
  }
});

async function loadPotPrintEvents(ctx) {
  const [{ ids: initIds }, { ids: registeredIds }] = await Promise.all([
    listEventIds({ ...ctx, eventName: "init-pot", offset: 0, limit: 1_000_000 }),
    listEventIds({ ...ctx, eventName: "pot-registered", offset: 0, limit: 1_000_000 }),
  ]);
  const [initEvents, registeredEvents] = await Promise.all([
    getEventsByIds(initIds, ctx),
    getEventsByIds(registeredIds, ctx),
  ]);
  return [...initEvents, ...registeredEvents];
}

app.get("/pots", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const seen = new Set();
    const pots = [];
    for (const event of await loadPotPrintEvents(ctx)) {
      const print = printPayload(initPayloadFromEvent(event));
      if (!print?.txid && !print?.contract) continue;
      const key = String(print.contract ?? print["pot-treasury"] ?? print.txid ?? "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pots.push(print);
    }
    const withLive = await attachStoredLive(pots, ctx);
    res.json({
      ...networkEnvelope(ctx),
      pots: withLive,
      total: withLive.length,
      status: null,
      event: "init-pot",
    });
  } catch (error) {
    next(error);
  }
});

async function potDetailsHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const query = { ...req.query, ...(req.body ?? {}) };
    const owner = parseOptionalPrincipal(query.owner ?? query.sender, "owner");
    const contract = parseOptionalContractId(query.contract ?? query.pot, "contract");
    const sponsorContract = parseOptionalContractId(
      query.sponsor ?? query.sponsorContract ?? query["sponsor-contract"],
      "sponsor",
    );
    if (!owner && !contract && !sponsorContract) {
      const error = new Error("Pass owner, contract (ADDRESS.NAME), and/or sponsor (ADDRESS.NAME)");
      error.status = 400;
      throw error;
    }
    const { ids } = await listEventIds({
      ...ctx,
      eventName: "pre-init",
      offset: 0,
      limit: 1_000_000,
    });
    const core = String(ctx.contract ?? "").trim().toLowerCase();
    const wantContract = String(contract ?? "").trim().toLowerCase();
    const wantOwner = String(owner ?? "").trim().toLowerCase();
    const wantSponsor = String(sponsorContract ?? "").trim().toLowerCase();
    const pots = (await getEventsByIds(ids, ctx))
      .filter((event) => {
        const source = String(event?.sourceContract ?? "").trim().toLowerCase();
        return !source || !core || source === core;
      })
      .filter((event) => !wantOwner || String(event?.["pot-owner"] ?? "").trim().toLowerCase() === wantOwner)
      .filter((event) => {
        if (!wantContract) return true;
        const idsForPot = [event?.["pot-contract"], event?.["pot-treasury"], event?.contract];
        return idsForPot.some((value) => String(value ?? "").trim().toLowerCase() === wantContract);
      })
      .filter((event) => {
        if (!wantSponsor) return true;
        const listed = Array.isArray(event?.sponsors) ? event.sponsors : [];
        if (!listed.length) return true;
        return listed.some((row) => {
          const id = row?.["sponsor-contract"] ?? row?.sponsorContract;
          return String(id ?? "").trim().toLowerCase() === wantSponsor;
        });
      })
      .map((event) => printPayload(event));
    const refresh = query.refresh === "1" || query.refresh === true || query.refresh === "true";
    const withLive = await Promise.all(
      pots.map(async (print) => {
        const potAddress = print?.["pot-contract"] ?? print?.["pot-treasury"] ?? print?.contract;
        if (!potAddress) return { ...print, live: null };
        try {
          const live = await loadLivePotDetails({
            contractId: potAddress,
            owner: print["pot-owner"] ?? owner,
            sponsorContract,
            stackspotsContract: ctx.contract,
            refresh,
            ctx,
            pot: {
              potAddress,
              potType: print["pot-type"] ?? print.type,
              values: print,
            },
          });
          const allowed = live.values?.["is-contract-allowed-hash"];
          return {
            ...print,
            live: live.hasDecoded ? live.values : null,
            allowed: typeof allowed === "boolean" ? allowed : null,
          };
        } catch {
          return { ...print, live: null };
        }
      }),
    );
    res.json({
      ...networkEnvelope(ctx),
      owner: owner ?? null,
      contract: contract ?? null,
      sponsorContract: sponsorContract ?? null,
      pots: withLive,
      total: withLive.length,
      event: "pre-init",
    });
  } catch (error) {
    next(error);
  }
}

app.get("/pots/details", potDetailsHandler);
app.post("/pots/details", potDetailsHandler);

app.get("/pots/:address/events", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const potAddress = parseOptionalContractId(decodeURIComponent(req.params.address), "pot");
    const { ids, total } = await listEventIds({
      ...ctx,
      pot: potAddress,
      limit: 1_000_000,
      offset: 0,
    });
    const events = (await getEventsByIds(ids, ctx)).map((event) => printPayload(event));
    res.json({
      ...networkEnvelope(ctx),
      pot: potAddress,
      events,
      total,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/pots/:address/init-pot", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const potAddress = parseOptionalContractId(decodeURIComponent(req.params.address), "pot");
    const match = initPotPrintForPot(await loadPotPrintEvents(ctx), potAddress);
    if (!match) {
      res.status(404).json({ error: "Pot init log not found", pot: potAddress, ...networkEnvelope(ctx) });
      return;
    }
    const [pot] = await attachStoredLive(
      await attachInitPotTickets([printPayload(match)], ctx),
      ctx,
    );
    res.json({ ...networkEnvelope(ctx), pot });
  } catch (error) {
    next(error);
  }
});

app.get("/pots/:address", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const address = decodeURIComponent(req.params.address);
    if (address === "stats") {
      statsHandler(req, res, next);
      return;
    }
    if (address === "details") {
      potDetailsHandler(req, res, next);
      return;
    }
    const potAddress = parseOptionalContractId(address, "pot");
    const match = initPotPrintForPot(await loadPotPrintEvents(ctx), potAddress);
    if (!match) {
      res.status(404).json({ error: "Pot init log not found", address: potAddress, ...networkEnvelope(ctx) });
      return;
    }
    const [pot] = await attachStoredLive(
      await attachInitPotTickets([printPayload(match)], ctx),
      ctx,
    );
    res.json({ ...networkEnvelope(ctx), pot, event: "init-pot" });
  } catch (error) {
    next(error);
  }
});

app.get("/sponsors", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    // Prints, not the derived sponsor hash. That hash can be empty after a cache compact.
    const { ids } = await listEventIds({
      ...ctx,
      eventName: "sponsor-platform",
      offset: 0,
      limit: 1_000_000,
    });
    const seenTx = new Set();
    const core = String(ctx.contract ?? "").trim().toLowerCase();
    const events = await getEventsByIds(ids, ctx);
    const sponsorRows = [];
    for (const row of events.map(withProjectName).filter(Boolean)) {
      const source = String(row?.sourceContract ?? "").trim().toLowerCase();
      if (source && core && source !== core) continue;
      const txid = row?.txid;
      if (!txid || seenTx.has(txid)) continue;
      seenTx.add(txid);
      const sponsorContract =
        row["sponsor-contract"] ?? row.sponsorContract ?? row["contract-address"] ?? row.contractAddress ?? null;
      const sponsorPayload = printPayload(row);
      const poolConfig = sponsorContract
        ? await loadSponsorPoolConfig({
            sponsorContract,
            burnHeight: row["burn-block-height"] ?? row.burnBlockHeight ?? 0,
            sender: row.sponsor ?? null,
            refresh: false,
            ctx,
          })
        : null;
      sponsorRows.push(poolConfig ? { ...sponsorPayload, "pool-config": poolConfig, poolConfig } : sponsorPayload);
    }
    res.json({ ...networkEnvelope(ctx), sponsors: sponsorRows, total: sponsorRows.length });
  } catch (error) {
    next(error);
  }
});

app.get("/sponsors/:address/pots", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const sponsorContract = parseOptionalContractId(
      decodeURIComponent(req.params.address),
      "sponsor",
    );
    const [{ ids: sponsorIds }, initEvents] = await Promise.all([
      listEventIds({ ...ctx, sponsor: sponsorContract, limit: 1_000_000, offset: 0 }),
      loadPotPrintEvents(ctx),
    ]);
    const sponsorEvents = await getEventsByIds(sponsorIds, ctx);
    const ticketPots = sponsorEvents
      .filter((event) => event?.event === "sponsor-event")
      .map((event) => event["pot-contract"])
      .filter(Boolean);
    const pots = await ensurePotLive(
      (
        await attachInitPotTickets(
          initPotPrintsForSponsor(initEvents, sponsorContract, ticketPots),
          ctx,
        )
      ).map((row) => printPayload(row)),
      ctx,
    );
    res.json({
      ...networkEnvelope(ctx),
      sponsor: sponsorContract,
      pots,
      total: pots.length,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/sponsors/:address", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const address = decodeURIComponent(req.params.address);
    const { ids, total } = await listEventIds({
      ...ctx,
      sponsor: address,
      limit: 1_000_000,
      offset: 0,
    });
    const events = (await getEventsByIds(ids, ctx)).map((event) => printPayload(withProjectName(event)));
    const sponsor =
      events.find((event) => event.event === "sponsor-platform") ??
      events.find(
        (event) => event["sponsor-contract"] === address || event["contract-address"] === address,
      ) ??
      null;
    if (!sponsor && !events.length) {
      res.status(404).json({ error: "Sponsor not found", address, ...networkEnvelope(ctx) });
      return;
    }
    const sponsorContract = sponsor?.["sponsor-contract"] ?? sponsor?.sponsorContract ?? address;
    const poolConfig = sponsorContract
      ? await loadSponsorPoolConfig({
          sponsorContract,
          burnHeight: sponsor?.["burn-block-height"] ?? sponsor?.burnBlockHeight ?? 0,
          sender: sponsor?.sponsor ?? null,
          refresh: false,
          ctx,
        })
      : null;
    const enrichedSponsor = poolConfig ? { ...sponsor, "pool-config": poolConfig, poolConfig } : sponsor;
    res.json({
      ...networkEnvelope(ctx),
      sponsor: enrichedSponsor,
      events,
      total,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/tx/:txId", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    const txId = decodeURIComponent(req.params.txId);
    const tx = await fetchTransaction(txId, ctx.stacksApiUrl);
    res.json({ ...networkEnvelope(ctx), tx });
  } catch (error) {
    next(error);
  }
});

app.get("/balances/:address", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    const address = decodeURIComponent(req.params.address);
    const unanchored = req.query.unanchored !== "0" && req.query.unanchored !== "false";
    const balances = await fetchAddressBalances(address, ctx.stacksApiUrl, { unanchored });
    res.json({ ...networkEnvelope(ctx), address, balances });
  } catch (error) {
    next(error);
  }
});

async function statsHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    let stats = !refresh ? await getCachedStats(ctx) : null;
    if (!stats) {
      const [events, pots] = await Promise.all([listAllEvents(ctx), listPots(ctx)]);
      const lives = await getPotLives(
        pots.map((pot) => pot.potAddress).filter(Boolean),
        ctx,
      );
      const potsWithLive = pots.map((pot) => {
        const id = String(pot.potAddress ?? "").trim().toLowerCase();
        const live = pot.live ?? (id ? lives.get(id) : null);
        return live ? { ...pot, live } : pot;
      });
      stats = computeStatistics(events, potsWithLive, { stackspotsContract: ctx.contract });
      await setCachedStats(stats, ctx);
    }
    res.json({ ...networkEnvelope(ctx), ...stats });
  } catch (error) {
    next(error);
  }
}

app.get("/stats", statsHandler);
app.get("/pots/stats", statsHandler);

function parseArgsInput(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        const error = new Error("args must be a JSON array");
        error.status = 400;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error.status) throw error;
      const bad = new Error("args must be valid JSON");
      bad.status = 400;
      throw bad;
    }
  }
  const error = new Error("args must be an array");
  error.status = 400;
  throw error;
}

function resolveReadTarget(req) {
  const params = req.params;
  const query = req.query;
  const body = req.body ?? {};
  const fromQuery = query.address ? String(query.address) : null;

  if (params.function && params.address && params.name) {
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(params.function),
    };
  }

  if (params.address && params.name) {
    if (String(params.address).includes(".")) {
      return {
        parsed: parseContractId(params.address),
        functionName: parseFunctionName(
          params.name ?? body.function ?? query.function ?? config.defaultReadFunction,
        ),
      };
    }
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(
        body.function ?? query.function ?? config.defaultReadFunction,
      ),
    };
  }

  return {
    parsed: parseContractId(params.contractId ?? fromQuery),
    functionName: parseFunctionName(
      body.function ?? query.function ?? config.defaultReadFunction,
    ),
  };
}

async function contractReadHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    const { parsed, functionName } = resolveReadTarget(req);
    const sender = String(req.body?.sender ?? req.query.sender ?? parsed.address);
    const args = parseArgsInput(req.body?.args ?? req.query.args);
    const argHexes = serializeArgs(args);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true" || req.body?.refresh === true;
    const cacheKey = `${parsed.contractId}:${functionName}:${sender}:${argHexes.join(",")}`;

    let payload = !refresh ? await getCachedContract(cacheKey, ctx) : null;
    if (payload && "clarity" in payload) {
      const { clarity, ...rest } = payload;
      payload = rest;
    }
    if (!payload) {
      const read = await callReadOnly({
        address: parsed.address,
        name: parsed.name,
        functionName,
        sender,
        arguments: argHexes,
      });
      const decoded = decodeClarityResult(read.result);
      payload = {
        ...networkEnvelope(ctx),
        network: networkFromPrincipal(parsed.address) ?? ctx.network,
        contractId: parsed.contractId,
        address: parsed.address,
        name: parsed.name,
        function: functionName,
        sender,
        args: argHexes,
        okay: read.okay,
        ok: decoded.ok,
        values: decoded.values,
        error: decoded.error ?? decoded.decodeError ?? null,
      };
      await setCachedContract(cacheKey, payload, ctx);
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
}

app.get("/contracts/:address/:name/:function", contractReadHandler);
app.post("/contracts/:address/:name/:function", contractReadHandler);
app.get("/contracts/:address/:name", contractReadHandler);
app.post("/contracts/:address/:name", contractReadHandler);
app.get("/contracts/:contractId", contractReadHandler);
app.post("/contracts/:contractId", contractReadHandler);
app.get("/contracts", (req, res, next) => {
  if (!req.query.address) {
    res.status(400).json({
      error:
        "Pass a contract address as ADDRESS.NAME via /contracts/:address/:name, /contracts/:address.name, or ?address=",
    });
    return;
  }
  contractReadHandler(req, res, next);
});
app.post("/contracts", (req, res, next) => {
  if (req.body?.address && !req.query.address) {
    req.query.address = String(req.body.address);
  }
  if (!req.query.address) {
    res.status(400).json({
      error: "Pass address as ADDRESS.NAME in the path, query, or JSON body",
    });
    return;
  }
  contractReadHandler(req, res, next);
});

app.post("/sync", async (req, res, next) => {
  try {
    if (syncing) {
      res.status(409).json({ error: "Sync already running" });
      return;
    }
    syncing = true;
    const full = req.query.full === "1" || req.body?.full === true;
    const hasNetwork = req.query.network != null || req.body?.network != null;
    if (hasNetwork) {
      const ctx = requestContext(req);
      requireContract(ctx);
      const result = await runSyncSafe({ full, network: ctx.network, contract: ctx.contract });
      res.json({ ...networkEnvelope(ctx), ...result });
      return;
    }
    const results = await runSyncAll({ full });
    res.json({
      network: "all",
      networkSource: "default",
      defaultNetwork: config.defaultNetwork,
      contracts: config.contracts,
      results,
    });
  } catch (error) {
    next(error);
  } finally {
    syncing = false;
  }
});

app.use((error, _req, res, _next) => {
  console.error("[api]", error);
  res.status(error.status && Number.isInteger(error.status) ? error.status : 500).json({
    error: error.message ?? "Internal error",
  });
});

async function poll() {
  if (syncing || config.syncIntervalMs <= 0) return;
  syncing = true;
  try {
    const results = await runSyncAll();
    for (const result of results) {
      if (result.stored) {
        console.log(
          `[sync] ${result.network} stored ${result.stored} events (total ${result.total}, ${result.mode})`,
        );
      }
    }
  } catch (error) {
    console.error("[poll]", error.message);
  } finally {
    syncing = false;
  }
}

export async function start() {
  await connectRedis();
  const redisUrl = new URL(config.redisUrl);
  if (redisUrl.password) redisUrl.password = "***";
  console.log(`[redis] connected ${redisUrl.toString()}`);
  for (const network of ["mainnet", "testnet"]) {
    if (!config.contracts[network]) continue;
    await compactStoredEvents({ network, contract: config.contracts[network] }).catch((error) => {
      console.error("[cache] compact", network, error.message);
    });
    await rebuildSponsorsFromEvents({ network, contract: config.contracts[network] }).catch((error) => {
      console.error("[cache] sponsors", network, error.message);
    });
  }

  app.listen(config.port, config.host, () => {
    console.log(`[api] http://127.0.0.1:${config.port}`);
    console.log(`[api] listening on ${config.host}:${config.port}`);
    console.log(`[api] default network ${config.defaultNetwork} ${config.stacksApiUrl}`);
    console.log(`[api] mainnet ${config.contracts.mainnet ?? "(unset)"}`);
    console.log(`[api] testnet ${config.contracts.testnet ?? "(unset)"}`);
  });

  await poll();
  if (config.syncIntervalMs > 0) {
    poller = setInterval(poll, config.syncIntervalMs);
  }
  return { app, poller };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

import { getEventsByIds, listEventIds } from "../cache.js";
import {
  isPreInitLogsSource,
  networkEnvelope,
  printPayload,
  queryFlag,
  requestContext,
  requireContract,
} from "../http.js";
import {
  attachInitPotTickets,
  attachStoredLive,
  ensurePotLive,
  loadJoinableInitPotEvents,
  potContractOf,
} from "../live.js";
import {
  initPayloadFromEvent,
  initPotPrintForPot,
  loadLivePotDetails,
  parseOptionalContractId,
  parseOptionalPrincipal,
} from "../potDetails.js";
import { isPreInitPrintSource } from "../pots.js";
import { mergeSponsorTickets, sponsorContractFromTicket } from "../sponsors.js";

async function listHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const byKey = new Map();
    for (const event of await loadJoinableInitPotEvents(ctx)) {
      const print = printPayload(initPayloadFromEvent(event));
      if (!print?.txid && !print?.contract) continue;
      const key = String(print.contract ?? print["pot-treasury"] ?? print.txid ?? "").toLowerCase();
      if (!key) continue;
      const prev = byKey.get(key);
      if (prev) {
        const sponsors = mergeSponsorTickets(prev.sponsors, print.sponsors);
        if (sponsors.length) prev.sponsors = sponsors;
        continue;
      }
      byKey.set(key, print);
    }
    const pots = [...byKey.values()];
    res.json({
      ...networkEnvelope(ctx),
      pots,
      total: pots.length,
      status: null,
      event: "init-pot",
    });
  } catch (error) {
    next(error);
  }
}

async function detailsHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const query = { ...req.query, ...(req.body ?? {}) };
    const owner = parseOptionalPrincipal(query.owner, "owner");
    const sender = parseOptionalPrincipal(query.sender, "sender") || owner;
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
    const wantContract = String(contract ?? "").trim().toLowerCase();
    const wantOwner = String(owner ?? "").trim().toLowerCase();
    const wantSponsor = String(sponsorContract ?? "").trim().toLowerCase();
    const seenPots = new Set();
    const pots = (await getEventsByIds(ids, ctx))
      .filter((event) =>
        isPreInitPrintSource(event?.sourceContract, {
          preInitLogsContract: ctx.preInitLogsContract,
        }) || isPreInitLogsSource(event, ctx.preInitLogsContract),
      )
      .filter((event) => {
        const potAddress = event?.["pot-contract"] ?? event?.["pot-treasury"] ?? event?.contract;
        const key = String(potAddress ?? "").trim().toLowerCase();
        if (!key) return true;
        if (seenPots.has(key)) return false;
        seenPots.add(key);
        return true;
      })
      .filter((event) => !wantOwner || String(event?.["pot-owner"] ?? event?.sender ?? "").trim().toLowerCase() === wantOwner)
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
          const id = sponsorContractFromTicket(row);
          return String(id ?? "").trim().toLowerCase() === wantSponsor;
        });
      })
      .map((event) => printPayload(event));
    const refresh = queryFlag(query);
    const withLive = await Promise.all(
      pots.map(async (print) => {
        const potAddress = potContractOf(print);
        if (!potAddress) return { ...print, live: null };
        try {
          const live = await loadLivePotDetails({
            contractId: potAddress,
            owner: sender || print["pot-owner"] || owner,
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

async function potEventsHandler(req, res, next) {
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
}

async function oneInitPotHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const potAddress = parseOptionalContractId(decodeURIComponent(req.params.address), "pot");
    const match = initPotPrintForPot(await loadJoinableInitPotEvents(ctx), potAddress);
    if (!match) {
      res.status(404).json({ error: "Pot init log not found", pot: potAddress, ...networkEnvelope(ctx) });
      return;
    }
    const refresh = queryFlag(req.query);
    const [pot] = refresh
      ? await ensurePotLive(await attachInitPotTickets([printPayload(match)], ctx), ctx, { refresh: true })
      : await attachStoredLive(await attachInitPotTickets([printPayload(match)], ctx), ctx);
    res.json({ ...networkEnvelope(ctx), pot, event: "init-pot" });
  } catch (error) {
    next(error);
  }
}

async function potByAddressHandler(req, res, next) {
  const address = decodeURIComponent(req.params.address);
  if (address === "stats" || address === "details") {
    next();
    return;
  }
  return oneInitPotHandler(req, res, next);
}

export function registerPotsRoutes(app) {
  app.get("/pots", listHandler);
  app.get("/pots/details", detailsHandler);
  app.post("/pots/details", detailsHandler);
  app.get("/pots/:address/events", potEventsHandler);
  app.get("/pots/:address/init-pot", oneInitPotHandler);
  app.get("/pots/:address", potByAddressHandler);
}

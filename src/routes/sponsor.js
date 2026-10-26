import { getEventsByIds, getSponsorLives, listEventIds } from "../cache.js";
import {
  loadEventsByName,
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
} from "../live.js";
import {
  initPotPrintsForSponsor,
  parseOptionalContractId,
  attachSponsorContractLives,
} from "../potDetails.js";
import { computeSponsorPage } from "../sponsorPage.js";
import { selectSponsorPlatformPrints, withProjectName } from "../sponsors.js";

async function loadSponsorPlatformEvents(ctx) {
  const { events } = await loadEventsByName(ctx, "sponsor-platform");
  return selectSponsorPlatformPrints(events, { hubContract: ctx.contract }).map(withProjectName);
}

async function attachCachedSponsorLive(prints, ctx) {
  const rows = Array.isArray(prints) ? prints : [];
  const ids = rows
    .map((row) => row?.["sponsor-contract"] ?? row?.sponsorContract ?? row?.contract)
    .filter(Boolean);
  const lives = await getSponsorLives(ids, ctx);
  return rows.map((row) => {
    const id = String(row?.["sponsor-contract"] ?? row?.sponsorContract ?? row?.contract ?? "")
      .trim()
      .toLowerCase();
    const live = id ? lives.get(id) : null;
    return live ? { ...row, live } : row;
  });
}

async function listHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const prints = (await loadSponsorPlatformEvents(ctx)).map((row) => printPayload(row));
    const withCache = await attachCachedSponsorLive(prints, ctx);
    const refresh = queryFlag(req.query);
    const sponsors = refresh
      ? await attachSponsorContractLives(withCache, ctx, { refresh: true })
      : withCache;
    const page = computeSponsorPage(sponsors);
    res.json({
      ...networkEnvelope(ctx),
      ...page,
      sponsors: page.sponsors.map((row) => printPayload(row)),
    });
  } catch (error) {
    next(error);
  }
}

async function lookupHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const address = decodeURIComponent(req.params.address);
    const platformPrints = selectSponsorPlatformPrints(await loadSponsorPlatformEvents(ctx), {
      hubContract: ctx.contract,
      sponsorContract: address,
    }).map((row) => printPayload(row));
    const { ids, total } = await listEventIds({
      ...ctx,
      sponsor: address,
      limit: 1_000_000,
      offset: 0,
    });
    const indexed = (await getEventsByIds(ids, ctx)).map((event) => printPayload(withProjectName(event)));
    const seen = new Set(platformPrints.map((row) => row?.txid).filter(Boolean));
    const events = [
      ...platformPrints,
      ...indexed.filter((row) => {
        const txid = row?.txid;
        if (txid && seen.has(txid)) return false;
        if (txid) seen.add(txid);
        return true;
      }),
    ];
    const sponsor = platformPrints[0] ?? null;
    if (!sponsor && !events.length) {
      res.status(404).json({ error: "Sponsor not found", address, ...networkEnvelope(ctx) });
      return;
    }
    const refresh = queryFlag(req.query);
    const [withLive] = sponsor
      ? await attachSponsorContractLives([sponsor], ctx, { refresh })
      : [null];
    res.json({
      ...networkEnvelope(ctx),
      sponsor: withLive ?? sponsor,
      events,
      total: Math.max(total, events.length),
    });
  } catch (error) {
    next(error);
  }
}

async function sponsorPotsHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const sponsorContract = parseOptionalContractId(
      decodeURIComponent(req.params.address),
      "sponsor",
    );
    const [{ ids: sponsorIds }, initEvents] = await Promise.all([
      listEventIds({ ...ctx, sponsor: sponsorContract, limit: 1_000_000, offset: 0 }),
      loadJoinableInitPotEvents(ctx),
    ]);
    const sponsorEvents = await getEventsByIds(sponsorIds, ctx);
    const ticketPots = sponsorEvents
      .filter((event) => event?.event === "sponsor-event")
      .map((event) => event["pot-contract"])
      .filter(Boolean);
    const refresh = queryFlag(req.query);
    const prints = (
      await attachInitPotTickets(
        initPotPrintsForSponsor(initEvents, sponsorContract, ticketPots),
        ctx,
      )
    ).map((row) => printPayload(row));
    const pots = refresh
      ? await ensurePotLive(prints, ctx, { refresh: true, sponsorContract })
      : await attachStoredLive(prints, ctx);
    res.json({
      ...networkEnvelope(ctx),
      sponsor: sponsorContract,
      pots,
      total: pots.length,
    });
  } catch (error) {
    next(error);
  }
}

export function registerSponsorRoutes(app) {
  app.get("/sponsor", listHandler);
  app.get("/sponsors", listHandler);
  app.get("/sponsor/:address/pots", sponsorPotsHandler);
  app.get("/sponsors/:address/pots", sponsorPotsHandler);
  app.get("/sponsor/:address", lookupHandler);
  app.get("/sponsors/:address", lookupHandler);
}

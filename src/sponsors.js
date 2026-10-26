import { eventPrint, eventTxId } from "./catalog.js";
import { isPotContractId } from "./pots.js";

export const SPONSOR_EVENTS = new Set([
  "platform sponsor contract added",
  "sponsor-platform",
  "sponsor-event",
]);

export function isSponsorEvent(eventName) {
  return Boolean(eventName) && SPONSOR_EVENTS.has(eventName);
}

export function isSponsorContractId(value) {
  return isPotContractId(value);
}

function clarityTypeName(row) {
  return String(row?.type ?? "").toLowerCase();
}

function isResponseErr(row) {
  const type = clarityTypeName(row);
  return row?.ok === false || type === "err" || type === "responseerr" || type === "responserror";
}

function isWrappedClarity(row) {
  const type = clarityTypeName(row);
  return (
    row?.ok === true ||
    type === "response" ||
    type === "ok" ||
    type === "responseok" ||
    type === "tuple" ||
    type === "optional" ||
    type === "some"
  );
}

export function sponsorTicketRows(list) {
  if (Array.isArray(list)) return list;
  if (list && typeof list === "object" && Array.isArray(list.value)) return list.value;
  return [];
}

function principalId(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    if (typeof value.value === "string") return value.value.trim();
    if (typeof value.value === "object") return principalId(value.value);
  }
  return "";
}

/** Flatten `(ok {sponsor-contract, ticket-id})` printed by init-pot. */
export function unwrapSponsorTicket(row) {
  if (typeof row === "string") {
    const id = row.trim();
    return id.includes(".") ? { "sponsor-contract": id } : null;
  }
  if (row == null || typeof row !== "object") return null;
  if (Array.isArray(row)) return null;
  if (isResponseErr(row)) return null;
  const inner = row.value;
  if (inner && typeof inner === "object" && !Array.isArray(inner) && isWrappedClarity(row)) {
    return unwrapSponsorTicket(inner);
  }
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    row["sponsor-contract"] == null &&
    inner["sponsor-contract"] != null
  ) {
    return unwrapSponsorTicket(inner);
  }
  return row;
}

export function sponsorContractFromTicket(row) {
  if (typeof row === "string") return isSponsorContractId(row) ? String(row).trim() : null;
  const ticket = unwrapSponsorTicket(row);
  if (!ticket) return null;
  const id = principalId(ticket["sponsor-contract"] ?? ticket.sponsorContract ?? ticket.contract);
  return isSponsorContractId(id) ? id : null;
}

export function ticketIdFromTicket(row) {
  const ticket = unwrapSponsorTicket(row);
  if (!ticket) return null;
  const id = ticket["ticket-id"] ?? ticket.ticketId;
  return id == null || id === "" ? null : String(id);
}

export function normalizeSponsorTickets(list) {
  const rows = sponsorTicketRows(list);
  if (!rows.length && !Array.isArray(list) && !(list && Array.isArray(list.value))) return list;
  return rows.map(unwrapSponsorTicket).filter(Boolean);
}

/** Unique platform-sponsor tickets across init-pot prints for the same pot. */
export function mergeSponsorTickets(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of sponsorTicketRows(list)) {
      const row = unwrapSponsorTicket(raw);
      const id = sponsorContractFromTicket(row ?? raw);
      const key = id ? id.toLowerCase() : row ? JSON.stringify(row) : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row ?? raw);
    }
  }
  return out;
}

function firstContractId(...candidates) {
  for (const value of candidates) {
    if (isSponsorContractId(value)) return value;
  }
  return null;
}

function pickText(...candidates) {
  for (const value of candidates) {
    if (value != null && value !== "") return String(value);
  }
  return null;
}

function asRuleList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const label = pickText(row.label);
      if (!label) return null;
      return {
        label,
        state: Boolean(row.state),
        required: pickText(row.required) ?? "0",
        score: pickText(row.score) ?? "0",
      };
    })
    .filter(Boolean);
}

function ticketEntry(values) {
  const potContract = firstContractId(values?.["pot-contract"]);
  const ticketId = pickText(values?.["ticket-id"]);
  if (!potContract || ticketId == null) return null;
  return {
    key: `${ticketId}:${potContract}`,
    ticketId,
    potContract,
    potDetails: values?.["pot-details"] && typeof values["pot-details"] === "object" ? values["pot-details"] : null,
  };
}

function mergeTickets(existing = [], incoming = []) {
  const byKey = new Map();
  for (const ticket of [...existing, ...incoming]) {
    if (!ticket?.key) continue;
    byKey.set(ticket.key, ticket);
  }
  return [...byKey.values()];
}

export function resolveSponsorContract(event, stackspotsContract) {
  const values = eventPrint(event);
  const eventName = event?.event ?? values.event;
  const ownContract =
    event?.contractId && event.contractId !== stackspotsContract ? event.contractId : null;

  switch (eventName) {
    case "platform sponsor contract added":
      return firstContractId(values["contract-address"], ownContract);
    case "sponsor-platform":
      return firstContractId(values["sponsor-contract"], ownContract);
    case "sponsor-event":
      return firstContractId(ownContract, values["sponsor-contract"]);
    default:
      return firstContractId(values["sponsor-contract"], values["contract-address"], ownContract);
  }
}

export function sponsorIndexKeys(event, stackspotsContract) {
  const keys = new Set();
  const contract = resolveSponsorContract(event, stackspotsContract);
  if (contract) keys.add(contract);
  const values = eventPrint(event);
  if (isSponsorContractId(values["sponsor-contract"])) keys.add(String(values["sponsor-contract"]));
  if (isSponsorContractId(values["contract-address"])) keys.add(String(values["contract-address"]));
  if (isSponsorContractId(values.sponsor)) keys.add(String(values.sponsor));
  if (typeof values.sponsor === "string" && values.sponsor && !values.sponsor.includes(".")) {
    keys.add(values.sponsor);
  }
  if (Array.isArray(values.sponsors)) {
    for (const row of values.sponsors) {
      const id = sponsorContractFromTicket(row);
      if (id) keys.add(id);
    }
  }
  return [...keys];
}

function emptySponsor(sponsorContract) {
  return {
    sponsorContract,
    sponsor: null,
    amount: null,
    cycles: null,
    logoUrl: null,
    description: null,
    ruleList: [],
    burnBlockHeight: null,
    allowed: false,
    tickets: [],
    lastEvent: null,
    lastTxId: null,
    lastBlockHeight: null,
    sortScore: 0,
    values: {},
  };
}

function sponsorRecency(row) {
  return Number(row?.sortScore ?? row?.lastBlockHeight ?? row?.blockHeight ?? row?.burnBlockHeight ?? 0);
}

export function applyEventToSponsor(existing, event, stackspotsContract) {
  const print = eventPrint(event);
  const eventName = event?.event ?? print.event;
  if (!isSponsorEvent(eventName)) return existing ?? null;

  const sponsorContract = resolveSponsorContract(event, stackspotsContract);
  if (!sponsorContract) return existing ?? null;

  const values = print;
  const base =
    existing && existing.sponsorContract === sponsorContract ? existing : emptySponsor(sponsorContract);
  const incomingRecency = sponsorRecency(event);
  const incomingIsNewer = incomingRecency >= sponsorRecency(base);
  const ticket = eventName === "sponsor-event" ? ticketEntry(values) : null;
  const sortScore = Math.max(sponsorRecency(base), incomingRecency);

  return {
    ...base,
    sponsorContract,
    sponsor: pickText(values.sponsor, base.sponsor),
    amount: incomingIsNewer ? pickText(values.amount, base.amount) : pickText(base.amount, values.amount),
    cycles: incomingIsNewer ? pickText(values.cycles, base.cycles) : pickText(base.cycles, values.cycles),
    logoUrl: incomingIsNewer
      ? pickText(values["logo-url"], values.logoUrl, base.logoUrl)
      : pickText(base.logoUrl, values["logo-url"], values.logoUrl),
    description: incomingIsNewer
      ? pickText(values.description, base.description)
      : pickText(base.description, values.description),
    ruleList:
      incomingIsNewer && Array.isArray(values["rule-list"])
        ? asRuleList(values["rule-list"])
        : base.ruleList?.length
          ? base.ruleList
          : asRuleList(values["rule-list"]),
    burnBlockHeight: incomingIsNewer
      ? pickText(values["burn-block-height"], base.burnBlockHeight)
      : pickText(base.burnBlockHeight, values["burn-block-height"]),
    allowed: eventName === "platform sponsor contract added" ? true : Boolean(base.allowed),
    platform: eventName === "sponsor-platform" ? true : Boolean(base.platform),
    platformTxId:
      eventName === "sponsor-platform" && incomingIsNewer
        ? (eventTxId(event) ?? base.platformTxId)
        : base.platformTxId ?? null,
    platformBlockHeight:
      eventName === "sponsor-platform" && incomingIsNewer
        ? (event.blockHeight ?? event.burnBlockHeight ?? base.platformBlockHeight)
        : base.platformBlockHeight ?? null,
    tickets: mergeTickets(base.tickets, ticket ? [ticket] : []),
    lastEvent: incomingIsNewer ? eventName : base.lastEvent,
    lastTxId: incomingIsNewer ? (eventTxId(event) ?? base.lastTxId) : base.lastTxId,
    lastBlockHeight: incomingIsNewer
      ? (event.blockHeight ?? event.burnBlockHeight ?? base.lastBlockHeight)
      : base.lastBlockHeight,
    sortScore,
    values: incomingIsNewer ? { ...(base.values ?? {}), ...values } : { ...values, ...(base.values ?? {}) },
  };
}

export function mergeSponsorRecord(existing, incoming) {
  if (!incoming) return existing ?? null;
  if (!existing) return incoming;
  const incomingIsNewer = sponsorRecency(incoming) >= sponsorRecency(existing);
  return {
    ...existing,
    ...incoming,
    sponsor: pickText(incoming.sponsor, existing.sponsor),
    amount: incomingIsNewer ? pickText(incoming.amount, existing.amount) : pickText(existing.amount, incoming.amount),
    cycles: incomingIsNewer ? pickText(incoming.cycles, existing.cycles) : pickText(existing.cycles, incoming.cycles),
    logoUrl: incomingIsNewer
      ? pickText(incoming.logoUrl, existing.logoUrl)
      : pickText(existing.logoUrl, incoming.logoUrl),
    description: incomingIsNewer
      ? pickText(incoming.description, existing.description)
      : pickText(existing.description, incoming.description),
    ruleList:
      incomingIsNewer && incoming.ruleList?.length
        ? incoming.ruleList
        : existing.ruleList?.length
          ? existing.ruleList
          : incoming.ruleList ?? [],
    burnBlockHeight: incomingIsNewer
      ? pickText(incoming.burnBlockHeight, existing.burnBlockHeight)
      : pickText(existing.burnBlockHeight, incoming.burnBlockHeight),
    allowed: Boolean(existing.allowed || incoming.allowed),
    platform: Boolean(existing.platform || incoming.platform),
    platformTxId: incoming.platform && incomingIsNewer
      ? (incoming.platformTxId ?? existing.platformTxId)
      : (existing.platformTxId ?? incoming.platformTxId),
    platformBlockHeight: incoming.platform && incomingIsNewer
      ? (incoming.platformBlockHeight ?? existing.platformBlockHeight)
      : (existing.platformBlockHeight ?? incoming.platformBlockHeight),
    tickets: mergeTickets(existing.tickets, incoming.tickets),
    lastEvent: incomingIsNewer ? incoming.lastEvent : existing.lastEvent,
    lastTxId: incomingIsNewer ? incoming.lastTxId : existing.lastTxId,
    lastBlockHeight: incomingIsNewer ? incoming.lastBlockHeight : existing.lastBlockHeight,
    sortScore: Math.max(sponsorRecency(existing), sponsorRecency(incoming)),
    values: incomingIsNewer
      ? { ...(existing.values ?? {}), ...(incoming.values ?? {}) }
      : { ...(incoming.values ?? {}), ...(existing.values ?? {}) },
  };
}

/** Contract name is the segment after the last dot of ADDRESS.NAME. */
export function projectNameFromContract(contractId) {
  const text = String(contractId ?? "").trim();
  const dot = text.lastIndexOf(".");
  if (dot <= 0 || dot === text.length - 1) return null;
  return text.slice(dot + 1);
}

export function platformPrintSponsorContract(row) {
  if (!row || typeof row !== "object") return null;
  return firstContractId(
    row["sponsor-contract"],
    row.sponsorContract,
    row["contract-address"],
  );
}

function isHubPrintSource(row, hubContract) {
  const hub = String(hubContract ?? "").trim().toLowerCase();
  if (!hub) return true;
  const src = String(row?.sourceContract ?? row?.contractId ?? "").trim().toLowerCase();
  if (!src) return true;
  return src === hub;
}

/**
 * `sponsor-platform` prints, preferring `.stackspots` as the log source.
 * Lookup filters `sponsor-contract` to the target ADDRESS.NAME.
 * Input should already be newest-first.
 */
export function selectSponsorPlatformPrints(
  events,
  { hubContract = "", sponsorContract = "" } = {},
) {
  let rows = (Array.isArray(events) ? events : []).filter(
    (row) => String(row?.event ?? "").trim().toLowerCase() === "sponsor-platform",
  );
  const hubRows = rows.filter((row) => isHubPrintSource(row, hubContract));
  if (hubRows.length) rows = hubRows;
  const want = String(sponsorContract ?? "").trim().toLowerCase();
  if (want) {
    rows = rows.filter(
      (row) => String(platformPrintSponsorContract(row) ?? "").trim().toLowerCase() === want,
    );
  }
  return rows;
}

/** One hub print per `sponsor-contract` (newest first). */
export function uniqueSponsorPlatformByContract(events, hubContract = "") {
  const selected = selectSponsorPlatformPrints(events, { hubContract });
  const byContract = new Map();
  for (const row of selected) {
    const id = platformPrintSponsorContract(row);
    if (!id) continue;
    const key = id.toLowerCase();
    if (!byContract.has(key)) byContract.set(key, row);
  }
  return [...byContract.values()];
}

/** Add `project-name` from `sponsor-contract` (or `contract-address`). Not stored in Redis. */
export function withProjectName(sponsor) {
  if (!sponsor || typeof sponsor !== "object") return sponsor;
  const contract = sponsor["sponsor-contract"] ?? sponsor["contract-address"] ?? sponsor.sponsorContract;
  const projectName = projectNameFromContract(contract);
  if (!projectName) return sponsor;
  return { ...sponsor, "project-name": projectName };
}

/** True when this row was funded by a `sponsor-platform` print, not just registered or ticketed. */
export function hasSponsorPlatformLock(sponsor) {
  if (!sponsor?.sponsorContract) return false;
  if (sponsor.platform === true) return true;
  if (sponsor.lastEvent === "sponsor-platform") return true;
  return sponsor.amount != null || sponsor.cycles != null;
}

/** Sponsor-page payload: only `sponsor-platform` fields. */
export function toSponsorPageRecord(sponsor) {
  if (!hasSponsorPlatformLock(sponsor)) return null;
  return {
    sponsorContract: sponsor.sponsorContract,
    sponsor: sponsor.sponsor ?? null,
    amount: sponsor.amount ?? null,
    cycles: sponsor.cycles ?? null,
    ruleList: sponsor.ruleList ?? [],
    burnBlockHeight: sponsor.burnBlockHeight ?? null,
    lastEvent: "sponsor-platform",
    lastTxId: sponsor.platformTxId ?? (sponsor.lastEvent === "sponsor-platform" ? sponsor.lastTxId : null),
    lastBlockHeight:
      sponsor.platformBlockHeight ??
      (sponsor.lastEvent === "sponsor-platform" ? sponsor.lastBlockHeight : null),
    sortScore: sponsor.sortScore ?? 0,
  };
}

export function normalizeListedSponsor(sponsor) {
  if (!sponsor || typeof sponsor !== "object" || !sponsor.sponsorContract) return null;
  const tickets = Array.isArray(sponsor.tickets) ? sponsor.tickets : [];
  return {
    ...sponsor,
    tickets,
    sponsoredPotCount: tickets.length,
    allowed: Boolean(sponsor.allowed),
  };
}

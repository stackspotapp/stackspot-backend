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
      const id = row?.["sponsor-contract"] ?? row?.sponsorContract;
      if (isSponsorContractId(id)) keys.add(String(id));
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

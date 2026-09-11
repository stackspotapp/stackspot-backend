import { isPotContractId } from "./pots.js";

export const SPONSOR_EVENTS = new Set([
  "platform sponsor contract added",
  "sponsor-platform",
  "sponsor event",
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
  const values = event?.values && typeof event.values === "object" ? event.values : {};
  const eventName = event?.event;
  const ownContract =
    event?.contractId && event.contractId !== stackspotsContract ? event.contractId : null;

  switch (eventName) {
    case "platform sponsor contract added":
      return firstContractId(values["contract-address"], ownContract);
    case "sponsor-platform":
      return firstContractId(values["sponsor-contract"], ownContract);
    case "sponsor event":
      return firstContractId(ownContract, values["sponsor-contract"]);
    default:
      return firstContractId(values["sponsor-contract"], values["contract-address"], ownContract);
  }
}

export function sponsorIndexKeys(event, stackspotsContract) {
  const keys = new Set();
  const contract = resolveSponsorContract(event, stackspotsContract);
  if (contract) keys.add(contract);
  const values = event?.values && typeof event.values === "object" ? event.values : {};
  if (isSponsorContractId(values["sponsor-contract"])) keys.add(String(values["sponsor-contract"]));
  if (isSponsorContractId(values["contract-address"])) keys.add(String(values["contract-address"]));
  if (isSponsorContractId(values.sponsor)) keys.add(String(values.sponsor));
  if (typeof values.sponsor === "string" && values.sponsor && !values.sponsor.includes(".")) {
    keys.add(values.sponsor);
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
    values: {},
  };
}

export function applyEventToSponsor(existing, event, stackspotsContract) {
  const eventName = event?.event;
  if (!isSponsorEvent(eventName)) return existing ?? null;

  const sponsorContract = resolveSponsorContract(event, stackspotsContract);
  if (!sponsorContract) return existing ?? null;

  const values = event.values && typeof event.values === "object" ? event.values : {};
  const base =
    existing && existing.sponsorContract === sponsorContract ? existing : emptySponsor(sponsorContract);
  const incomingIsNewer =
    Number(event.blockHeight ?? 0) >= Number(base.lastBlockHeight ?? 0);
  const ticket = eventName === "sponsor event" ? ticketEntry(values) : null;

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
    tickets: mergeTickets(base.tickets, ticket ? [ticket] : []),
    lastEvent: incomingIsNewer ? eventName : base.lastEvent,
    lastTxId: incomingIsNewer ? (event.txId ?? base.lastTxId) : base.lastTxId,
    lastBlockHeight: incomingIsNewer
      ? (event.blockHeight ?? base.lastBlockHeight)
      : base.lastBlockHeight,
    values: incomingIsNewer ? { ...(base.values ?? {}), ...values } : { ...values, ...(base.values ?? {}) },
  };
}

export function mergeSponsorRecord(existing, incoming) {
  if (!incoming) return existing ?? null;
  if (!existing) return incoming;
  const incomingIsNewer =
    Number(incoming.lastBlockHeight ?? 0) >= Number(existing.lastBlockHeight ?? 0);
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
    tickets: mergeTickets(existing.tickets, incoming.tickets),
    lastEvent: incomingIsNewer ? incoming.lastEvent : existing.lastEvent,
    lastTxId: incomingIsNewer ? incoming.lastTxId : existing.lastTxId,
    lastBlockHeight: incomingIsNewer ? incoming.lastBlockHeight : existing.lastBlockHeight,
    values: incomingIsNewer
      ? { ...(existing.values ?? {}), ...(incoming.values ?? {}) }
      : { ...(incoming.values ?? {}), ...(existing.values ?? {}) },
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

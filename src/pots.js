import { eventPrint, eventTxId } from "./catalog.js";

export const POT_STATUSES = ["deployed", "joinable", "started", "cancelled", "claimed"];

export const PLATFORM_EVENTS = new Set([
  "admin added/updated",
  "public pot deploy status updated",
  "pot contract hash set",
  "platform sponsor contract added",
  "sponsor-platform",
]);

/** Event key → current pot status. Rank never moves backwards. */
export const EVENT_STATUS = {
  "pre-init": "deployed",
  "init-pot": "joinable",
  "pot-registered": "joinable",
  "pot mint": "joinable",
  "join-pot": "joinable",
  "join-pot-as-sponsor": "joinable",
  "start-stackspot-jackpot": "started",
  "start-stackspot-crowdfund": "started",
  "start-stackspot-sequential-pot": "started",
  "stake-treasury": "started",
  "extend-stake": "started",
  "revoke-stake": "started",
  "pull-staking-rewards-cycle": "started",
  "cancel-pot": "cancelled",
  "fall-back-cancel": "cancelled",
  "claim-pot-reward": "claimed",
};

const STATUS_RANK = {
  deployed: 1,
  joinable: 2,
  started: 3,
  cancelled: 4,
  claimed: 4,
};

const START_TYPE = {
  "start-stackspot-jackpot": "jackpot",
  "start-stackspot-crowdfund": "crowd-fund",
  "start-stackspot-sequential-pot": "sequential",
};

export function isPotEvent(eventName) {
  return Boolean(eventName) && Object.prototype.hasOwnProperty.call(EVENT_STATUS, eventName);
}

export function isPotContractId(value) {
  return (
    typeof value === "string" &&
    /^[S][A-Z0-9]{24,40}\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(value)
  );
}

/** Platform helpers that print or deploy beside pots but are not pot contracts. */
const NON_POT_CONTRACT_NAMES = new Set([
  "stackspots",
  "stackspot-vrf",
  "stackspot-sponsor",
  "stackspot-sponsor-trait",
  "stackspot-pots-trait",
  "nft-trait",
  "init-admin",
  "sbtc-token",
  "sbtc-registry",
]);

export function isLikelyPotContract(value) {
  if (!isPotContractId(value)) return false;
  const name = String(value).split(".")[1]?.toLowerCase() ?? "";
  if (NON_POT_CONTRACT_NAMES.has(name)) return false;
  if (name.includes("trait")) return false;
  return true;
}

function firstContractId(...candidates) {
  for (const value of candidates) {
    if (isPotContractId(value)) return value;
  }
  return null;
}

export function potAddressFromValues(eventName, values) {
  if (!values || typeof values !== "object") return null;
  switch (eventName) {
    case "pre-init":
      return firstContractId(values["pot-contract"], values["pot-treasury"]);
    case "init-pot":
      return firstContractId(values.contract, values["pot-treasury"], values["pot-contract"]);
    case "pot-registered":
    case "claim-pot-reward":
      return firstContractId(values["pot-address"], values["pot-contract"], values["pot-treasury"]);
    case "pot mint":
      return firstContractId(values.recipient, values["pot-contract"]);
    case "start-stackspot-jackpot":
    case "start-stackspot-crowdfund":
    case "start-stackspot-sequential-pot":
      return firstContractId(values["pot-contract"], values["pot-treasury"]);
    default:
      return firstContractId(
        values["pot-address"],
        values["pot-contract"],
        values.contract,
        values["pot-treasury"],
        values.recipient,
      );
  }
}

export function resolvePotAddress(event, stackspotsContract) {
  const print = eventPrint(event);
  const fromValues = potAddressFromValues(event?.event ?? print.event, print);
  if (fromValues) return fromValues;
  const contractId = event?.contractId;
  if (contractId && contractId !== stackspotsContract && isPotContractId(contractId)) {
    return contractId;
  }
  return null;
}

export function statusFlags(status) {
  return {
    deployed: status === "deployed",
    joinable: status === "joinable",
    started: status === "started",
    cancelled: status === "cancelled",
    claimed: status === "claimed",
  };
}

/** Print `event` key currently stored on a pot row (`lastEvent` or values.event). */
export function potEventKey(pot) {
  const fromLast = String(pot?.lastEvent ?? "").trim();
  if (fromLast) return fromLast;
  const fromValues = pot?.values && typeof pot.values === "object" ? pot.values.event : null;
  return String(fromValues ?? "").trim();
}

/** Public /pots list: initialized pots only (`init-pot`). */
export function isInitPotRow(pot) {
  return potEventKey(pot) === "init-pot";
}

/** Owner listing: a stored `pre-init` print from the core contract, not a bare deploy. */
export function isPreInitPotRow(pot) {
  return potEventKey(pot) === "pre-init";
}

function pickText(...candidates) {
  for (const value of candidates) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function pickStatus(existingStatus, incomingStatus, existingHeight, incomingHeight) {
  const existingRank = STATUS_RANK[existingStatus] ?? 0;
  const incomingRank = STATUS_RANK[incomingStatus] ?? 0;
  if (incomingRank > existingRank) return incomingStatus;
  if (incomingRank < existingRank) return existingStatus ?? incomingStatus;
  if (Number(incomingHeight ?? 0) >= Number(existingHeight ?? 0)) return incomingStatus;
  return existingStatus ?? incomingStatus;
}

function identityFromEvent(event) {
  const values = eventPrint(event);
  const eventName = event.event ?? values.event;
  return {
    potId: pickText(values["pot-id"], values["token-id"]),
    potName: pickText(values["pot-name"], values["contract-name"], values.name),
    potType: pickText(values["pot-type"], values.type, START_TYPE[eventName]),
    potOwner: pickText(values["pot-owner"], values.owner),
    potAdmin: pickText(values["pot-admin"]),
    potTreasury: pickText(values["pot-treasury"], values.contract, values["pot-contract"]),
  };
}

function emptyPot(potAddress) {
  return {
    potAddress,
    potId: null,
    potName: null,
    potType: null,
    potOwner: null,
    potAdmin: null,
    potTreasury: null,
    status: "deployed",
    ...statusFlags("deployed"),
    values: {},
    lastEvent: null,
    lastTxId: null,
    lastBlockHeight: null,
    sortScore: 0,
  };
}

function eventRecency(event) {
  const print = eventPrint(event);
  return Number(
    event?.blockHeight ??
      event?.burnBlockHeight ??
      print["stacks-block-height"] ??
      print["burn-block-height"] ??
      event?.sortScore ??
      0,
  );
}

function potRecency(pot) {
  return Number(pot?.sortScore ?? pot?.lastBlockHeight ?? 0);
}

export function applyEventToPot(existing, event, stackspotsContract) {
  const print = eventPrint(event);
  const eventName = event?.event ?? print.event;
  if (!isPotEvent(eventName) || PLATFORM_EVENTS.has(eventName)) return existing ?? null;

  const potAddress = resolvePotAddress(event, stackspotsContract);
  if (!potAddress) return existing ?? null;

  const values = { ...print };
  if (values["min-amount"] != null && values["pot-min-amount"] == null) {
    values["pot-min-amount"] = values["min-amount"];
  }
  if (values["max-participants"] != null && values["pot-max-participants"] == null) {
    values["pot-max-participants"] = values["max-participants"];
  }
  if (values.cycles != null && values["pot-cycles"] == null) {
    values["pot-cycles"] = values.cycles;
  }
  if (values.type != null && values["pot-type"] == null) {
    values["pot-type"] = values.type;
  }
  const incomingStatus = EVENT_STATUS[eventName];
  const base = existing && existing.potAddress === potAddress ? existing : emptyPot(potAddress);
  const identity = identityFromEvent(event);
  const incomingRecency = eventRecency(event);
  const status = pickStatus(
    base.status,
    incomingStatus,
    potRecency(base),
    incomingRecency,
  );
  const incomingIsNewer = incomingRecency >= potRecency(base);
  const sortScore = Math.max(potRecency(base), incomingRecency);

  return {
    ...base,
    potAddress,
    potId: pickText(identity.potId, base.potId),
    potName: pickText(identity.potName, base.potName),
    potType: pickText(identity.potType, base.potType),
    potOwner: pickText(identity.potOwner, base.potOwner),
    potAdmin: pickText(identity.potAdmin, base.potAdmin),
    potTreasury: pickText(identity.potTreasury, base.potTreasury),
    status,
    ...statusFlags(status),
    values: { ...(base.values ?? {}), ...values },
    lastEvent: incomingIsNewer ? eventName : base.lastEvent,
    lastTxId: incomingIsNewer ? (eventTxId(event) ?? base.lastTxId) : base.lastTxId,
    lastBlockHeight: incomingIsNewer
      ? (event.blockHeight ?? event.burnBlockHeight ?? base.lastBlockHeight)
      : base.lastBlockHeight,
    sortScore,
  };
}

export function potRecordFromEvent(event, stackspotsContract) {
  return applyEventToPot(null, event, stackspotsContract);
}

export function mergePotRecord(existing, incoming) {
  if (!incoming) return existing ?? null;
  if (!existing) return incoming;
  const status = pickStatus(
    existing.status,
    incoming.status,
    potRecency(existing),
    potRecency(incoming),
  );
  const incomingIsNewer = potRecency(incoming) >= potRecency(existing);
  return {
    ...existing,
    ...incoming,
    potId: pickText(incoming.potId, existing.potId),
    potName: pickText(incoming.potName, existing.potName),
    potType: pickText(incoming.potType, existing.potType),
    potOwner: pickText(incoming.potOwner, existing.potOwner),
    potAdmin: pickText(incoming.potAdmin, existing.potAdmin),
    potTreasury: pickText(incoming.potTreasury, existing.potTreasury),
    status,
    ...statusFlags(status),
    values: { ...(existing.values ?? {}), ...(incoming.values ?? {}) },
    lastEvent: incomingIsNewer ? incoming.lastEvent : existing.lastEvent,
    lastTxId: incomingIsNewer ? incoming.lastTxId : existing.lastTxId,
    lastBlockHeight: incomingIsNewer
      ? incoming.lastBlockHeight
      : existing.lastBlockHeight,
    sortScore: Math.max(potRecency(existing), potRecency(incoming)),
  };
}

export function normalizeListedPot(pot) {
  if (!pot || typeof pot !== "object" || !pot.potAddress) return null;
  if (POT_STATUSES.includes(pot.status)) {
    return { ...pot, ...statusFlags(pot.status) };
  }
  const inferred = EVENT_STATUS[pot.lastEvent];
  if (!inferred) return null;
  return { ...pot, status: inferred, ...statusFlags(inferred) };
}

export function activityDedupeKey(event) {
  const values = eventPrint(event);
  const actor = values.participant ?? values.sponsor ?? values["claimer-address"] ?? "";
  return `${eventTxId(event) ?? ""}:${event?.event ?? values.event ?? ""}:${actor}`;
}

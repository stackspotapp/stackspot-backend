export const POT_STATUSES = ["deployed", "joinable", "started", "cancelled", "claimed"];

export const PLATFORM_EVENTS = new Set([
  "admin added/updated",
  "public pot deploy status updated",
  "pot contract hash set",
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
  const fromValues = potAddressFromValues(event?.event, event?.values);
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
  const values = event.values && typeof event.values === "object" ? event.values : {};
  const eventName = event.event;
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
  };
}

export function applyEventToPot(existing, event, stackspotsContract) {
  const eventName = event?.event;
  if (!isPotEvent(eventName) || PLATFORM_EVENTS.has(eventName)) return existing ?? null;

  const potAddress = resolvePotAddress(event, stackspotsContract);
  if (!potAddress) return existing ?? null;

  const values = event.values && typeof event.values === "object" ? event.values : {};
  const incomingStatus = EVENT_STATUS[eventName];
  const base = existing && existing.potAddress === potAddress ? existing : emptyPot(potAddress);
  const identity = identityFromEvent(event);
  const status = pickStatus(
    base.status,
    incomingStatus,
    base.lastBlockHeight,
    event.blockHeight,
  );
  const incomingIsNewer =
    Number(event.blockHeight ?? 0) >= Number(base.lastBlockHeight ?? 0);

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
    lastTxId: incomingIsNewer ? (event.txId ?? base.lastTxId) : base.lastTxId,
    lastBlockHeight: incomingIsNewer ? (event.blockHeight ?? base.lastBlockHeight) : base.lastBlockHeight,
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
    existing.lastBlockHeight,
    incoming.lastBlockHeight,
  );
  const incomingIsNewer =
    Number(incoming.lastBlockHeight ?? 0) >= Number(existing.lastBlockHeight ?? 0);
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
  const values = event?.values && typeof event.values === "object" ? event.values : {};
  const actor = values.participant ?? values.sponsor ?? values["claimer-address"] ?? "";
  return `${event?.txId ?? ""}:${event?.event ?? ""}:${actor}`;
}

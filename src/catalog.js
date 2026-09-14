import { createHash } from "node:crypto";
import { expandEncodedValues } from "./decoder.js";

/**
 * Print events from stackspots.clar and the pot templates.
 * Status is derived from the event key (see EVENT_STATUS in pots.js).
 */
export const STACKSPOTS_EVENTS = {
  "admin added/updated": {
    source: "stackspots",
    kind: "platform",
    fields: ["event", "admin", "enable"],
  },
  "public pot deploy status updated": {
    source: "stackspots",
    kind: "platform",
    fields: ["event", "enable", "admin"],
  },
  "pot contract hash set": {
    source: "stackspots",
    kind: "platform",
    fields: ["event", "hash", "state"],
  },
  "pre-init": {
    source: "pot",
    kind: "pot",
    potStatus: "deployed",
    fields: [
      "event",
      "pot-cycle",
      "pot-min-amount",
      "pot-max-participants",
      "pot-name",
      "pot-type",
      "pot-is-init",
      "pot-admin",
      "pot-contract",
      "pot-owner",
      "pot-treasury",
      "funding-address",
    ],
  },
  "init-pot": {
    source: "pot",
    kind: "pot",
    potStatus: "joinable",
    fields: [
      "event",
      "owner",
      "pot-admin",
      "pot-treasury",
      "contract",
      "cycles",
      "type",
      "pot-reward-token",
      "min-amount",
      "max-participants",
      "pot-is-init",
      "sponsors",
    ],
  },
  "pot-registered": {
    source: "stackspots",
    kind: "pot",
    potStatus: "joinable",
    fields: [
      "event",
      "pot-id",
      "pot-address",
      "pot-owner",
      "pot-deploy-fee",
      "pot-name",
      "pot-type",
      "pot-cycles",
      "pot-reward-token",
      "pot-min-amount",
      "pot-max-participants",
      "origin-contract-sha-hash",
      "stacks-block-height",
      "burn-block-height",
    ],
  },
  "pot mint": {
    source: "stackspots",
    kind: "pot",
    potStatus: "joinable",
    fields: [
      "event",
      "contract-name",
      "recipient",
      "token-id",
      "tx-sender",
      "contract-caller",
      "platform-contracts-fee",
    ],
  },
  "join-pot": {
    source: "pot",
    kind: "pot",
    potStatus: "joinable",
    fields: ["event", "participant", "amount", "index"],
  },
  "join-pot-as-sponsor": {
    source: "pot",
    kind: "pot",
    potStatus: "joinable",
    fields: ["event", "sponsor", "amount", "sponsors-count"],
  },
  "start-stackspot-jackpot": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: [
      "event",
      "pot-starter-principal",
      "pot-contract",
      "pot-treasury",
      "pot-participants",
      "pot-value",
      "pot-locked",
      "pot-lock-burn-height",
      "pot-cancelled",
    ],
  },
  "start-stackspot-crowdfund": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: [
      "event",
      "pot-starter-principal",
      "pot-contract",
      "pot-treasury",
      "pot-participants",
      "pot-value",
      "pot-locked",
      "pot-lock-burn-height",
      "pot-cancelled",
    ],
  },
  "start-stackspot-sequential-pot": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: [
      "event",
      "pot-starter-principal",
      "pot-contract",
      "pot-treasury",
      "pot-participants",
      "pot-value",
      "pot-locked",
      "pot-lock-burn-height",
      "pot-cancelled",
    ],
  },
  "stake-treasury": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: ["event", "amount-ustx", "cycles", "first-reward-cycle", "unlock-cycle"],
  },
  "extend-stake": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: ["event", "staked-cycles", "next-reward-cycle"],
  },
  "revoke-stake": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: ["event"],
  },
  "pull-staking-rewards-cycle": {
    source: "pot",
    kind: "pot",
    potStatus: "started",
    fields: ["event", "reward-cycle", "earned", "paid", "withdrawal-request"],
  },
  "cancel-pot": {
    source: "pot",
    kind: "pot",
    potStatus: "cancelled",
    fields: ["event", "pot-cancelled", "pot-value", "pot-participants-count"],
  },
  "fall-back-cancel": {
    source: "pot",
    kind: "pot",
    potStatus: "cancelled",
    fields: [
      "event",
      "pot-cancelled",
      "pot-session-ended",
      "principals-returned",
      "pot-locked",
      "pot-value",
      "pot-participants-count",
      "defined-unlock-burn-height",
    ],
  },
  "claim-pot-reward": {
    source: "pot",
    kind: "pot",
    potStatus: "claimed",
    fields: [
      "event",
      "pot-participants-count",
      "pot-value",
      "pot-yield-amount",
      "winners-values",
      "starter-address",
      "starter-reward-amount",
      "claimer-address",
      "claimer-reward-amount",
      "pot-id",
      "pot-address",
      "pot-owner",
      "pot-name",
      "pot-type",
      "pot-cycle",
      "pot-reward-token",
      "pot-min-amount",
      "pot-max-participants",
      "origin-contract-sha-hash",
      "stacks-block-height",
      "burn-block-height",
      "lock-burn-height",
      "pot-cancelled",
    ],
  },
  "platform sponsor contract added": {
    source: "stackspots",
    kind: "sponsor",
    fields: ["event", "contract-address", "hash"],
  },
  "sponsor-platform": {
    source: "sponsor",
    kind: "sponsor",
    fields: [
      "event",
      "amount",
      "cycles",
      "rule-list",
      "sponsor",
      "sponsor-contract",
      "burn-block-height",
    ],
  },
  "sponsor-event": {
    source: "sponsor",
    kind: "sponsor",
    fields: ["event", "ticket-id", "pot-contract", "pot-details"],
  },
};

export function isStackspotsLogType(eventName) {
  return Boolean(eventName) && Object.prototype.hasOwnProperty.call(STACKSPOTS_EVENTS, eventName);
}

/** Keep only the catalog fields decoded from the print buffer. */
export function pickLoggedValues(eventName, values) {
  const spec = STACKSPOTS_EVENTS[eventName];
  if (!spec) return null;
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const picked = { event: eventName };
  for (const field of spec.fields) {
    if (field === "event") continue;
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/** Print fields, whether the row is still nested (`values`) or already the stored shape. */
export function eventPrint(event) {
  if (!event || typeof event !== "object") return {};
  const nested = event.values;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested) ? nested : event;
  if (!source || typeof source !== "object") return {};
  const { txid, txId, ...fields } = source;
  return fields;
}

export function eventTxId(event) {
  if (!event || typeof event !== "object") return null;
  return event.txId ?? event.txid ?? null;
}

/** Cached and returned event: every field decoded from the print, plus txid. No hex or log metadata. */
const PUBLIC_EVENT_META = new Set([
  "id",
  "txId",
  "txid",
  "eventIndex",
  "contractId",
  "blockHeight",
  "burnBlockHeight",
  "hex",
  "repr",
  "clarity",
  "values",
  "eventType",
  "topic",
  "sortScore",
  "decodeError",
  "sourceContract",
]);

export function toPublicEvent(event) {
  if (!event) return null;
  const source = expandEncodedValues(eventPrint(event));
  const name = String(source.event ?? event.event ?? "").trim();
  if (!isStackspotsLogType(name)) return null;
  const txid = eventTxId(event);
  if (!txid) return null;
  const fields = { event: name };
  for (const [key, value] of Object.entries(source)) {
    if (PUBLIC_EVENT_META.has(key) || value === undefined) continue;
    fields[key] = value;
  }
  return { ...fields, txid };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One Redis row for the same print. The sponsor contract and stackspots both
 * emit the same payload in one tx, so event index is not a unique key.
 */
export function eventDedupeId(payload) {
  const txid = payload?.txid;
  const name = payload?.event;
  if (!txid || !name) return null;
  const { txid: _txid, ...fields } = payload;
  const hash = createHash("sha256").update(stableStringify(fields)).digest("hex").slice(0, 16);
  return `${txid}:${name}:${hash}`;
}

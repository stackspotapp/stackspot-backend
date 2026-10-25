import { eventPrint, eventTxId } from "./catalog.js";
import { getEventsByIds, listEventIds } from "./cache.js";
import { PRE_INIT_LOGS_CONTRACT_NAME, platformSiblingContract } from "./config.js";
import { isLikelyPotContract, resolvePotAddress } from "./pots.js";

/** Profile categories come from these logger prints only. */
export const USER_PROFILE_EVENT_NAMES = [
  "pre-init",
  "join-pot",
  "join-pot-as-sponsor",
  "claim-pot-reward",
];

export function principalOf(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return principalOf(
      value.value ??
        value.participant ??
        value.sponsor ??
        value.address ??
        value["winner-address"] ??
        value.sender,
    );
  }
  return String(value).trim();
}

export function sameUserAddress(left, right) {
  const a = principalOf(left).split(".")[0].toLowerCase();
  const b = principalOf(right).split(".")[0].toLowerCase();
  return Boolean(a && b && a === b);
}

function asUstx(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function unwrapTuple(value) {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  if ("value" in value && value.value != null && typeof value.value === "object") {
    return unwrapTuple(value.value);
  }
  return value;
}

function sourceContractOf(event) {
  return String(event?.sourceContract ?? event?.contractId ?? "").trim();
}

function contractNameOf(contractId) {
  return String(contractId ?? "").split(".")[1]?.toLowerCase() ?? "";
}

function fromLogger(event, loggerId) {
  const want = String(loggerId ?? "").trim().toLowerCase();
  const source = sourceContractOf(event).toLowerCase();
  if (!want) return true;
  if (!source) return true;
  if (source === want) return true;
  const wantName = contractNameOf(want);
  const sourceName = contractNameOf(source);
  return Boolean(wantName && sourceName && wantName === sourceName);
}

function resolveProfileOpts(stackspotsContractOrOpts) {
  if (stackspotsContractOrOpts && typeof stackspotsContractOrOpts === "object") {
    return stackspotsContractOrOpts;
  }
  return { stackspotsContract: stackspotsContractOrOpts ?? null };
}

function resolvePreInitLogsContract({ preInitLogsContract, stackspotsContract } = {}) {
  const explicit = String(preInitLogsContract ?? "").trim();
  if (explicit) return explicit;
  return platformSiblingContract(stackspotsContract, PRE_INIT_LOGS_CONTRACT_NAME);
}

/** Clarity `winners-values` is `{winner-id, winner-address}`; some logs use `participant`. */
function winnerAddressFromEvent(print) {
  const winners = unwrapTuple(print["winners-values"] ?? print["winner-values"]);
  if (winners) {
    return (
      winners.participant ??
      winners["winner-address"] ??
      winners.address ??
      winners.winner ??
      null
    );
  }
  return print.participant ?? print["winner-address"] ?? print.address ?? null;
}

function winnerRewardFromEvent(print) {
  const winners = unwrapTuple(print["winners-values"] ?? print["winner-values"]);
  if (winners) {
    return winners["winner-reward"] ?? winners.reward ?? print["pot-yield-amount"] ?? "0";
  }
  return print["winner-reward"] ?? print["pot-yield-amount"] ?? "0";
}

export function userPotContract(event, stackspotsContract) {
  const print = eventPrint(event);
  const fromResolver = resolvePotAddress(
    {
      ...event,
      event: event.event ?? print.event,
      contractId: event.contractId ?? event.sourceContract,
      values: print,
    },
    stackspotsContract,
  );
  if (fromResolver) return fromResolver;
  const fallback = print["pot-contract"] ?? print["pot-address"] ?? null;
  return isLikelyPotContract(fallback) ? fallback : null;
}

function rowFromEvent(event, extras = {}) {
  const print = eventPrint(event);
  return {
    event: print.event ?? event.event ?? null,
    txid: eventTxId(event),
    contract: extras.contract ?? null,
    potName: extras.potName ?? print["pot-name"] ?? print.name ?? null,
    potType: extras.potType ?? print["pot-type"] ?? print.type ?? null,
    amount: extras.amount ?? print.amount ?? null,
    ...extras,
  };
}

function upsertByContract(map, contract, row) {
  const key = String(contract ?? "").trim().toLowerCase();
  if (!key) return;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, { ...row, contract });
    return;
  }
  const sameTx = prev.txid && row.txid && String(prev.txid) === String(row.txid);
  const nextAmount = sameTx ? asUstx(prev.amount) : asUstx(prev.amount) + asUstx(row.amount);
  map.set(key, {
    ...prev,
    ...row,
    contract: prev.contract || contract,
    amount: nextAmount > 0n ? String(nextAmount) : prev.amount,
    potName: row.potName || prev.potName,
    potType: row.potType || prev.potType,
  });
}

/**
 * Profile stats + unique pots for a Stacks address from cached prints.
 *
 * Pots created: `.stackspot-pre-init-logs` `pre-init` where `sender` is the user.
 * Pots joined: `.stackspots` `join-pot` where `sender` is the user.
 * Sponsored: `.stackspots` `join-pot-as-sponsor` where `sender` is the user.
 * Pots won: `.stackspots` `claim-pot-reward` where `winners-values.participant`
 *   (or `winner-address`) is the user.
 * Total contributed: amounts on matching join-pot + join-pot-as-sponsor prints.
 */
export function computeUserProfile(events = [], address, stackspotsContractOrOpts) {
  const opts = resolveProfileOpts(stackspotsContractOrOpts);
  const stackspotsContract = opts.stackspotsContract ?? null;
  const preInitLogsContract = resolvePreInitLogsContract(opts);
  const want = String(address ?? "").trim();
  const created = new Map();
  const joined = new Map();
  const sponsored = new Map();
  const won = new Map();
  const contribSeen = new Set();
  let contributed = 0n;

  const addContribution = (event, print) => {
    const txid = String(eventTxId(event) ?? "").trim();
    const key = txid || `${print.event}:${print["pot-contract"] ?? ""}:${print.amount ?? ""}`;
    if (contribSeen.has(key)) return;
    contribSeen.add(key);
    contributed += asUstx(print.amount);
  };

  for (const event of events) {
    const print = eventPrint(event);
    const name = String(print.event ?? event.event ?? "").trim();
    const contract = userPotContract(event, stackspotsContract);

    if (name === "pre-init" && fromLogger(event, preInitLogsContract)) {
      const sender = print.sender ?? print["tx-sender"] ?? print["pot-owner"];
      if (sameUserAddress(sender, want) && contract) {
        upsertByContract(created, contract, rowFromEvent(event, {
          contract,
          kind: "pot",
          potName: print["pot-name"] ?? print.name ?? null,
          potType: print["pot-type"] ?? print.type ?? null,
          amount: null,
          sender: principalOf(sender),
          potMinAmount: print["pot-min-amount"] ?? null,
          potMaxParticipants: print["pot-max-participants"] ?? null,
          potCycle: print["pot-cycle"] ?? null,
          potIsInit: print["pot-is-init"] ?? null,
        }));
      }
    }

    if (name === "join-pot" && fromLogger(event, stackspotsContract)) {
      const sender = print.sender ?? print["tx-sender"] ?? print.participant ?? print.joiner;
      if (sameUserAddress(sender, want)) {
        addContribution(event, print);
        const txid = eventTxId(event);
        if (contract) {
          for (const [key, row] of [...joined.entries()]) {
            if (String(key).startsWith("tx:") && String(row.txid) === String(txid)) {
              joined.delete(key);
            }
          }
        } else if ([...joined.values()].some((row) => String(row.txid) === String(txid))) {
          continue;
        }
        const joinKey = contract || `tx:${txid || ""}`;
        if (joinKey && joinKey !== "tx:") {
          upsertByContract(joined, joinKey, rowFromEvent(event, {
            contract: contract || null,
            kind: "pot",
            potName: print["pot-name"] ?? print.name ?? null,
            potType: print["pot-type"] ?? print.type ?? null,
            amount: print.amount ?? "0",
            sender: principalOf(sender),
            participant: principalOf(print.participant ?? sender),
          }));
        }
      }
    }

    if (name === "join-pot-as-sponsor" && fromLogger(event, stackspotsContract)) {
      const sender = print.sender ?? print["tx-sender"] ?? print.sponsor;
      if (sameUserAddress(sender, want)) {
        addContribution(event, print);
        const sponsorKey = contract || `tx:${eventTxId(event) || ""}`;
        if (sponsorKey && sponsorKey !== "tx:") {
          upsertByContract(sponsored, sponsorKey, rowFromEvent(event, {
            contract: contract || null,
            kind: "pot",
            potName: print["pot-name"] ?? print.name ?? null,
            potType: print["pot-type"] ?? print.type ?? null,
            amount: print.amount ?? "0",
            sender: principalOf(sender),
            sponsor: principalOf(print.sponsor ?? sender),
          }));
        }
      }
    }

    if (name === "claim-pot-reward" && fromLogger(event, stackspotsContract)) {
      if (sameUserAddress(winnerAddressFromEvent(print), want) && contract) {
        const winners = unwrapTuple(print["winners-values"] ?? print["winner-values"]);
        upsertByContract(won, contract, rowFromEvent(event, {
          contract,
          kind: "pot",
          potName: print["pot-name"] ?? null,
          potType: print["pot-type"] ?? null,
          amount: winnerRewardFromEvent(print),
          sender: principalOf(print.sender),
          winnerId: winners?.["winner-id"] ?? winners?.participant ?? print["winner-id"] ?? null,
          winnerAddress: principalOf(winnerAddressFromEvent(print)),
        }));
      }
    }
  }

  const createdList = [...created.values()];
  const joinedList = [...joined.values()];
  const sponsoredList = [...sponsored.values()];
  const wonList = [...won.values()];

  return {
    address: want,
    totals: {
      created: createdList.length,
      joined: joinedList.length,
      sponsored: sponsoredList.length,
      won: wonList.length,
      contributedUstx: String(contributed),
    },
    created: createdList,
    joined: joinedList,
    sponsored: sponsoredList,
    won: wonList,
  };
}

export async function loadUserProfileEvents(ctx) {
  const chunks = await Promise.all(
    USER_PROFILE_EVENT_NAMES.map(async (eventName) => {
      const { ids } = await listEventIds({
        ...ctx,
        eventName,
        offset: 0,
        limit: 1_000_000,
      });
      return getEventsByIds(ids, ctx);
    }),
  );
  return chunks.flat();
}

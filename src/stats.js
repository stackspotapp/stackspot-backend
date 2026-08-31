import {
  activityDedupeKey,
  applyEventToPot,
  isPotEvent,
  normalizeListedPot,
  PLATFORM_EVENTS,
  POT_STATUSES,
  resolvePotAddress,
} from "./pots.js";

function asBig(value) {
  if (value == null || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function emptyAgg() {
  return {
    joins: 0,
    sponsors: 0,
    participants: new Set(),
    sponsorSet: new Set(),
    stxJoined: 0n,
    stxSponsored: 0n,
    yieldClaimed: 0n,
    deployFees: 0n,
    staked: 0n,
    rewardsPaid: 0n,
    byEvent: {},
  };
}

export function computeStatistics(events = [], listedPots = [], { stackspotsContract } = {}) {
  const potsMap = new Map();
  for (const pot of listedPots) {
    const normalized = normalizeListedPot(pot);
    if (!normalized?.potAddress) continue;
    potsMap.set(normalized.potAddress, { ...normalized });
  }

  const byEvent = {};
  const participants = new Set();
  const sponsors = new Set();
  const seenActivity = new Set();
  const aggByPot = new Map();
  let stxJoined = 0n;
  let stxSponsored = 0n;
  let yieldClaimed = 0n;
  let deployFees = 0n;
  let staked = 0n;
  let rewardsPaid = 0n;

  const sorted = [...events].sort((a, b) => {
    const height = Number(a.blockHeight ?? 0) - Number(b.blockHeight ?? 0);
    if (height !== 0) return height;
    return Number(a.eventIndex ?? 0) - Number(b.eventIndex ?? 0);
  });

  for (const event of sorted) {
    const name = event.event ?? "unknown";
    byEvent[name] = (byEvent[name] ?? 0) + 1;
    const values =
      event.values && typeof event.values === "object" && !Array.isArray(event.values)
        ? event.values
        : {};

    if (isPotEvent(name)) {
      const updated = applyEventToPot(potsMap.get(resolvePotAddress(event, stackspotsContract)), event, stackspotsContract);
      if (updated?.potAddress) potsMap.set(updated.potAddress, updated);
    }

    const unique = !seenActivity.has(activityDedupeKey(event));
    if (unique) seenActivity.add(activityDedupeKey(event));

    const potAddress = resolvePotAddress(event, stackspotsContract);
    if (potAddress && isPotEvent(name) && unique) {
      const agg = aggByPot.get(potAddress) ?? emptyAgg();
      agg.byEvent[name] = (agg.byEvent[name] ?? 0) + 1;
      aggByPot.set(potAddress, agg);
    }

    if (name === "join-pot" && unique) {
      stxJoined += asBig(values.amount);
      if (values.participant) participants.add(values.participant);
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.joins += 1;
        agg.stxJoined += asBig(values.amount);
        if (values.participant) agg.participants.add(values.participant);
        aggByPot.set(potAddress, agg);
      }
    }
    if (name === "join-pot-as-sponsor" && unique) {
      stxSponsored += asBig(values.amount);
      if (values.sponsor) sponsors.add(values.sponsor);
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.sponsors += 1;
        agg.stxSponsored += asBig(values.amount);
        if (values.sponsor) agg.sponsorSet.add(values.sponsor);
        aggByPot.set(potAddress, agg);
      }
    }
    if (name === "claim-pot-reward" && unique) {
      yieldClaimed += asBig(values["pot-yield-amount"]);
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.yieldClaimed += asBig(values["pot-yield-amount"]);
        aggByPot.set(potAddress, agg);
      }
    }
    if (name === "pot-registered" && unique) {
      const fee = asBig(values["pot-deploy-fee"]);
      deployFees += fee;
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.deployFees += fee;
        aggByPot.set(potAddress, agg);
      }
    }
    if (name === "stake-treasury" && unique) {
      staked += asBig(values["amount-ustx"]);
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.staked += asBig(values["amount-ustx"]);
        aggByPot.set(potAddress, agg);
      }
    }
    if (name === "pull-staking-rewards-cycle" && unique) {
      rewardsPaid += asBig(values.paid);
      if (potAddress) {
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        agg.rewardsPaid += asBig(values.paid);
        aggByPot.set(potAddress, agg);
      }
    }
  }

  const byStatus = Object.fromEntries(POT_STATUSES.map((status) => [status, 0]));
  const byType = {};
  const pots = [...potsMap.values()]
    .map((pot) => {
      const agg = aggByPot.get(pot.potAddress) ?? emptyAgg();
      return {
        ...pot,
        joins: agg.joins,
        sponsors: agg.sponsors,
        participants: agg.participants.size,
        sponsorCount: agg.sponsorSet.size,
        stxJoined: agg.stxJoined.toString(),
        stxSponsored: agg.stxSponsored.toString(),
        stxTotal: (agg.stxJoined + agg.stxSponsored).toString(),
        yieldClaimed: agg.yieldClaimed.toString(),
        deployFees: agg.deployFees.toString(),
        staked: agg.staked.toString(),
        rewardsPaid: agg.rewardsPaid.toString(),
        byEvent: agg.byEvent,
      };
    })
    .sort((a, b) => Number(b.lastBlockHeight ?? 0) - Number(a.lastBlockHeight ?? 0));

  for (const pot of pots) {
    const type = pot.potType ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (byStatus[pot.status] != null) byStatus[pot.status] += 1;
  }

  return {
    totals: {
      pots: pots.length,
      deployed: byStatus.deployed,
      joinable: byStatus.joinable,
      started: byStatus.started,
      cancelled: byStatus.cancelled,
      claimed: byStatus.claimed,
      events: events.length,
      participants: participants.size,
      sponsors: sponsors.size,
      stxJoined: stxJoined.toString(),
      stxSponsored: stxSponsored.toString(),
      stxTotal: (stxJoined + stxSponsored).toString(),
      yieldClaimed: yieldClaimed.toString(),
      deployFees: deployFees.toString(),
      staked: staked.toString(),
      rewardsPaid: rewardsPaid.toString(),
    },
    byType,
    byStatus,
    byEvent,
    platformEvents: Object.fromEntries(
      [...PLATFORM_EVENTS].map((name) => [name, byEvent[name] ?? 0]),
    ),
    pots,
  };
}

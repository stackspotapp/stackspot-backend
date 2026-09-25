import { eventPrint } from "./catalog.js";
import {
  activityDedupeKey,
  applyEventToPot,
  EVENT_STATUS,
  isPotEvent,
  normalizeListedPot,
  PLATFORM_EVENTS,
  POT_STATUSES,
  resolvePotAddress,
} from "./pots.js";

const STARTED_EVENT_NAMES = Object.entries(EVENT_STATUS)
  .filter(([, status]) => status === "started")
  .map(([name]) => name);

function potLiveValues(pot) {
  if (pot?.live && typeof pot.live === "object" && !Array.isArray(pot.live)) return pot.live;
  return null;
}

function truthyFlag(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function potHasClaimer(pot) {
  if (pot?.status === "claimed") return true;
  const live = potLiveValues(pot);
  const values = pot?.values && typeof pot.values === "object" ? pot.values : null;
  const claimer =
    live?.["pot-claimer-address"] ??
    live?.potClaimerAddress ??
    values?.["pot-claimer-address"] ??
    values?.potClaimerAddress;
  return claimer != null && String(claimer).trim() !== "" && String(claimer) !== "none";
}

function potIsLocked(pot) {
  const live = potLiveValues(pot);
  const values = pot?.values && typeof pot.values === "object" ? pot.values : null;
  if (live && truthyFlag(live["pot-locked"] ?? live.potLocked)) return true;
  if (values && truthyFlag(values["pot-locked"] ?? values.potLocked)) return true;
  return false;
}

/** True if the pot ever reached started (including later claimed; cancel-only pots excluded). */
function potEverStarted(pot) {
  if (!pot) return false;
  if (pot.status === "started" || pot.status === "claimed") return true;
  if (potHasClaimer(pot)) return true;
  // Live get-pot-details lock — same signal the pots page uses for "started".
  if (potIsLocked(pot)) return true;
  const byEvent = pot.byEvent ?? {};
  return STARTED_EVENT_NAMES.some((name) => (byEvent[name] ?? 0) > 0);
}

/**
 * Currently joinable: open for joins, not started/locked/cancelled/claimed.
 * Aligns with pots UI (`!potLocked` + not claimed).
 */
function potCurrentlyJoinable(pot) {
  if (!pot) return false;
  if (pot.status === "cancelled") return false;
  if (potHasClaimer(pot)) return false;
  if (pot.status === "claimed" || pot.status === "started") return false;
  if (potEverStarted(pot)) return false;
  if (potIsLocked(pot)) return false;
  return pot.status === "joinable";
}

function potCurrentlyClaimed(pot) {
  return potHasClaimer(pot);
}

/** Same universe as GET /pots: must have seen init-pot or pot-registered (not bare pre-init). */
function potHasInitPrint(pot, initializedAddresses) {
  if (!pot?.potAddress) return false;
  const key = String(pot.potAddress).trim().toLowerCase();
  if (initializedAddresses?.has(key)) return true;
  const byEvent = pot.byEvent ?? {};
  return (byEvent["init-pot"] ?? 0) > 0 || (byEvent["pot-registered"] ?? 0) > 0;
}
function asBig(value) {
  if (value == null || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Prefer full yield; reconstruct from 2% starter/claimer slices when the field was truncated. */
function claimYieldAmount(values = {}) {
  const direct = asBig(values["pot-yield-amount"] ?? values.potYieldAmount ?? values["pot-reward-amount"]);
  if (direct > 0n) return direct;
  const starter = asBig(values["starter-reward-amount"] ?? values["starter-reward"]);
  const claimer = asBig(values["claimer-reward-amount"] ?? values["claimer-reward"]);
  if (starter > 0n && claimer > 0n) return (starter + claimer) * 25n;
  if (starter > 0n) return starter * 50n;
  if (claimer > 0n) return claimer * 50n;
  return 0n;
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
  const liveByAddress = new Map();

  const potKey = (address) => String(address ?? "").trim().toLowerCase();
  const readPot = (address) => {
    const key = potKey(address);
    return key ? potsMap.get(key) ?? null : null;
  };
  const writePot = (pot) => {
    if (!pot?.potAddress) return;
    const key = potKey(pot.potAddress);
    const live = pot.live ?? liveByAddress.get(key) ?? null;
    potsMap.set(key, { ...pot, live });
  };

  for (const pot of listedPots) {
    const normalized = normalizeListedPot(pot);
    if (!normalized?.potAddress) continue;
    const key = potKey(normalized.potAddress);
    const live = pot.live ?? normalized.live ?? null;
    if (live && typeof live === "object") liveByAddress.set(key, live);
    writePot({ ...normalized, live });
  }

  const byEvent = {};
  const participants = new Set();
  const sponsors = new Set();
  const platformSponsors = new Set();
  const platformSponsorContracts = new Set();
  const seenActivity = new Set();
  const aggByPot = new Map();
  let stxJoined = 0n;
  let stxSponsored = 0n;
  let platformSponsorStx = 0n;
  let sponsorEventCount = 0;
  let yieldClaimed = 0n;
  let deployFees = 0n;
  let staked = 0n;
  let rewardsPaid = 0n;
  /** Max claim yield per pot — pot + stackspots prints share a tx and must not double-count. */
  const yieldByPot = new Map();
  /** Pot contracts that received init-pot or pot-registered (excludes pre-init-only deploys). */
  const initializedAddresses = new Set();

  const sorted = [...events].sort((a, b) => {
    const height = Number(a.blockHeight ?? 0) - Number(b.blockHeight ?? 0);
    if (height !== 0) return height;
    return Number(a.eventIndex ?? 0) - Number(b.eventIndex ?? 0);
  });

  for (const event of sorted) {
    const values = eventPrint(event);
    const name = event.event ?? values.event ?? "unknown";
    byEvent[name] = (byEvent[name] ?? 0) + 1;

    if (isPotEvent(name)) {
      const address = resolvePotAddress(event, stackspotsContract);
      const updated = applyEventToPot(readPot(address), event, stackspotsContract);
      if (updated?.potAddress) writePot(updated);
    }

    const unique = !seenActivity.has(activityDedupeKey(event));
    if (unique) seenActivity.add(activityDedupeKey(event));

    const potAddress = resolvePotAddress(event, stackspotsContract);
    if (potAddress && (name === "init-pot" || name === "pot-registered")) {
      initializedAddresses.add(String(potAddress).trim().toLowerCase());
    }
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
    if (name === "claim-pot-reward") {
      const amount = claimYieldAmount(values);
      if (potAddress && amount > 0n) {
        const prev = yieldByPot.get(potAddress) ?? 0n;
        if (amount > prev) yieldByPot.set(potAddress, amount);
        const agg = aggByPot.get(potAddress) ?? emptyAgg();
        if (amount > agg.yieldClaimed) agg.yieldClaimed = amount;
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
    if (name === "sponsor-platform" && unique) {
      platformSponsorStx += asBig(values.amount);
      if (values.sponsor) platformSponsors.add(values.sponsor);
      if (values["sponsor-contract"]) platformSponsorContracts.add(values["sponsor-contract"]);
    }
    if (name === "sponsor-event" && unique) {
      sponsorEventCount += 1;
    }
  }

  const byStatus = Object.fromEntries(POT_STATUSES.map((status) => [status, 0]));
  const byType = {};
  const allPots = [...potsMap.values()]
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

  // Lifecycle + pot totals match GET /pots: initialized pots only (init-pot / pot-registered).
  const pots = allPots.filter((pot) => potHasInitPrint(pot, initializedAddresses));

  for (const pot of pots) {
    const type = pot.potType ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    const status = POT_STATUSES.includes(pot.status) ? pot.status : null;
    if (status) byStatus[status] += 1;
  }

  // Lifecycle "started" = ever started / locked (claimed pots still count).
  byStatus.started = pots.filter(potEverStarted).length;
  // Joinable = currently open only (exclude started/locked/claimed — matches pots UI).
  byStatus.joinable = pots.filter(potCurrentlyJoinable).length;
  byStatus.claimed = pots.filter(potCurrentlyClaimed).length;

  for (const [address, amount] of yieldByPot) {
    const key = String(address).trim().toLowerCase();
    if (!initializedAddresses.size || initializedAddresses.has(key)) {
      yieldClaimed += amount;
    }
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
      platformSponsors: platformSponsors.size,
      platformSponsorContracts: platformSponsorContracts.size,
      platformSponsorStx: platformSponsorStx.toString(),
      sponsorEvents: sponsorEventCount,
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

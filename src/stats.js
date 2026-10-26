import { eventPrint } from "./catalog.js";
import { platformSiblingContract, PRE_INIT_LOGS_CONTRACT_NAME } from "./config.js";
import {
  activityDedupeKey,
  applyEventToPot,
  isPotEvent,
  isRegisterPotEvent,
  normalizeListedPot,
  potEventKey,
  PLATFORM_EVENTS,
  POT_STATUSES,
  resolvePotAddress,
} from "./pots.js";

function resolvePreInitLogsContract({ preInitLogsContract, stackspotsContract } = {}) {
  const explicit = String(preInitLogsContract ?? "").trim();
  if (explicit) return explicit;
  return platformSiblingContract(stackspotsContract, PRE_INIT_LOGS_CONTRACT_NAME);
}

/** Pots and deployed counts: prints from `{platform}.stackspot-pre-init-logs` only. */
export function isPreInitLogsEvent(event, preInitLogsContract) {
  const name = event?.event ?? eventPrint(event).event;
  if (name !== "pre-init") return false;
  const want = String(preInitLogsContract ?? "").trim().toLowerCase();
  if (!want) return false;
  const source = String(event?.sourceContract ?? event?.contractId ?? "")
    .trim()
    .toLowerCase();
  return source === want;
}

function loggerName(contractId) {
  return String(contractId ?? "").split(".")[1]?.toLowerCase() ?? "";
}

function sourceContractOf(event) {
  return String(event?.sourceContract ?? event?.contractId ?? "").trim();
}

/** Prints from `{platform}.stackspots` or `{platform}.stackspot-pre-init-logs`. */
export function isPlatformLoggerEvent(event, { stackspotsContract, preInitLogsContract } = {}) {
  const source = sourceContractOf(event).toLowerCase();
  const spots = String(stackspotsContract ?? "").trim().toLowerCase();
  const pre = String(preInitLogsContract ?? "").trim().toLowerCase();
  if (!source) return true;
  if (spots && source === spots) return true;
  if (pre && source === pre) return true;
  const name = loggerName(source);
  return name === "stackspots" || name === "stackspot-pre-init-logs";
}

export function platformLoggerEventCount(events = [], opts = {}) {
  let count = 0;
  for (const event of events) {
    if (isPlatformLoggerEvent(event, opts)) count += 1;
  }
  return count;
}

export function preInitLogsEventCount(events = [], preInitLogsContract) {
  const want = String(preInitLogsContract ?? "").trim().toLowerCase();
  let sourced = 0;
  let unsourced = 0;
  for (const event of events) {
    const name = event?.event ?? eventPrint(event).event;
    if (name !== "pre-init") continue;
    const source = String(event?.sourceContract ?? event?.contractId ?? "")
      .trim()
      .toLowerCase();
    if (want && source === want) sourced += 1;
    else if (!source) unsourced += 1;
  }
  return sourced > 0 ? sourced : unsourced;
}

/** Joinable +1 on init-pot. register-pot is an alias for that print, but does not create pot rows. */
const INIT_EVENT_NAMES = ["init-pot", "pot-registered", "register-pot"];
const START_EVENT_NAMES = [
  "start-pot",
  "start-stackspot-jackpot",
  "start-stackspot-crowdfund",
  "start-stackspot-sequential-pot",
];
const CANCEL_EVENT_NAMES = ["cancel-pot", "fall-back-cancel"];
const CLAIM_EVENT_NAMES = ["claim-pot-reward"];

function potSawEvent(pot, names) {
  const byEvent = pot?.byEvent ?? {};
  return names.some((name) => (byEvent[name] ?? 0) > 0);
}

function potWasDeployed(pot) {
  return potSawEvent(pot, ["pre-init"]);
}

function potWasInitiated(pot) {
  return potSawEvent(pot, INIT_EVENT_NAMES);
}

function potWasStarted(pot) {
  return potSawEvent(pot, START_EVENT_NAMES);
}

function potWasCancelled(pot) {
  return potSawEvent(pot, CANCEL_EVENT_NAMES);
}

function potWasClaimed(pot) {
  return potSawEvent(pot, CLAIM_EVENT_NAMES);
}

/** Joinable = init-pot pots that have not seen start or cancel. */
function potCurrentlyJoinable(pot) {
  if (!potWasInitiated(pot)) return false;
  if (potWasStarted(pot) || potWasCancelled(pot)) return false;
  return true;
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

export function computeStatistics(
  events = [],
  listedPots = [],
  { stackspotsContract, preInitLogsContract } = {},
) {
  const loggerContract = resolvePreInitLogsContract({ preInitLogsContract, stackspotsContract });
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
    if (isRegisterPotEvent(potEventKey(normalized))) continue;
    const key = potKey(normalized.potAddress);
    const live = pot.live ?? normalized.live ?? null;
    if (live && typeof live === "object") liveByAddress.set(key, live);
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
    if (potAddress && unique && (isPotEvent(name) || isRegisterPotEvent(name))) {
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

  // Event buckets only (no live get-pot-details):
  // deployed +1 pre-init (never decreases);
  // joinable +1 init-pot, −1 start, −1 cancel;
  // started / cancelled / claimed +1 on those events only.
  const pots = allPots;

  for (const pot of pots) {
    const type = pot.potType ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const loggerEventCount = preInitLogsEventCount(sorted, loggerContract);
  const platformEventsCount = platformLoggerEventCount(sorted, {
    stackspotsContract,
    preInitLogsContract: loggerContract,
  });
  byStatus.deployed = loggerEventCount;
  byStatus.joinable = pots.filter(potCurrentlyJoinable).length;
  byStatus.started = pots.filter(potWasStarted).length;
  byStatus.cancelled = pots.filter(potWasCancelled).length;
  byStatus.claimed = pots.filter(potWasClaimed).length;

  for (const amount of yieldByPot.values()) {
    yieldClaimed += amount;
  }

  return {
    totals: {
      pots: loggerEventCount,
      deployed: byStatus.deployed,
      joinable: byStatus.joinable,
      started: byStatus.started,
      cancelled: byStatus.cancelled,
      claimed: byStatus.claimed,
      events: platformEventsCount,
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

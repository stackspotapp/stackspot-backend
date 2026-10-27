import { eventPrint } from "./catalog.js";
import { asUstx, eventNameOf, isPreInitLogsSource, isStackspotsHubSource } from "./http.js";
import { isJoinableInitPotEvent, potAddressFromValues } from "./pots.js";

const START_NAMES = new Set([
  "start-pot",
  "start-stackspot-jackpot",
  "start-stackspot-crowdfund",
  "start-stackspot-sequential-pot",
]);
const CANCEL_NAMES = new Set(["cancel-pot", "fall-back-cancel"]);
const CLAIM_NAMES = new Set(["claim-pot-reward"]);
const REGISTER_NAMES = new Set(["register-pot", "pot-registered"]);

export function emptyPlatformState() {
  return {
    totals: {
      pots: 0,
      deployed: 0,
      joinable: 0,
      started: 0,
      cancelled: 0,
      claimed: 0,
      events: 0,
      participants: 0,
      sponsors: 0,
      stxJoined: "0",
      stxSponsored: "0",
      stxTotal: "0",
      yieldClaimed: "0",
      deployFees: "0",
      staked: "0",
      rewardsPaid: "0",
      platformSponsors: 0,
      platformSponsorContracts: 0,
      platformSponsorStx: "0",
      sponsorEvents: 0,
    },
    byStatus: {
      deployed: 0,
      joinable: 0,
      started: 0,
      cancelled: 0,
      claimed: 0,
    },
    byEvent: {},
    byType: {},
    platformEvents: {},
  };
}

/**
 * Homepage `/state` counters from logger prints only (no live reads).
 *
 * Deployed: pre-init on `.stackspot-pre-init-logs`
 * Started: start-pot (+ v3 aliases) on `.stackspots`
 * Cancelled: cancel-pot / fall-back-cancel on `.stackspots`
 * Joinable: unique hub init/register pots that have not started or cancelled
 * Claimed: unique claim-pot-reward pots on `.stackspots`
 * Events: hub + pre-init-logs totals
 * Deploy fees: sum of pot-deploy-fee on register-pot / pot-registered (hub)
 */
function potKeyOf(event) {
  const name = eventNameOf(event);
  const print = eventPrint(event);
  const id =
    potAddressFromValues(name, print) ??
    print.contract ??
    print["pot-contract"] ??
    print["pot-address"] ??
    print["pot-treasury"];
  const key = String(id ?? "").trim().toLowerCase();
  if (key) return key;
  return `tx:${String(event?.txid ?? event?.txId ?? event?.id ?? "").toLowerCase()}`;
}

function uniquePotKeys(events) {
  const keys = new Set();
  let index = 0;
  for (const event of events) {
    const key = potKeyOf(event);
    if (key && !key.startsWith("tx:")) keys.add(key);
    else keys.add(`row:${index}`);
    index += 1;
  }
  return keys;
}

export function computePlatformState(
  events = [],
  { stackspotsContract, preInitLogsContract, eventTotals } = {},
) {
  const byEvent = {};
  const preInit = [];
  const initPots = [];
  const starts = [];
  const cancels = [];
  const claims = [];
  const registers = [];

  for (const event of events) {
    const name = eventNameOf(event);
    byEvent[name] = (byEvent[name] ?? 0) + 1;
    if (name === "pre-init" && isPreInitLogsSource(event, preInitLogsContract)) {
      preInit.push(event);
      continue;
    }
    if (isJoinableInitPotEvent(event, { stackspotsContract, preInitLogsContract })) {
      initPots.push(event);
    }
    if (!isStackspotsHubSource(event, stackspotsContract)) continue;
    if (START_NAMES.has(name)) starts.push(event);
    else if (CANCEL_NAMES.has(name)) cancels.push(event);
    else if (CLAIM_NAMES.has(name)) claims.push(event);
    if (REGISTER_NAMES.has(name)) registers.push(event);
  }

  let deployFees = 0n;
  for (const event of registers) {
    const print = eventPrint(event);
    deployFees += asUstx(print["pot-deploy-fee"] ?? print.potDeployFee);
  }

  const deployedKeys = uniquePotKeys(preInit);
  const initKeys = uniquePotKeys(initPots);
  const startedKeys = uniquePotKeys(starts);
  const cancelledKeys = uniquePotKeys(cancels);
  const claimedKeys = uniquePotKeys(claims);
  const deployed = deployedKeys.size;
  const started = startedKeys.size;
  const cancelled = cancelledKeys.size;
  const claimed = claimedKeys.size;
  let joinable = 0;
  for (const key of initKeys) {
    if (!startedKeys.has(key) && !cancelledKeys.has(key)) joinable += 1;
  }
  const hubTotal = Number(eventTotals?.stackspots);
  const preTotal = Number(eventTotals?.preInit);
  const eventsTotal =
    (Number.isFinite(hubTotal) && hubTotal >= 0 ? hubTotal : 0) +
    (Number.isFinite(preTotal) && preTotal >= 0 ? preTotal : 0);

  const state = emptyPlatformState();
  state.kind = "platform-state-v1";
  state.byEvent = byEvent;
  state.byStatus = { deployed, joinable, started, cancelled, claimed };
  state.totals = {
    ...state.totals,
    pots: deployed,
    deployed,
    joinable,
    started,
    cancelled,
    claimed,
    events: eventsTotal > 0 ? eventsTotal : preInit.length + (byEvent["init-pot"] ?? 0) + starts.length + cancels.length + claims.length + registers.length,
    deployFees: deployFees.toString(),
  };
  return state;
}

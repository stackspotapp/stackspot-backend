import { eventPrint } from "./catalog.js";
import { asUstx } from "./http.js";
import { selectSponsorPlatformPrints } from "./sponsors.js";

export function computeSponsorPage(prints = []) {
  const sponsors = selectSponsorPlatformPrints(prints);
  const seenTx = new Set();
  const unique = sponsors.filter((row) => {
    const txid = row?.txid;
    if (!txid) return true;
    if (seenTx.has(txid)) return false;
    seenTx.add(txid);
    return true;
  });

  let totalSponsored = 0n;
  let cyclesLocked = 0n;
  let thisCycleInflow = 0n;
  const contracts = new Set();

  for (const row of unique) {
    const print = eventPrint(row);
    totalSponsored += asUstx(print.amount ?? row.amount);
    cyclesLocked += asUstx(print.cycles ?? row.cycles);
    const live = row.live && typeof row.live === "object" ? row.live : {};
    thisCycleInflow += asUstx(
      live["available-reward-pool"] ?? live.availableRewardPool ?? live["sbtc-balance"],
    );
    const id = print["sponsor-contract"] ?? row["sponsor-contract"] ?? row.sponsorContract;
    if (id) contracts.add(String(id).toLowerCase());
  }

  return {
    stats: {
      totalSponsored: totalSponsored.toString(),
      sponsors: unique.length,
      cyclesLocked: cyclesLocked.toString(),
      thisCycleInflow: thisCycleInflow.toString(),
      sponsorContracts: contracts.size,
    },
    sponsors: unique,
    total: unique.length,
  };
}

import {
  forgetEventIdsForTx,
  getEventsByIds,
  getPotLives,
  listEventIds,
  setStoredInitPotSponsors,
} from "./cache.js";
import { fetchTransaction, normalizeLog } from "./hiro.js";
import { printPayload } from "./http.js";
import { loadLivePotDetails, sponsorsFromPrintLogs } from "./potDetails.js";
import { isJoinableInitPotEvent } from "./pots.js";
import { mergeSponsorTickets } from "./sponsors.js";

export function potContractOf(print) {
  return (
    print?.contract ??
    print?.["pot-contract"] ??
    print?.["pot-treasury"] ??
    print?.potAddress ??
    null
  );
}

function liveHasInitFlag(live) {
  return Boolean(
    live &&
      typeof live === "object" &&
      (Object.prototype.hasOwnProperty.call(live, "is-initiated") ||
        Object.prototype.hasOwnProperty.call(live, "pot-is-init")),
  );
}

export async function attachStoredLive(prints, ctx) {
  const rows = Array.isArray(prints) ? prints : [];
  const lives = await getPotLives(rows.map(potContractOf), ctx);
  return rows.map((print) => {
    if (!print || typeof print !== "object") return print;
    if (print.live && typeof print.live === "object") return print;
    const id = String(potContractOf(print) ?? "").trim().toLowerCase();
    const live = id ? lives.get(id) : null;
    return live ? { ...print, live } : print;
  });
}

/** Hiro get-pot-details — single-pot routes only, never list pages. */
export async function ensurePotLive(prints, ctx, { refresh = false, sponsorContract = null } = {}) {
  const rows = refresh ? (Array.isArray(prints) ? prints : []) : await attachStoredLive(prints, ctx);
  return Promise.all(
    rows.map(async (print) => {
      const hasSponsors = Array.isArray(print?.live?.["platform-sponsors"]);
      if (
        !refresh &&
        print &&
        typeof print === "object" &&
        liveHasInitFlag(print.live) &&
        hasSponsors
      ) {
        return print;
      }
      const potAddress = potContractOf(print);
      if (!potAddress) return { ...print, live: print?.live ?? null };
      try {
        const live = await loadLivePotDetails({
          contractId: potAddress,
          owner: print["pot-owner"] ?? print.owner,
          sponsorContract,
          stackspotsContract: ctx.contract,
          refresh,
          ctx,
          pot: {
            potAddress,
            potType: print["pot-type"] ?? print.type,
            values: print,
          },
        });
        return { ...print, live: live.hasDecoded ? live.values : print.live ?? null };
      } catch {
        return { ...print, live: print?.live ?? null };
      }
    }),
  );
}

export async function attachInitPotTickets(prints, ctx) {
  const out = [];
  for (const print of prints) {
    if (Array.isArray(print.sponsors) && print.sponsors.length > 1) {
      out.push(print);
      continue;
    }
    try {
      const tx = await fetchTransaction(print.txid, ctx.stacksApiUrl);
      const logs = (tx?.events ?? []).map((item) => normalizeLog(item, print.contract));
      const sponsors = mergeSponsorTickets(print.sponsors, sponsorsFromPrintLogs(logs, print.contract));
      if (sponsors.length) {
        await setStoredInitPotSponsors(print.txid, print.contract, sponsors, ctx);
        out.push({ ...print, sponsors });
        continue;
      }
      await forgetEventIdsForTx(print.txid, ctx);
    } catch (error) {
      console.error("[sponsors] init-pot tickets", print.txid, error.message);
      await forgetEventIdsForTx(print.txid, ctx);
    }
    out.push(print);
  }
  return out;
}

export async function loadInitPotEvents(ctx) {
  const { ids } = await listEventIds({ ...ctx, eventName: "init-pot", offset: 0, limit: 1_000_000 });
  return getEventsByIds(ids, ctx);
}

export async function loadJoinableInitPotEvents(ctx) {
  const initEvents = await loadInitPotEvents(ctx);
  return initEvents.filter((event) =>
    isJoinableInitPotEvent(event, {
      stackspotsContract: ctx.contract,
      preInitLogsContract: ctx.preInitLogsContract,
    }),
  );
}

export { printPayload };

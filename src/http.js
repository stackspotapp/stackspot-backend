import { config, requireContract, resolveRequestContext } from "./config.js";
import { getEventsByIds, listEventIds } from "./cache.js";
import { eventPrint } from "./catalog.js";

export { requireContract };

export function parseLimitOffset(query) {
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  return { limit, offset };
}

export function requestContext(req) {
  return resolveRequestContext(req.query?.network ?? req.body?.network);
}

export function networkEnvelope(ctx) {
  return {
    network: ctx.network,
    networkSource: ctx.networkSource,
    contract: ctx.contract,
    preInitLogsContract: ctx.preInitLogsContract ?? null,
    stacksApiUrl: ctx.stacksApiUrl,
  };
}

export function printPayload(event) {
  if (!event || typeof event !== "object") return event;
  const { sourceContract: _source, ...print } = event;
  return print;
}

export function queryFlag(query, key = "refresh") {
  const value = query?.[key];
  return value === "1" || value === true || value === "true";
}

export function contractNameOf(contractId) {
  return String(contractId ?? "").split(".")[1]?.toLowerCase() ?? "";
}

export function sourceContractOf(event) {
  return String(event?.sourceContract ?? event?.contractId ?? "").trim();
}

/** Prints whose source is `{platform}.stackspots`. */
export function isStackspotsHubSource(event, hubContract) {
  const source = sourceContractOf(event).toLowerCase();
  if (!source) return false;
  const want = String(hubContract ?? "").trim().toLowerCase();
  if (want && source === want) return true;
  return contractNameOf(source) === "stackspots";
}

export function isPreInitLogsSource(event, preInitLogsContract) {
  const source = sourceContractOf(event).toLowerCase();
  if (!source) return false;
  const want = String(preInitLogsContract ?? "").trim().toLowerCase();
  if (want && source === want) return true;
  return contractNameOf(source) === "stackspot-pre-init-logs";
}

export function eventNameOf(event) {
  return String(eventPrint(event).event ?? event?.event ?? "").trim();
}

export async function loadEventsByName(ctx, eventName) {
  const { ids, total } = await listEventIds({
    ...ctx,
    eventName,
    offset: 0,
    limit: 1_000_000,
  });
  return { events: await getEventsByIds(ids, ctx), total };
}

export async function loadEventsByNames(ctx, names) {
  const chunks = await Promise.all(names.map((name) => loadEventsByName(ctx, name)));
  return chunks.flatMap((chunk) => chunk.events);
}

export function asUstx(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

export { config };

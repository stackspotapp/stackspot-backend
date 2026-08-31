import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiUrlForNetwork,
  networkFromPrincipal,
  parseNetwork,
} from "./network.js";

loadEnv({ path: resolve(fileURLToPath(new URL("..", import.meta.url)), ".env") });

const defaultNetwork = parseNetwork(process.env.NETWORK);
if (!defaultNetwork) {
  throw new Error("NETWORK is required and must be mainnet or testnet");
}

function trim(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function contractFor(network) {
  const named = trim(process.env[`STACKSPOTS_CONTRACT_${network.toUpperCase()}`]);
  if (named) return named;
  const generic = trim(process.env.STACKSPOTS_CONTRACT);
  if (generic && networkFromPrincipal(generic) === network) return generic;
  return null;
}

const contracts = {
  mainnet: contractFor("mainnet"),
  testnet: contractFor("testnet"),
};

export function resolveRequestContext(rawNetwork) {
  const hasQuery = rawNetwork != null && String(rawNetwork).trim() !== "";
  if (hasQuery && !parseNetwork(rawNetwork)) {
    const error = new Error("network must be mainnet or testnet");
    error.status = 400;
    throw error;
  }
  const network = parseNetwork(rawNetwork) ?? defaultNetwork;
  const contract = contracts[network] ?? null;
  return {
    network,
    networkSource: hasQuery ? "query" : "default",
    contract,
    stacksApiUrl: apiUrlForNetwork(network),
  };
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  defaultNetwork,
  network: defaultNetwork,
  contracts,
  stackspotsContract: contracts[defaultNetwork],
  stacksApiUrl: apiUrlForNetwork(defaultNetwork),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 15_000),
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 0),
  pageSize: Number(process.env.PAGE_SIZE ?? 50),
  maxSyncPages: Number(process.env.MAX_SYNC_PAGES ?? 80),
  contractCacheTtlSeconds: Number(process.env.CONTRACT_CACHE_TTL_SECONDS ?? 15),
  defaultReadFunction: process.env.DEFAULT_READ_FUNCTION ?? "get-pot-details",
};

export function requireContract(ctx) {
  if (ctx?.contract) return ctx.contract;
  const error = new Error(
    `No Stackspots contract configured for ${ctx?.network ?? "unknown"}. Set STACKSPOTS_CONTRACT_${String(ctx?.network ?? "").toUpperCase()}.`,
  );
  error.status = 400;
  throw error;
}

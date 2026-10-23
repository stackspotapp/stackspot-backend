import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiUrlForNetwork,
  networkFromPrincipal,
  parseNetwork,
} from "./network.js";
import { buildRedisUrl } from "./redisEnv.js";

loadEnv({ path: resolve(fileURLToPath(new URL("..", import.meta.url)), ".env") });

const DEFAULT_CONTRACTS = {
  mainnet: "SP2HXAW0GEHMXGHR0PG44443HV0S58WSZQY4V26W1.stackspots",
  testnet: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackspots",
};

export const PRE_INIT_LOGS_CONTRACT_NAME = "stackspot-pre-init-logs";

/** Same deployer as stackspots: `{address}.stackspot-pre-init-logs`. */
export function platformSiblingContract(stackspotsContract, name) {
  const address = String(stackspotsContract ?? "").split(".")[0]?.trim();
  if (!address) return null;
  return `${address}.${name}`;
}

function namedEnvContract(prefix, network) {
  const named = trim(process.env[`${prefix}_${network.toUpperCase()}`]);
  if (named) return named;
  const generic = trim(process.env[prefix]);
  if (generic && networkFromPrincipal(generic) === network) return generic;
  return null;
}

function trim(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function resolveDefaultNetwork() {
  return (
    parseNetwork(process.env.NETWORK) ??
    networkFromPrincipal(process.env.STACKSPOTS_CONTRACT) ??
    (trim(process.env.STACKSPOTS_CONTRACT_MAINNET) ? "mainnet" : null) ??
    (trim(process.env.STACKSPOTS_CONTRACT_TESTNET) ? "testnet" : null) ??
    "mainnet"
  );
}

const defaultNetwork = resolveDefaultNetwork();

function contractFor(network) {
  return namedEnvContract("STACKSPOTS_CONTRACT", network) ?? DEFAULT_CONTRACTS[network] ?? null;
}

function preInitLogsFor(network, stackspotsId) {
  return (
    namedEnvContract("STACKSPOTS_PRE_INIT_LOGS", network) ??
    platformSiblingContract(stackspotsId, PRE_INIT_LOGS_CONTRACT_NAME)
  );
}

const contracts = {
  mainnet: contractFor("mainnet"),
  testnet: contractFor("testnet"),
};

const preInitLogsContracts = {
  mainnet: preInitLogsFor("mainnet", contracts.mainnet),
  testnet: preInitLogsFor("testnet", contracts.testnet),
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
    preInitLogsContract: preInitLogsContracts[network] ?? preInitLogsFor(network, contract),
    stacksApiUrl: apiUrlForNetwork(network),
  };
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  redisUrl: buildRedisUrl(),
  defaultNetwork,
  network: defaultNetwork,
  contracts,
  preInitLogsContracts,
  stackspotsContract: contracts[defaultNetwork],
  preInitLogsContract: preInitLogsContracts[defaultNetwork],
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

/** Hiro print source we ingest: stackspots, pre-init-logs, or the contract currently being synced. */
export function isAcceptedPrintSource(source, ctx = {}, fetchingContractId = null) {
  const src = String(source ?? "").trim().toLowerCase();
  if (!src) return true;
  const allowed = [ctx.contract, ctx.preInitLogsContract, fetchingContractId]
    .filter(Boolean)
    .map((id) => String(id).trim().toLowerCase());
  return allowed.includes(src);
}

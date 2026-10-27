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
  return namedEnvContract("STACKSPOTS_CONTRACT", network);
}

function missingContractMessage(network) {
  return `No Stackspots contract configured for ${network}. Set STACKSPOTS_CONTRACT_${String(network).toUpperCase()} or STACKSPOTS_CONTRACT in .env.`;
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
  if (!contract) {
    const error = new Error(missingContractMessage(network));
    error.status = 400;
    throw error;
  }
  return {
    network,
    networkSource: hasQuery ? "query" : "default",
    contract,
    preInitLogsContract: preInitLogsContracts[network] ?? preInitLogsFor(network, contract),
    stacksApiUrl: apiUrlForNetwork(network),
  };
}

/** Fail boot when .env has no hub contract for the default network. */
export function assertConfiguredContracts() {
  if (!contracts.mainnet && !contracts.testnet) {
    const error = new Error(
      "No Stackspots contract configured. Set STACKSPOTS_CONTRACT_MAINNET and/or STACKSPOTS_CONTRACT_TESTNET in .env.",
    );
    error.status = 400;
    throw error;
  }
  if (!contracts[defaultNetwork]) {
    const error = new Error(missingContractMessage(defaultNetwork));
    error.status = 400;
    throw error;
  }
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
  const error = new Error(missingContractMessage(ctx?.network ?? "unknown"));
  error.status = 400;
  throw error;
}

/** Cached prints come only from `{platform}.stackspots` and `{platform}.stackspot-pre-init-logs`. */
export function isAcceptedPrintSource(source, ctx = {}) {
  const src = String(source ?? "").trim().toLowerCase();
  if (!src) return true;
  const allowed = [ctx.contract, ctx.preInitLogsContract]
    .filter(Boolean)
    .map((id) => String(id).trim().toLowerCase());
  if (allowed.includes(src)) return true;
  const name = src.split(".")[1] ?? "";
  return name === "stackspots" || name === "stackspot-pre-init-logs";
}

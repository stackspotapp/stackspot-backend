export const HIRO_API = {
  mainnet: "https://api.hiro.so",
  testnet: "https://api.testnet.hiro.so",
};

export function networkFromPrincipal(principal) {
  const address = String(principal ?? "")
    .trim()
    .split(".")[0]
    .toUpperCase();
  if (address.startsWith("SP") || address.startsWith("SM")) return "mainnet";
  if (address.startsWith("ST") || address.startsWith("SN")) return "testnet";
  return null;
}

export function parseNetwork(value) {
  const network = String(value ?? "")
    .trim()
    .toLowerCase();
  if (network === "mainnet" || network === "testnet") return network;
  return null;
}

export function apiUrlForNetwork(network) {
  if (network === "mainnet") {
    return (process.env.STACKS_MAINNET_API_URL ?? HIRO_API.mainnet).replace(/\/$/, "");
  }
  if (network === "testnet") {
    return (process.env.STACKS_TESTNET_API_URL ?? HIRO_API.testnet).replace(/\/$/, "");
  }
  const error = new Error("NETWORK is required and must be mainnet or testnet");
  error.status = 400;
  throw error;
}

export function apiUrlForPrincipal(principal, fallbackNetwork) {
  const detected = networkFromPrincipal(principal);
  return apiUrlForNetwork(detected ?? fallbackNetwork);
}

export function resolveNetwork({ network, contractId } = {}) {
  const explicit = parseNetwork(network);
  if (explicit) return explicit;
  const detected = networkFromPrincipal(contractId);
  if (detected) return detected;
  throw new Error(
    "NETWORK is required (mainnet or testnet). Set NETWORK, or STACKSPOTS_CONTRACT with an SP/ST principal.",
  );
}

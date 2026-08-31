function trim(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function redisUsesTls(urlOrHost, env = process.env) {
  const flag = String(env.REDIS_TLS ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false") return false;
  if (flag === "1" || flag === "true") return true;
  return String(urlOrHost ?? "").startsWith("rediss://");
}

export function withRedisTls(url, env = process.env) {
  const trimmed = trim(url);
  if (!trimmed) return trimmed;
  if (!redisUsesTls(trimmed, env)) return trimmed;
  if (trimmed.startsWith("redis://")) return `rediss://${trimmed.slice("redis://".length)}`;
  return trimmed;
}

function endpointHostPort(endpoint) {
  const cleaned = String(endpoint)
    .trim()
    .replace(/^rediss?:\/\//i, "")
    .replace(/^\/\//, "");
  return cleaned.replace(/\/$/, "");
}

export function buildRedisUrl(env = process.env) {
  const direct = trim(env.REDIS_URL);
  if (direct) return withRedisTls(direct, env);

  const password = trim(env.REDIS_PASSWORD);
  const username = trim(env.REDIS_USERNAME) ?? "default";
  const endpoint =
    trim(env.REDIS_ENDPOINT_URI) ??
    (trim(env.REDIS_HOST)
      ? `${trim(env.REDIS_HOST)}:${trim(env.REDIS_PORT) ?? "6379"}`
      : null);

  if (endpoint) {
    const hostPort = endpointHostPort(endpoint);
    const protocol = redisUsesTls(endpoint, env) ? "rediss" : "redis";
    const auth = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : "";
    return `${protocol}://${auth}${hostPort}`;
  }

  return "redis://127.0.0.1:6379";
}

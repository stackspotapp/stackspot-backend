import assert from "node:assert/strict";
import test from "node:test";
import { buildRedisUrl, redisUsesTls, withRedisTls } from "./redisEnv.js";

test("keeps Redis Cloud redis:// on plaintext unless REDIS_TLS=1", () => {
  const url = "redis://default:secret@example.db.redis.io:11943";
  assert.equal(redisUsesTls(url), false);
  assert.equal(withRedisTls(url), url);
  assert.equal(
    withRedisTls(url, { REDIS_TLS: "1" }),
    "rediss://default:secret@example.db.redis.io:11943",
  );
});

test("leaves local Redis on plaintext", () => {
  assert.equal(withRedisTls("redis://127.0.0.1:6379"), "redis://127.0.0.1:6379");
});

test("builds a Redis Cloud URL from endpoint + password", () => {
  assert.equal(
    buildRedisUrl({
      REDIS_ENDPOINT_URI: "example.db.redis.io:11943",
      REDIS_PASSWORD: "secret",
    }),
    "redis://default:secret@example.db.redis.io:11943",
  );
});

test("honors REDIS_URL when set", () => {
  assert.equal(
    buildRedisUrl({ REDIS_URL: "redis://127.0.0.1:6379" }),
    "redis://127.0.0.1:6379",
  );
});

test("keeps rediss:// URLs on TLS", () => {
  const url = "rediss://default:secret@example.db.redis.io:11943";
  assert.equal(redisUsesTls(url), true);
  assert.equal(buildRedisUrl({ REDIS_URL: url }), url);
});

import { getCachedContract, setCachedContract } from "../cache.js";
import { config } from "../config.js";
import { decodeClarityResult } from "../decoder.js";
import { serializeArgs } from "../encode.js";
import { callReadOnly, fetchAddressBalances, fetchTransaction, parseContractId, parseFunctionName } from "../hiro.js";
import { networkEnvelope, requestContext } from "../http.js";
import { networkFromPrincipal } from "../network.js";

function parseArgsInput(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        const error = new Error("args must be a JSON array");
        error.status = 400;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error.status) throw error;
      const bad = new Error("args must be valid JSON");
      bad.status = 400;
      throw bad;
    }
  }
  const error = new Error("args must be an array");
  error.status = 400;
  throw error;
}

function resolveReadTarget(req) {
  const params = req.params;
  const query = req.query;
  const body = req.body ?? {};
  const fromQuery = query.address ? String(query.address) : null;

  if (params.function && params.address && params.name) {
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(params.function),
    };
  }

  if (params.address && params.name) {
    if (String(params.address).includes(".")) {
      return {
        parsed: parseContractId(params.address),
        functionName: parseFunctionName(
          params.name ?? body.function ?? query.function ?? config.defaultReadFunction,
        ),
      };
    }
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(
        body.function ?? query.function ?? config.defaultReadFunction,
      ),
    };
  }

  return {
    parsed: parseContractId(params.contractId ?? fromQuery),
    functionName: parseFunctionName(
      body.function ?? query.function ?? config.defaultReadFunction,
    ),
  };
}

async function contractReadHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    const { parsed, functionName } = resolveReadTarget(req);
    const sender = String(req.body?.sender ?? req.query.sender ?? parsed.address);
    const args = parseArgsInput(req.body?.args ?? req.query.args);
    const argHexes = serializeArgs(args);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true" || req.body?.refresh === true;
    const cacheKey = `${parsed.contractId}:${functionName}:${sender}:${argHexes.join(",")}`;

    let payload = !refresh ? await getCachedContract(cacheKey, ctx) : null;
    if (payload && "clarity" in payload) {
      const { clarity, ...rest } = payload;
      payload = rest;
    }
    if (!payload) {
      const read = await callReadOnly({
        address: parsed.address,
        name: parsed.name,
        functionName,
        sender,
        arguments: argHexes,
      });
      const decoded = decodeClarityResult(read.result);
      payload = {
        ...networkEnvelope(ctx),
        network: networkFromPrincipal(parsed.address) ?? ctx.network,
        contractId: parsed.contractId,
        address: parsed.address,
        name: parsed.name,
        function: functionName,
        sender,
        args: argHexes,
        okay: read.okay,
        ok: decoded.ok,
        values: decoded.values,
        error: decoded.error ?? decoded.decodeError ?? null,
      };
      await setCachedContract(cacheKey, payload, ctx);
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
}

export function registerContractRoutes(app) {
  app.get("/contracts/:address/:name/:function", contractReadHandler);
  app.post("/contracts/:address/:name/:function", contractReadHandler);
  app.get("/contracts/:address/:name", contractReadHandler);
  app.post("/contracts/:address/:name", contractReadHandler);
  app.get("/contracts/:contractId", contractReadHandler);
  app.post("/contracts/:contractId", contractReadHandler);
  app.get("/contracts", (req, res, next) => {
    if (!req.query.address) {
      res.status(400).json({
        error:
          "Pass a contract address as ADDRESS.NAME via /contracts/:address/:name, /contracts/:address.name, or ?address=",
      });
      return;
    }
    contractReadHandler(req, res, next);
  });
  app.post("/contracts", (req, res, next) => {
    if (req.body?.address && !req.query.address) {
      req.query.address = String(req.body.address);
    }
    if (!req.query.address) {
      res.status(400).json({
        error: "Pass address as ADDRESS.NAME in the path, query, or JSON body",
      });
      return;
    }
    contractReadHandler(req, res, next);
  });

  app.get("/tx/:txId", async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      const txId = decodeURIComponent(req.params.txId);
      const tx = await fetchTransaction(txId, ctx.stacksApiUrl);
      res.json({ ...networkEnvelope(ctx), tx });
    } catch (error) {
      next(error);
    }
  });

  app.get("/balances/:address", async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      const address = decodeURIComponent(req.params.address);
      const unanchored = req.query.unanchored !== "0" && req.query.unanchored !== "false";
      const balances = await fetchAddressBalances(address, ctx.stacksApiUrl, { unanchored });
      res.json({ ...networkEnvelope(ctx), address, balances });
    } catch (error) {
      next(error);
    }
  });
}

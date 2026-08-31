import { ClarityType, deserializeCV } from "@stacks/transactions";

function normalizeHex(hex) {
  if (!hex || typeof hex !== "string") return hex;
  const trimmed = hex.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function bufferHex(cv) {
  const raw = cv.value ?? "";
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function unwrapOptional(cv) {
  if (!cv) return cv;
  if (cv.type === ClarityType.OptionalSome) return unwrapOptional(cv.value);
  return cv;
}

/**
 * Stackspots prints either:
 * - (optional (buff)) from `print (to-consensus-buff? { ... })`
 * - (buff 2048) from `print payload` / `emit-log`
 *
 * Peel those wrappers so the frontend sees the inner tuple.
 * Nested buffer *fields* (hashes, etc.) stay as hex.
 */
function peelPrintWrapper(cv, depth = 0) {
  if (!cv || depth > 6) return cv;
  if (cv.type === ClarityType.OptionalNone) return cv;
  if (cv.type === ClarityType.OptionalSome) {
    return peelPrintWrapper(cv.value, depth + 1);
  }
  if (cv.type === ClarityType.Buffer) {
    try {
      const inner = deserializeCV(bufferHex(cv));
      if (
        inner.type === ClarityType.Tuple ||
        inner.type === ClarityType.OptionalSome ||
        inner.type === ClarityType.List ||
        inner.type === ClarityType.Buffer
      ) {
        return peelPrintWrapper(inner, depth + 1);
      }
    } catch {
      return cv;
    }
  }
  return cv;
}

function principalToString(cv) {
  if (cv.type === ClarityType.PrincipalStandard) return cv.value;
  if (cv.type === ClarityType.PrincipalContract) return cv.value;
  return String(cv.value ?? "");
}

export function toTyped(cv) {
  if (!cv) return { type: "none", value: null };

  switch (cv.type) {
    case ClarityType.BoolTrue:
      return { type: "bool", value: true };
    case ClarityType.BoolFalse:
      return { type: "bool", value: false };
    case ClarityType.Int:
      return { type: "int", value: cv.value.toString() };
    case ClarityType.UInt:
      return { type: "uint", value: cv.value.toString() };
    case ClarityType.Buffer:
      return { type: "buff", value: bufferHex(cv) };
    case ClarityType.OptionalNone:
      return { type: "optional", value: null };
    case ClarityType.OptionalSome:
      return { type: "optional", value: toTyped(cv.value) };
    case ClarityType.ResponseOk:
      return { type: "response", ok: true, value: toTyped(cv.value) };
    case ClarityType.ResponseErr:
      return { type: "response", ok: false, value: toTyped(cv.value) };
    case ClarityType.PrincipalStandard:
    case ClarityType.PrincipalContract:
      return { type: "principal", value: principalToString(cv) };
    case ClarityType.List:
      return { type: "list", value: (cv.value ?? []).map((item) => toTyped(item)) };
    case ClarityType.Tuple: {
      const value = {};
      for (const [key, field] of Object.entries(cv.value ?? {})) {
        value[key] = toTyped(field);
      }
      return { type: "tuple", value };
    }
    case ClarityType.StringASCII:
      return { type: "string-ascii", value: cv.value };
    case ClarityType.StringUTF8:
      return { type: "string-utf8", value: cv.value };
    default:
      return { type: String(cv.type ?? "unknown"), value: cv.value ?? null };
  }
}

export function toPlain(cv) {
  if (!cv) return null;

  switch (cv.type) {
    case ClarityType.BoolTrue:
      return true;
    case ClarityType.BoolFalse:
      return false;
    case ClarityType.Int:
    case ClarityType.UInt:
      return cv.value.toString();
    case ClarityType.Buffer:
      return bufferHex(cv);
    case ClarityType.OptionalNone:
      return null;
    case ClarityType.OptionalSome:
      return toPlain(cv.value);
    case ClarityType.ResponseOk:
      return { ok: true, value: toPlain(cv.value) };
    case ClarityType.ResponseErr:
      return { ok: false, value: toPlain(cv.value) };
    case ClarityType.PrincipalStandard:
    case ClarityType.PrincipalContract:
      return principalToString(cv);
    case ClarityType.List:
      return (cv.value ?? []).map((item) => toPlain(item));
    case ClarityType.Tuple: {
      const value = {};
      for (const [key, field] of Object.entries(cv.value ?? {})) {
        value[key] = toPlain(field);
      }
      return value;
    }
    case ClarityType.StringASCII:
    case ClarityType.StringUTF8:
      return cv.value;
    default:
      if (cv.value == null) return null;
      if (typeof cv.value === "bigint") return cv.value.toString();
      return cv.value;
  }
}

export function decodePrintHex(hex) {
  if (!hex) {
    return { event: null, values: null, clarity: null };
  }

  let cv;
  try {
    cv = peelPrintWrapper(deserializeCV(normalizeHex(hex)));
  } catch (error) {
    return {
      event: null,
      values: null,
      clarity: null,
      decodeError: error.message,
    };
  }

  const clarity = toTyped(cv);
  const values = toPlain(cv);
  const event =
    values && typeof values === "object" && !Array.isArray(values) && typeof values.event === "string"
      ? values.event
      : null;

  return { event, values, clarity };
}

export function decodeClarityResult(hex) {
  if (!hex) {
    return { ok: false, values: null, clarity: null, decodeError: "Missing Clarity result hex" };
  }

  let cv;
  try {
    cv = deserializeCV(normalizeHex(hex));
  } catch (error) {
    return { ok: false, values: null, clarity: null, decodeError: error.message };
  }

  if (cv.type === ClarityType.ResponseOk) {
    return { ok: true, values: toPlain(cv.value), clarity: toTyped(cv.value) };
  }
  if (cv.type === ClarityType.ResponseErr) {
    return {
      ok: false,
      values: toPlain(cv.value),
      clarity: toTyped(cv.value),
      error: toPlain(cv.value),
    };
  }

  return { ok: true, values: toPlain(cv), clarity: toTyped(cv) };
}

export { peelPrintWrapper, unwrapOptional };

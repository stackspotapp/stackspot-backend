import { hexToBytes } from "@stacks/common";
import {
  bufferCV,
  falseCV,
  intCV,
  listCV,
  noneCV,
  principalCV,
  serializeCV,
  someCV,
  stringAsciiCV,
  stringUtf8CV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";

function asHex(serialized) {
  if (typeof serialized === "string") {
    return serialized.startsWith("0x") ? serialized : `0x${serialized}`;
  }
  const hex = Buffer.from(serialized).toString("hex");
  return `0x${hex}`;
}

function isHexCv(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function isPrincipal(value) {
  return (
    typeof value === "string" &&
    /^[S][A-Z0-9]{24,40}(\.[a-zA-Z][a-zA-Z0-9_-]{0,127})?$/.test(value)
  );
}

function bytesFromHex(hex) {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(raw);
}

export function encodeClarityValue(value) {
  if (value == null) return noneCV();

  if (typeof value === "boolean") return value ? trueCV() : falseCV();
  if (typeof value === "bigint") return uintCV(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 0 ? intCV(BigInt(value)) : uintCV(BigInt(value));
  }
  if (typeof value === "string") {
    if (/^-?\d+$/.test(value)) {
      return value.startsWith("-") ? intCV(BigInt(value)) : uintCV(BigInt(value));
    }
    if (isPrincipal(value)) return principalCV(value);
    return stringAsciiCV(value);
  }
  if (Array.isArray(value)) {
    return listCV(value.map((item) => encodeClarityValue(item)));
  }
  if (typeof value === "object" && value.type) {
    switch (String(value.type).toLowerCase()) {
      case "uint":
        return uintCV(BigInt(value.value));
      case "int":
        return intCV(BigInt(value.value));
      case "bool":
        return value.value ? trueCV() : falseCV();
      case "principal":
        return principalCV(String(value.value));
      case "buff":
      case "buffer":
        return bufferCV(bytesFromHex(String(value.value)));
      case "ascii":
      case "string-ascii":
        return stringAsciiCV(String(value.value));
      case "utf8":
      case "string-utf8":
        return stringUtf8CV(String(value.value));
      case "optional":
        return value.value == null ? noneCV() : someCV(encodeClarityValue(value.value));
      case "list":
        return listCV((value.value ?? []).map((item) => encodeClarityValue(item)));
      case "tuple":
        return tupleCV(
          Object.fromEntries(
            Object.entries(value.value ?? {}).map(([key, field]) => [key, encodeClarityValue(field)]),
          ),
        );
      default:
        break;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return tupleCV(
      Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, encodeClarityValue(field)]),
      ),
    );
  }

  const error = new Error(`Unable to encode Clarity argument: ${JSON.stringify(value)}`);
  error.status = 400;
  throw error;
}

export function serializeArg(value) {
  if (isHexCv(value)) return value.startsWith("0x") ? value : `0x${value}`;
  return asHex(serializeCV(encodeClarityValue(value)));
}

export function serializeArgs(args = []) {
  if (!Array.isArray(args)) {
    const error = new Error("args must be an array");
    error.status = 400;
    throw error;
  }
  return args.map(serializeArg);
}

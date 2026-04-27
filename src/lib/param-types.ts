export const PARAM_TYPES = Object.freeze({
  ANY: "any",
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  DATE: "date",
  JSON: "json"
});

const TYPE_ALIASES: Record<string, string> = Object.freeze({
  any: PARAM_TYPES.ANY,
  string: PARAM_TYPES.STRING,
  text: PARAM_TYPES.STRING,
  number: PARAM_TYPES.NUMBER,
  float: PARAM_TYPES.NUMBER,
  integer: PARAM_TYPES.INTEGER,
  int: PARAM_TYPES.INTEGER,
  boolean: PARAM_TYPES.BOOLEAN,
  bool: PARAM_TYPES.BOOLEAN,
  date: PARAM_TYPES.DATE,
  datetime: PARAM_TYPES.DATE,
  timestamp: PARAM_TYPES.DATE,
  json: PARAM_TYPES.JSON
});

export class SqlParamTypeError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SqlParamTypeError";
    this.details = details;
  }
}

export function normalizeParamType(type: string) {
  if (!type) return null;

  const normalized = TYPE_ALIASES[String(type).trim().toLowerCase()];
  if (!normalized) {
    throw new SqlParamTypeError(`structure error: unsupported param type: ${type}`, {
      category: "structure",
      type
    });
  }

  return normalized;
}

function isPlainJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === undefined) return false;
  if (value === null) return true;

  const valueType = typeof value;
  if (["string", "number", "boolean"].includes(valueType)) return true;

  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every(item => isPlainJsonValue(item, seen));
  }

  if (valueType === "object") {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) return false;
    seen.add(objectValue);
    return Object.values(objectValue).every(item => isPlainJsonValue(item, seen));
  }

  return false;
}

function isValueOfType(value: unknown, type: string) {
  if (value === undefined) return false;
  if (value === null || !type || type === PARAM_TYPES.ANY) return true;

  switch (type) {
    case PARAM_TYPES.STRING:
      return typeof value === "string";
    case PARAM_TYPES.NUMBER:
      return typeof value === "number" && Number.isFinite(value);
    case PARAM_TYPES.INTEGER:
      return Number.isSafeInteger(value);
    case PARAM_TYPES.BOOLEAN:
      return typeof value === "boolean";
    case PARAM_TYPES.DATE:
      return value instanceof Date || typeof value === "string";
    case PARAM_TYPES.JSON:
      return isPlainJsonValue(value);
    default:
      throw new SqlParamTypeError(`structure error: unsupported param type: ${type}`, {
        category: "structure",
        type
      });
  }
}

type ParamDef = {
  name: string;
  type?: string;
};

export function buildParamTypeMap(paramDefs: ParamDef[] = []) {
  const out: Record<string, string> = {};

  for (const def of paramDefs) {
    if (def && def.type) {
      out[def.name] = def.type;
    }
  }

  return out;
}

export function validateParamTypes(
  params: Record<string, unknown> = {},
  paramTypes: Record<string, string> = {},
  details: Record<string, unknown> = {}
) {
  for (const [name, type] of Object.entries(paramTypes)) {
    if (!(name in params)) continue;

    const value = params[name];
    if (!isValueOfType(value, type)) {
      throw new SqlParamTypeError(`input error: invalid type for param: ${name}`, {
        category: "input",
        ...details,
        paramName: name,
        expected: type,
        actual: Array.isArray(value) ? "array" : typeof value
      });
    }
  }
}

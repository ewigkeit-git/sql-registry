const PARAM_TYPES = Object.freeze({
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
  json: PARAM_TYPES.JSON
});

class SqlParamTypeError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SqlParamTypeError";
    this.details = details;
  }
}

function normalizeParamType(type: string) {
  if (!type) return null;

  const normalized = TYPE_ALIASES[String(type).trim().toLowerCase()];
  if (!normalized) {
    throw new SqlParamTypeError(`unsupported param type: ${type}`, {
      type
    });
  }

  return normalized;
}

function isPlainJsonValue(value: unknown): boolean {
  if (value == null) return true;

  const valueType = typeof value;
  if (["string", "number", "boolean"].includes(valueType)) return true;

  if (Array.isArray(value)) {
    return value.every(isPlainJsonValue);
  }

  if (valueType === "object") {
    return Object.values(value).every(isPlainJsonValue);
  }

  return false;
}

function isValueOfType(value: unknown, type: string) {
  if (value == null || !type || type === PARAM_TYPES.ANY) return true;

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
      throw new SqlParamTypeError(`unsupported param type: ${type}`, {
        type
      });
  }
}

type ParamDef = {
  name: string;
  type?: string;
};

function buildParamTypeMap(paramDefs: ParamDef[] = []) {
  const out: Record<string, string> = {};

  for (const def of paramDefs) {
    if (def && def.type) {
      out[def.name] = def.type;
    }
  }

  return out;
}

function validateParamTypes(params: Record<string, unknown> = {}, paramTypes: Record<string, string> = {}) {
  for (const [name, type] of Object.entries(paramTypes)) {
    if (!(name in params)) continue;

    const value = params[name];
    if (!isValueOfType(value, type)) {
      throw new SqlParamTypeError(`invalid type for param: ${name}`, {
        paramName: name,
        expected: type,
        actual: Array.isArray(value) ? "array" : typeof value
      });
    }
  }
}

module.exports = {
  PARAM_TYPES,
  SqlParamTypeError,
  normalizeParamType,
  buildParamTypeMap,
  validateParamTypes
};

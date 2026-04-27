export class SqlBindError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SqlBindError";
    this.details = details;
  }
}

export function validateBindParams(sql: string, paramNames: string[], params: Record<string, unknown> = {}, options: { strict?: boolean } = {}) {
  const { strict = true } = options;

  const missing = paramNames.filter(name => !(name in params));
  if (missing.length > 0) {
    throw new SqlBindError(`missing params: ${missing.join(", ")}`, {
      missing,
      sql
    });
  }

  if (strict) {
    const extra = Object.keys(params).filter(name => !paramNames.includes(name));
    if (extra.length > 0) {
      throw new SqlBindError(`unknown params: ${extra.join(", ")}`, {
        extra,
        sql
      });
    }
  }
}

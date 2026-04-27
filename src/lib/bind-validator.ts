export class SqlBindError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message.startsWith("input error:") ? message : `input error: ${message}`);
    this.name = "SqlBindError";
    this.details = {
      category: "input",
      ...details
    };
  }
}

export function validateBindParams(
  sql: string,
  paramNames: string[],
  params: Record<string, unknown> = {},
  options: { strict?: boolean; queryName?: string; dialect?: string } = {}
) {
  const { strict = true } = options;

  const missing = paramNames.filter(name => !(name in params));
  if (missing.length > 0) {
    throw new SqlBindError(`missing params: ${missing.join(", ")}`, {
      queryName: options.queryName,
      dialect: options.dialect,
      missing,
      sql
    });
  }

  if (strict) {
    const extra = Object.keys(params).filter(name => !paramNames.includes(name));
    if (extra.length > 0) {
      throw new SqlBindError(`unknown params: ${extra.join(", ")}`, {
        queryName: options.queryName,
        dialect: options.dialect,
        extra,
        sql
      });
    }
  }
}

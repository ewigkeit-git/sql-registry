import { getExplainPrefix } from "./dialect";

type SqlStatement = {
  sql: string;
  values?: unknown[];
};

type ExplainOptions = {
  dialect?: string;
  analyze?: boolean;
};

export function buildExplain(stmt: SqlStatement, options: ExplainOptions = {}): { sql: string; values: unknown[] } {
  const {
    dialect = "sqlite",
    analyze = false
  } = options;

  if (!stmt || !stmt.sql) {
    throw new Error("stmt.sql is required");
  }

  const prefix = getExplainPrefix(dialect, { analyze });

  return {
    sql: `${prefix} ${stmt.sql}`,
    values: stmt.values || []
  };
}

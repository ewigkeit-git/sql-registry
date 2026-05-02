export const DIALECT = Object.freeze({
  SQLITE: "sqlite",
  MYSQL: "mysql",
  PG: "pg"
});

export type Dialect = typeof DIALECT[keyof typeof DIALECT];
export type PlaceholderStyle = "question" | "numbered";

export function normalizeDialect(input?: string) {
  if (!input) return DIALECT.SQLITE;

  const v = String(input).toLowerCase();

  if (["sqlite", "sqlite3"].includes(v)) return DIALECT.SQLITE;
  if (["mysql", "mysql2", "mariadb"].includes(v)) return DIALECT.MYSQL;
  if (["pg", "postgres", "postgresql"].includes(v)) return DIALECT.PG;

  throw new Error(`unsupported dialect: ${input}`);
}

export function normalizeStatementDialect(input?: string) {
  return input === "default" ? DIALECT.SQLITE : normalizeDialect(input);
}

export function getPlaceholderStyle(input?: string): PlaceholderStyle {
  const dialect = normalizeStatementDialect(input);
  return dialect === DIALECT.PG ? "numbered" : "question";
}

export function getExplainPrefix(input?: string, options: { analyze?: boolean } = {}) {
  const dialect = normalizeStatementDialect(input);
  const analyze = options.analyze === true;

  switch (dialect) {
    case DIALECT.SQLITE:
      return analyze ? "EXPLAIN QUERY PLAN" : "EXPLAIN";

    case DIALECT.PG:
      return analyze ? "EXPLAIN ANALYZE" : "EXPLAIN";

    case DIALECT.MYSQL:
      return "EXPLAIN";

    default:
      throw new Error(`unsupported dialect: ${dialect}`);
  }
}

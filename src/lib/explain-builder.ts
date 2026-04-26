const { DIALECT, normalizeDialect } = require("./dialect");

type SqlStatement = {
  sql: string;
  values?: unknown[];
};

type ExplainOptions = {
  dialect?: string;
  analyze?: boolean;
};

function buildExplain(stmt: SqlStatement, options: ExplainOptions = {}) {
  const {
    dialect = "sqlite",
    analyze = false
  } = options;

  if (!stmt || !stmt.sql) {
    throw new Error("stmt.sql is required");
  }

  const normalizedDialect = dialect === "default"
    ? DIALECT.SQLITE
    : normalizeDialect(dialect);
  let prefix;

  switch (normalizedDialect) {
    case DIALECT.SQLITE:
      prefix = analyze ? "EXPLAIN QUERY PLAN" : "EXPLAIN";
      break;

    case DIALECT.PG:
      prefix = analyze ? "EXPLAIN ANALYZE" : "EXPLAIN";
      break;

    case DIALECT.MYSQL:
      prefix = "EXPLAIN";
      break;

    default:
      throw new Error(`unsupported dialect: ${normalizedDialect}`);
  }

  return {
    sql: `${prefix} ${stmt.sql}`,
    values: stmt.values || []
  };
}

module.exports = {
  buildExplain
};

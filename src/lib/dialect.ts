const DIALECT = Object.freeze({
  SQLITE: "sqlite",
  MYSQL: "mysql",
  PG: "pg"
});

function normalizeDialect(input?: string) {
  if (!input) return DIALECT.SQLITE;

  const v = String(input).toLowerCase();

  if (["sqlite", "sqlite3"].includes(v)) return DIALECT.SQLITE;
  if (["mysql", "mysql2"].includes(v)) return DIALECT.MYSQL;
  if (["pg", "postgres", "postgresql"].includes(v)) return DIALECT.PG;

  throw new Error(`unsupported dialect: ${input}`);
}

module.exports = {
  DIALECT,
  normalizeDialect
};

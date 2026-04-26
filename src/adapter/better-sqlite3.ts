const { SqlRegistryAdapter } = require("./base");

const DEFAULT_METHOD = "all";
const WRITE_METHOD = "run";
const METHODS = new Set(["all", "get", "run", "iterate"]);
const STATEMENT_OPTIONS = ["raw", "pluck", "expand", "safeIntegers"];
const WRITE_PREFIXES = ["INSERT", "UPDATE", "DELETE", "REPLACE"];

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type BetterSqlite3Statement = {
  [name: string]: unknown;
};

type BetterSqlite3Database = {
  prepare: (sql: string) => BetterSqlite3Statement;
};

type BetterSqlite3Options = {
  queryOptions?: Record<string, unknown>;
  method?: string;
  [name: string]: unknown;
};

class BetterSqlite3Adapter extends SqlRegistryAdapter {
  db: BetterSqlite3Database | null;

  constructor(dbOrRegistry: unknown, registryOrOptions: unknown = {}, options: BetterSqlite3Options = {}) {
    if (isDatabaseLike(dbOrRegistry)) {
      super(registryOrOptions, options);
      this.db = dbOrRegistry;
      return;
    }

    super(dbOrRegistry, registryOrOptions);
    this.db = null;
  }

  async query(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    const { db, name, options } = this.resolveQueryArgs(dbOrName, nameOrOptions, maybeOptions);
    return super.query(db, name, options);
  }

  async explain(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    const { db, name, options } = this.resolveQueryArgs(dbOrName, nameOrOptions, maybeOptions);
    return super.explain(db, name, options);
  }

  async execute(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    const { db, builder, options } = this.resolveBuilderArgs(dbOrBuilder, builderOrOptions, maybeOptions);
    return super.execute(db, builder, options);
  }

  async executeExplain(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    const { db, builder, options } = this.resolveBuilderArgs(dbOrBuilder, builderOrOptions, maybeOptions);
    return super.executeExplain(db, builder, options);
  }

  executeStatement(db: BetterSqlite3Database | null | undefined, stmt: SqlStatement, options: BetterSqlite3Options = {}) {
    const database = db || this.getDatabase();
    assertDatabase(database);

    const queryOptions = options.queryOptions || {};
    const methodValue = queryOptions.method || options.method || inferMethod(stmt.sql);
    const method = String(methodValue);

    if (!METHODS.has(method)) {
      throw new Error(`unsupported better-sqlite3 method: ${method}`);
    }

    const statement = applyStatementOptions(database.prepare(stmt.sql), queryOptions);
    const statementMethod = statement[method];
    if (typeof statementMethod !== "function") {
      throw new Error(`better-sqlite3 statement method is not supported: ${method}`);
    }
    return statementMethod.call(statement, ...stmt.values);
  }

  resolveQueryArgs(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    if (isDatabaseLike(dbOrName)) {
      return {
        db: dbOrName,
        name: String(nameOrOptions),
        options: maybeOptions || {}
      };
    }

    return {
      db: this.getDatabase(),
      name: String(dbOrName),
      options: nameOrOptions || {}
    };
  }

  resolveBuilderArgs(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: BetterSqlite3Options) {
    if (isDatabaseLike(dbOrBuilder)) {
      return {
        db: dbOrBuilder,
        builder: builderOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      db: this.getDatabase(),
      builder: dbOrBuilder,
      options: builderOrOptions || {}
    };
  }

  getDatabase() {
    assertDatabase(this.db);
    return this.db;
  }
}

function inferMethod(sql: string) {
  const normalized = sql.trimStart().toUpperCase();

  for (const prefix of WRITE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return WRITE_METHOD;
    }
  }

  return DEFAULT_METHOD;
}

function isDatabaseLike(value: unknown): value is BetterSqlite3Database {
  return typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof value.prepare === "function";
}

function assertDatabase(db: unknown): asserts db is BetterSqlite3Database {
  if (!isDatabaseLike(db)) {
    throw new Error("better-sqlite3 database with prepare(sql) is required");
  }
}

function applyStatementOptions(statement: BetterSqlite3Statement, queryOptions: Record<string, unknown>) {
  let current = statement;

  for (const name of STATEMENT_OPTIONS) {
    if (!(name in queryOptions) || queryOptions[name] === false) {
      continue;
    }

    const optionFn = current[name];
    if (typeof optionFn !== "function") {
      throw new Error(`better-sqlite3 statement option is not supported: ${name}`);
    }

    current = queryOptions[name] === true
      ? optionFn.call(current)
      : optionFn.call(current, queryOptions[name]);
  }

  return current;
}

module.exports = {
  BetterSqlite3Adapter
};

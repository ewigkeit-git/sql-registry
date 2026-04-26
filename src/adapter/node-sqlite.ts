const { SqlRegistryAdapter } = require("./base");

const DEFAULT_METHOD = "all";
const WRITE_METHOD = "run";
const METHODS = new Set(["all", "get", "run", "iterate"]);
const STATEMENT_OPTIONS = [
  "setAllowBareNamedParameters",
  "setAllowUnknownNamedParameters",
  "setReturnArrays",
  "setReadBigInts"
];
const WRITE_PREFIXES = ["INSERT", "UPDATE", "DELETE", "REPLACE"];

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type NodeSqliteStatement = {
  [name: string]: unknown;
};

type NodeSqliteDatabase = {
  prepare: (sql: string) => NodeSqliteStatement;
};

type NodeSqliteOptions = {
  queryOptions?: Record<string, unknown>;
  method?: string;
  [name: string]: unknown;
};

class NodeSqliteAdapter extends SqlRegistryAdapter {
  db: NodeSqliteDatabase | null;

  constructor(dbOrRegistry: unknown, registryOrOptions: unknown = {}, options: NodeSqliteOptions = {}) {
    if (isDatabaseLike(dbOrRegistry)) {
      super(registryOrOptions, options);
      this.db = dbOrRegistry;
      return;
    }

    super(dbOrRegistry, registryOrOptions);
    this.db = null;
  }

  async query(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
    const { db, name, options } = this.resolveQueryArgs(dbOrName, nameOrOptions, maybeOptions);
    return super.query(db, name, options);
  }

  async explain(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
    const { db, name, options } = this.resolveQueryArgs(dbOrName, nameOrOptions, maybeOptions);
    return super.explain(db, name, options);
  }

  async execute(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
    const { db, builder, options } = this.resolveBuilderArgs(dbOrBuilder, builderOrOptions, maybeOptions);
    return super.execute(db, builder, options);
  }

  async executeExplain(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
    const { db, builder, options } = this.resolveBuilderArgs(dbOrBuilder, builderOrOptions, maybeOptions);
    return super.executeExplain(db, builder, options);
  }

  executeStatement(db: NodeSqliteDatabase | null | undefined, stmt: SqlStatement, options: NodeSqliteOptions = {}) {
    const database = db || this.getDatabase();
    assertDatabase(database);

    const queryOptions = options.queryOptions || {};
    const methodValue = queryOptions.method || options.method || inferMethod(stmt.sql);
    const method = String(methodValue);

    if (!METHODS.has(method)) {
      throw new Error(`unsupported node:sqlite method: ${method}`);
    }

    const statement = applyStatementOptions(database.prepare(stmt.sql), queryOptions);
    const statementMethod = statement[method];
    if (typeof statementMethod !== "function") {
      throw new Error(`node:sqlite statement method is not supported: ${method}`);
    }
    return statementMethod.call(statement, ...stmt.values);
  }

  resolveQueryArgs(dbOrName: unknown, nameOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
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

  resolveBuilderArgs(dbOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: NodeSqliteOptions) {
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

function isDatabaseLike(value: unknown): value is NodeSqliteDatabase {
  return typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof value.prepare === "function";
}

function assertDatabase(db: unknown): asserts db is NodeSqliteDatabase {
  if (!isDatabaseLike(db)) {
    throw new Error("node:sqlite DatabaseSync with prepare(sql) is required");
  }
}

function applyStatementOptions(statement: NodeSqliteStatement, queryOptions: Record<string, unknown>) {
  for (const name of STATEMENT_OPTIONS) {
    if (!(name in queryOptions)) {
      continue;
    }

    const optionFn = statement[name];
    if (typeof optionFn !== "function") {
      throw new Error(`node:sqlite statement option is not supported: ${name}`);
    }

    optionFn.call(statement, queryOptions[name]);
  }

  return statement;
}

module.exports = {
  NodeSqliteAdapter
};

import { SqlBuilderLike, SqlRegistryAdapter, SqlRegistryLike } from "./base";

const DEFAULT_METHOD = "execute";
const METHODS = new Set(["execute", "query"]);

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type Mysql2Like = {
  execute?: (sqlOrOptions: string | Record<string, unknown>, values?: unknown[]) => unknown;
  query?: (sqlOrOptions: string | Record<string, unknown>, values?: unknown[]) => unknown;
};

type Mysql2Options = {
  queryOptions?: Record<string, unknown>;
  method?: string;
  [name: string]: unknown;
};

export class Mysql2Adapter extends SqlRegistryAdapter {
  connection: Mysql2Like | null;

  constructor(connectionOrRegistry: unknown, registryOrOptions: unknown = {}, options: Mysql2Options = {}) {
    if (isMysql2Like(connectionOrRegistry)) {
      super(registryOrOptions as SqlRegistryLike, options);
      this.connection = connectionOrRegistry;
      return;
    }

    super(connectionOrRegistry as SqlRegistryLike, registryOrOptions as Record<string, unknown>);
    this.connection = null;
  }

  async query(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    const { connection, name, options } = this.resolveQueryArgs(
      connectionOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.query(connection, String(name), options);
  }

  async explain(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    const { connection, name, options } = this.resolveQueryArgs(
      connectionOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.explain(connection, String(name), options);
  }

  async execute(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    const { connection, builder, options } = this.resolveBuilderArgs(
      connectionOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.execute(connection, builder as SqlBuilderLike, options);
  }

  async executeExplain(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    const { connection, builder, options } = this.resolveBuilderArgs(
      connectionOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.executeExplain(connection, builder as SqlBuilderLike, options);
  }

  executeStatement(connection: Mysql2Like | null | undefined, stmt: SqlStatement, options: Mysql2Options = {}) {
    const instance = connection || this.getConnection();
    assertMysql2(instance);

    const queryOptions = options.queryOptions || {};
    if ("sql" in queryOptions || "values" in queryOptions) {
      throw new Error("input error: queryOptions.sql and queryOptions.values are managed by Mysql2Adapter");
    }

    const method = String(options.method || queryOptions.method || DEFAULT_METHOD);
    if (!METHODS.has(method)) {
      throw new Error(`input error: unsupported mysql2 method: ${method}`);
    }

    const methodFn = instance[method as "execute" | "query"];
    if (typeof methodFn !== "function") {
      throw new Error(`input error: mysql2 connection method is not supported: ${method}`);
    }

    if (Object.keys(queryOptions).length > 0) {
      const { method: _method, ...queryConfig } = queryOptions;
      return methodFn.call(instance, {
        ...queryConfig,
        sql: stmt.sql
      }, stmt.values);
    }

    return methodFn.call(instance, stmt.sql, stmt.values);
  }

  resolveQueryArgs(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    if (isMysql2Like(connectionOrName)) {
      return {
        connection: connectionOrName,
        name: nameOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      connection: this.getConnection(),
      name: connectionOrName,
      options: nameOrOptions || {}
    };
  }

  resolveBuilderArgs(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: Mysql2Options) {
    if (isMysql2Like(connectionOrBuilder)) {
      return {
        connection: connectionOrBuilder,
        builder: builderOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      connection: this.getConnection(),
      builder: connectionOrBuilder,
      options: builderOrOptions || {}
    };
  }

  getConnection() {
    assertMysql2(this.connection);
    return this.connection;
  }
}

function isMysql2Like(value: unknown): value is Mysql2Like {
  return typeof value === "object" &&
    value !== null &&
    (
      ("execute" in value && typeof (value as Record<string, unknown>).execute === "function") ||
      ("query" in value && typeof (value as Record<string, unknown>).query === "function")
    );
}

function assertMysql2(connection: unknown): asserts connection is Mysql2Like {
  if (!isMysql2Like(connection)) {
    throw new Error("input error: mysql2 connection or pool with execute(sql, values) or query(sql, values) is required");
  }
}

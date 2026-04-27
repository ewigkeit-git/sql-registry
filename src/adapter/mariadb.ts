import { SqlBuilderLike, SqlRegistryAdapter, SqlRegistryLike } from "./base";

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type MariadbLike = {
  query: (sqlOrOptions: string | Record<string, unknown>, values?: unknown[]) => unknown;
};

type MariadbOptions = {
  queryOptions?: Record<string, unknown>;
  [name: string]: unknown;
};

export class MariadbAdapter extends SqlRegistryAdapter {
  connection: MariadbLike | null;

  constructor(connectionOrRegistry: unknown, registryOrOptions: unknown = {}, options: MariadbOptions = {}) {
    if (isMariadbLike(connectionOrRegistry)) {
      super(registryOrOptions as SqlRegistryLike, options);
      this.connection = connectionOrRegistry;
      return;
    }

    super(connectionOrRegistry as SqlRegistryLike, registryOrOptions as Record<string, unknown>);
    this.connection = null;
  }

  async query(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    const { connection, name, options } = this.resolveQueryArgs(
      connectionOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.query(connection, String(name), options);
  }

  async explain(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    const { connection, name, options } = this.resolveQueryArgs(
      connectionOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.explain(connection, String(name), options);
  }

  async execute(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    const { connection, builder, options } = this.resolveBuilderArgs(
      connectionOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.execute(connection, builder as SqlBuilderLike, options);
  }

  async executeExplain(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    const { connection, builder, options } = this.resolveBuilderArgs(
      connectionOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.executeExplain(connection, builder as SqlBuilderLike, options);
  }

  executeStatement(connection: MariadbLike | null | undefined, stmt: SqlStatement, options: MariadbOptions = {}) {
    const instance = connection || this.getConnection();
    assertMariadb(instance);

    const queryOptions = options.queryOptions || {};
    if ("sql" in queryOptions || "values" in queryOptions) {
      throw new Error("input error: queryOptions.sql and queryOptions.values are managed by MariadbAdapter");
    }

    if (Object.keys(queryOptions).length > 0) {
      return instance.query({
        ...queryOptions,
        sql: stmt.sql
      }, stmt.values);
    }

    return instance.query(stmt.sql, stmt.values);
  }

  resolveQueryArgs(connectionOrName: unknown, nameOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    if (isMariadbLike(connectionOrName)) {
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

  resolveBuilderArgs(connectionOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: MariadbOptions) {
    if (isMariadbLike(connectionOrBuilder)) {
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
    assertMariadb(this.connection);
    return this.connection;
  }
}

function isMariadbLike(value: unknown): value is MariadbLike {
  return typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "function";
}

function assertMariadb(connection: unknown): asserts connection is MariadbLike {
  if (!isMariadbLike(connection)) {
    throw new Error("input error: mariadb connection or pool with query(sql, values) is required");
  }
}

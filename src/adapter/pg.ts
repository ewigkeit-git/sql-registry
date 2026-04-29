import { SqlBuilderLike, SqlRegistryAdapter, SqlRegistryLike } from "./base";

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type PgLike = {
  query: (textOrConfig: string | Record<string, unknown>, values?: unknown[]) => unknown;
};

type PgOptions = {
  queryOptions?: Record<string, unknown>;
  [name: string]: unknown;
};

export class PgAdapter extends SqlRegistryAdapter {
  client: PgLike | null;

  constructor(clientOrRegistry: unknown, registryOrOptions: unknown = {}, options: PgOptions = {}) {
    if (isPgLike(clientOrRegistry)) {
      super(registryOrOptions as SqlRegistryLike, options);
      this.client = clientOrRegistry;
      return;
    }

    super(clientOrRegistry as SqlRegistryLike, registryOrOptions as Record<string, unknown>);
    this.client = null;
  }

  async query(clientOrName: unknown, nameOrOptions?: unknown, maybeOptions?: PgOptions) {
    const { client, name, options } = this.resolveQueryArgs(
      clientOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.query(client, String(name), options);
  }

  async explain(clientOrName: unknown, nameOrOptions?: unknown, maybeOptions?: PgOptions) {
    const { client, name, options } = this.resolveQueryArgs(
      clientOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.explain(client, String(name), options);
  }

  async execute(clientOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: PgOptions) {
    const { client, builder, options } = this.resolveBuilderArgs(
      clientOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.execute(client, builder as SqlBuilderLike, options);
  }

  async executeExplain(clientOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: PgOptions) {
    const { client, builder, options } = this.resolveBuilderArgs(
      clientOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.executeExplain(client, builder as SqlBuilderLike, options);
  }

  executeStatement(client: PgLike | null | undefined, stmt: SqlStatement, options: PgOptions = {}) {
    const instance = client || this.getClient();
    assertPg(instance);

    const queryOptions = options.queryOptions || {};
    if ("text" in queryOptions || "values" in queryOptions) {
      throw new Error("input error: queryOptions.text and queryOptions.values are managed by PgAdapter");
    }

    if (Object.keys(queryOptions).length > 0) {
      return instance.query({
        ...queryOptions,
        text: stmt.sql
      }, stmt.values);
    }

    return instance.query(stmt.sql, stmt.values);
  }

  resolveQueryArgs(clientOrName: unknown, nameOrOptions?: unknown, maybeOptions?: PgOptions) {
    if (isPgLike(clientOrName)) {
      return {
        client: clientOrName,
        name: nameOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      client: this.getClient(),
      name: clientOrName,
      options: nameOrOptions || {}
    };
  }

  resolveBuilderArgs(clientOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: PgOptions) {
    if (isPgLike(clientOrBuilder)) {
      return {
        client: clientOrBuilder,
        builder: builderOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      client: this.getClient(),
      builder: clientOrBuilder,
      options: builderOrOptions || {}
    };
  }

  getClient() {
    assertPg(this.client);
    return this.client;
  }
}

function isPgLike(value: unknown): value is PgLike {
  return typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "function";
}

function assertPg(client: unknown): asserts client is PgLike {
  if (!isPgLike(client)) {
    throw new Error("input error: pg Client or Pool with query(sql, values) is required");
  }
}

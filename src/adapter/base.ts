import { extractNamedParams } from "../lib/param-parser";

export type SqlStatement = {
  sql: string;
  values: unknown[];
};

export type AdapterOptions = {
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;
  buildOptions?: {
    strict?: boolean;
  };
  explainOptions?: Record<string, unknown>;
  queryOptions?: Record<string, unknown>;
  method?: string;
};

export type SqlBuilderLike = {
  baseSql: string;
  addParams: (params: Record<string, unknown>) => SqlBuilderLike;
  build: (options?: Record<string, unknown>) => SqlStatement;
  buildExplain: (options?: Record<string, unknown>) => SqlStatement;
};

export type SqlRegistryLike = {
  builder: (name: string, options?: AdapterOptions) => SqlBuilderLike;
};

export class SqlRegistryAdapter {
  registry: SqlRegistryLike;
  defaultContext: Record<string, unknown>;

  constructor(registry: SqlRegistryLike, options: AdapterOptions = {}) {
    if (!registry) {
      throw new Error("registry is required");
    }

    this.registry = registry;
    this.defaultContext = options.context || {};
  }

  createBuilder(name: string, options: AdapterOptions = {}) {
    const builder = this.registry.builder(name, {
      ...options,
      context: {
        ...this.defaultContext,
        ...(options.context || {})
      }
    });

    const sqlParamNames = extractNamedParams(builder.baseSql);
    const bindParams: Record<string, unknown> = {};

    for (const name of sqlParamNames) {
      if (options.params && name in options.params) {
        bindParams[name] = options.params[name];
      }
    }

    builder.addParams(bindParams);
    return builder;
  }

  build(name: string, options: AdapterOptions = {}) {
    return this.createBuilder(name, options).build(options.buildOptions || {});
  }

  buildExplain(name: string, options: AdapterOptions = {}) {
    return this.createBuilder(name, options).buildExplain(options.explainOptions || {});
  }

  async query(executor: unknown, name: string, options: AdapterOptions = {}): Promise<unknown> {
    const stmt = this.build(name, options);
    return this.executeStatement(executor, stmt, options);
  }

  async explain(executor: unknown, name: string, options: AdapterOptions = {}): Promise<unknown> {
    const stmt = this.buildExplain(name, options);
    return this.executeStatement(executor, stmt, options);
  }

  async execute(executor: unknown, builder: SqlBuilderLike, options: AdapterOptions = {}): Promise<unknown> {
    const stmt = builder.build(options.buildOptions || {});
    return this.executeStatement(executor, stmt, options);
  }

  async executeExplain(executor: unknown, builder: SqlBuilderLike, options: AdapterOptions = {}): Promise<unknown> {
    const stmt = builder.buildExplain(options.explainOptions || {});
    return this.executeStatement(executor, stmt, options);
  }

  executeStatement(_executor?: unknown, _stmt?: SqlStatement, _options?: AdapterOptions): unknown {
    throw new Error("executeStatement(executor, stmt, options) must be implemented");
  }
}

export type Dialect = "sqlite" | "mysql" | "pg";
export type ParamType =
  | "any"
  | "string"
  | "text"
  | "number"
  | "float"
  | "integer"
  | "int"
  | "boolean"
  | "bool"
  | "date"
  | "datetime"
  | "timestamp"
  | "json";

export type SqlStatement = {
  sql: string;
  values: unknown[];
};

export type ParamMeta = {
  name: string;
  description: string;
  type?: ParamType;
};

export type QueryMeta = {
  description?: string;
  tags?: string[];
  params: ParamMeta[];
  orderable?: Record<string, string>;
  builder?: string;
};

export type QueryEntry = {
  meta: QueryMeta;
  sql: Record<string, string>;
};

export type SqlRegistryOptions = {
  strict?: boolean;
  dialect?: Dialect | "sqlite3" | "mysql2" | "postgres" | "postgresql";
  compiledSqlCacheSize?: number;
};

export type BindOptions = {
  strict?: boolean;
  dialect?: SqlRegistryOptions["dialect"];
  compiledSqlCacheSize?: number;
};

export type BuilderOptions = {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  orderable?: Record<string, string>;
  dialect?: SqlRegistryOptions["dialect"];
  compiledSqlCacheSize?: number;
  runScript?: boolean;
  maxLimit?: number;
  maxOffset?: number;
};

export type ExplainOptions = {
  dialect?: SqlRegistryOptions["dialect"];
  analyze?: boolean;
};

export class SqlRegistryError extends Error {
  details: Record<string, unknown>;
}

export class SqlRegistryValidationError extends SqlRegistryError {
  errors: string[];
}

export class SqlBuilderError extends Error {
  details: Record<string, unknown>;
}

export type BuilderSlotApi = {
  append(sql: string, params?: Record<string, unknown>): SqlBuilder;
  appendIf(condition: unknown, sql: string, params?: Record<string, unknown>): SqlBuilder;
  appendQuery(queryName: string, params?: Record<string, unknown>): SqlBuilder;
  appendQueryIf(condition: unknown, queryName: string, params?: Record<string, unknown>): SqlBuilder;
};

export class SqlBuilder {
  constructor(
    registry: SqlRegistry | null,
    queryName: string,
    baseSql: string,
    options?: BuilderOptions
  );

  at(slotName: string): BuilderSlotApi;
  append(slotName: string, sql: string, params?: Record<string, unknown>): this;
  appendIf(slotName: string, condition: unknown, sql: string, params?: Record<string, unknown>): this;
  appendQuery(slotName: string, queryName: string, params?: Record<string, unknown>): this;
  appendQueryIf(slotName: string, condition: unknown, queryName: string, params?: Record<string, unknown>): this;
  addParams(params?: Record<string, unknown>): this;
  set(sql: string, params?: Record<string, unknown>): this;
  setIf(condition: unknown, sql: string, params?: Record<string, unknown>): this;
  orderBy(slotName: string, columnKey: string, asc?: boolean): this;
  limit(slotName: string, value: number | string | null | undefined): this;
  offset(slotName: string, value: number | string | null | undefined): this;
  toSql(): string;
  build(options?: BindOptions): SqlStatement;
  buildExplain(options?: ExplainOptions): SqlStatement;
}

export class SqlRegistry {
  constructor(options?: SqlRegistryOptions);

  strict: boolean;
  dialect: Dialect;
  queries: Record<string, QueryEntry>;
  files: string[];

  loadFile(filePath: string): this;
  reload(): this;
  has(name: string): boolean;
  get(name: string): QueryEntry;
  getMeta(name: string): QueryMeta;
  getSql(name: string): string;
  isStatic(name: string): boolean;
  bind(name: string, params?: Record<string, unknown>, options?: BindOptions): SqlStatement;
  builder(name: string, options?: BuilderOptions): SqlBuilder;
  list(): string[];
  toJSON(): {
    files: string[];
    queries: Record<string, QueryEntry>;
  };
}

export class SqlRegistryAdapter {
  constructor(registry: SqlRegistry, options?: { context?: Record<string, unknown> });

  createBuilder(name: string, options?: BuilderOptions): SqlBuilder;
  build(name: string, options?: BuilderOptions & { buildOptions?: BindOptions }): SqlStatement;
  buildExplain(name: string, options?: BuilderOptions & { explainOptions?: ExplainOptions }): SqlStatement;
  query(executor: unknown, name: string, options?: BuilderOptions): Promise<unknown>;
  explain(executor: unknown, name: string, options?: BuilderOptions & { explainOptions?: ExplainOptions }): Promise<unknown>;
  execute(executor: unknown, builder: SqlBuilder, options?: { buildOptions?: BindOptions }): Promise<unknown>;
  executeExplain(executor: unknown, builder: SqlBuilder, options?: { explainOptions?: ExplainOptions }): Promise<unknown>;
}

export class BetterSqlite3Adapter extends SqlRegistryAdapter {}
export class MariadbAdapter extends SqlRegistryAdapter {}
export class Mysql2Adapter extends SqlRegistryAdapter {}
export class NodeSqliteAdapter extends SqlRegistryAdapter {}
export class PgAdapter extends SqlRegistryAdapter {}
export class SequelizeAdapter extends SqlRegistryAdapter {}
export class TypeOrmAdapter extends SqlRegistryAdapter {}

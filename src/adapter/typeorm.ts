import { SqlBuilderLike, SqlRegistryAdapter, SqlRegistryLike } from "./base";

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type TypeOrmQueryExecutor = {
  query: (sql: string, values?: unknown[]) => unknown;
};

type TypeOrmDataSourceLike = {
  manager: TypeOrmQueryExecutor;
};

type TypeOrmExecutorLike = TypeOrmQueryExecutor | TypeOrmDataSourceLike;

type TypeOrmOptions = {
  [name: string]: unknown;
};

export class TypeOrmAdapter extends SqlRegistryAdapter {
  executor: TypeOrmExecutorLike | null;

  constructor(executorOrRegistry: unknown, registryOrOptions: unknown = {}, options: TypeOrmOptions = {}) {
    if (isTypeOrmExecutorLike(executorOrRegistry)) {
      super(registryOrOptions as SqlRegistryLike, options);
      this.executor = executorOrRegistry;
      return;
    }

    super(executorOrRegistry as SqlRegistryLike, registryOrOptions as Record<string, unknown>);
    this.executor = null;
  }

  async query(executorOrName: unknown, nameOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    const { executor, name, options } = this.resolveQueryArgs(
      executorOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.query(executor, String(name), options);
  }

  async explain(executorOrName: unknown, nameOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    const { executor, name, options } = this.resolveQueryArgs(
      executorOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.explain(executor, String(name), options);
  }

  async execute(executorOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    const { executor, builder, options } = this.resolveBuilderArgs(
      executorOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.execute(executor, builder as SqlBuilderLike, options);
  }

  async executeExplain(executorOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    const { executor, builder, options } = this.resolveBuilderArgs(
      executorOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.executeExplain(executor, builder as SqlBuilderLike, options);
  }

  executeStatement(executor: TypeOrmExecutorLike | null | undefined, stmt: SqlStatement) {
    const instance = executor || this.getExecutor();
    const queryExecutor = getQueryExecutor(instance);
    return queryExecutor.query(stmt.sql, stmt.values);
  }

  resolveQueryArgs(executorOrName: unknown, nameOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    if (isTypeOrmExecutorLike(executorOrName)) {
      return {
        executor: executorOrName,
        name: nameOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      executor: this.getExecutor(),
      name: executorOrName,
      options: nameOrOptions || {}
    };
  }

  resolveBuilderArgs(executorOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: TypeOrmOptions) {
    if (isTypeOrmExecutorLike(executorOrBuilder)) {
      return {
        executor: executorOrBuilder,
        builder: builderOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      executor: this.getExecutor(),
      builder: executorOrBuilder,
      options: builderOrOptions || {}
    };
  }

  getExecutor() {
    assertTypeOrmExecutor(this.executor);
    return this.executor;
  }
}

function isQueryExecutorLike(value: unknown): value is TypeOrmQueryExecutor {
  return typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "function";
}

function isDataSourceLike(value: unknown): value is TypeOrmDataSourceLike {
  return typeof value === "object" &&
    value !== null &&
    "manager" in value &&
    isQueryExecutorLike((value as Record<string, unknown>).manager);
}

function isTypeOrmExecutorLike(value: unknown): value is TypeOrmExecutorLike {
  return isQueryExecutorLike(value) || isDataSourceLike(value);
}

function getQueryExecutor(executor: TypeOrmExecutorLike): TypeOrmQueryExecutor {
  return isDataSourceLike(executor) ? executor.manager : executor;
}

function assertTypeOrmExecutor(executor: unknown): asserts executor is TypeOrmExecutorLike {
  if (!isTypeOrmExecutorLike(executor)) {
    throw new Error("input error: TypeORM DataSource, EntityManager, or QueryRunner with query(sql, values) is required");
  }
}

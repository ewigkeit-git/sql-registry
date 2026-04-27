import { SqlBuilderLike, SqlRegistryAdapter, SqlRegistryLike } from "./base";

type SqlStatement = {
  sql: string;
  values: unknown[];
};

type SequelizeLike = {
  query: (sql: string, options: Record<string, unknown>) => unknown;
};

type SequelizeOptions = {
  queryOptions?: Record<string, unknown>;
  [name: string]: unknown;
};

export class SequelizeAdapter extends SqlRegistryAdapter {
  sequelize: SequelizeLike | null;

  constructor(sequelizeOrRegistry: unknown, registryOrOptions: unknown = {}, options: SequelizeOptions = {}) {
    if (isSequelizeLike(sequelizeOrRegistry)) {
      super(registryOrOptions as SqlRegistryLike, options);
      this.sequelize = sequelizeOrRegistry;
      return;
    }

    super(sequelizeOrRegistry as SqlRegistryLike, registryOrOptions as Record<string, unknown>);
    this.sequelize = null;
  }

  async query(sequelizeOrName: unknown, nameOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    const { sequelize, name, options } = this.resolveQueryArgs(
      sequelizeOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.query(sequelize, String(name), options);
  }

  async explain(sequelizeOrName: unknown, nameOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    const { sequelize, name, options } = this.resolveQueryArgs(
      sequelizeOrName,
      nameOrOptions,
      maybeOptions
    );
    return super.explain(sequelize, String(name), options);
  }

  async execute(sequelizeOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    const { sequelize, builder, options } = this.resolveBuilderArgs(
      sequelizeOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.execute(sequelize, builder as SqlBuilderLike, options);
  }

  async executeExplain(sequelizeOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    const { sequelize, builder, options } = this.resolveBuilderArgs(
      sequelizeOrBuilder,
      builderOrOptions,
      maybeOptions
    );
    return super.executeExplain(sequelize, builder as SqlBuilderLike, options);
  }

  executeStatement(sequelize: SequelizeLike | null | undefined, stmt: SqlStatement, options: SequelizeOptions = {}) {
    const instance = sequelize || this.getSequelize();
    assertSequelize(instance);

    const queryOptions = options.queryOptions || {};

    if ("replacements" in queryOptions) {
      throw new Error("input error: queryOptions.replacements is managed by SequelizeAdapter");
    }

    return instance.query(stmt.sql, {
      ...queryOptions,
      replacements: stmt.values
    });
  }

  resolveQueryArgs(sequelizeOrName: unknown, nameOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    if (isSequelizeLike(sequelizeOrName)) {
      return {
        sequelize: sequelizeOrName,
        name: nameOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      sequelize: this.getSequelize(),
      name: sequelizeOrName,
      options: nameOrOptions || {}
    };
  }

  resolveBuilderArgs(sequelizeOrBuilder: unknown, builderOrOptions?: unknown, maybeOptions?: SequelizeOptions) {
    if (isSequelizeLike(sequelizeOrBuilder)) {
      return {
        sequelize: sequelizeOrBuilder,
        builder: builderOrOptions,
        options: maybeOptions || {}
      };
    }

    return {
      sequelize: this.getSequelize(),
      builder: sequelizeOrBuilder,
      options: builderOrOptions || {}
    };
  }

  getSequelize() {
    assertSequelize(this.sequelize);
    return this.sequelize;
  }
}

function isSequelizeLike(value: unknown): value is SequelizeLike {
  return typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "function";
}

function assertSequelize(sequelize: unknown): asserts sequelize is SequelizeLike {
  if (!isSequelizeLike(sequelize)) {
    throw new Error("input error: sequelize instance with query(sql, options) is required");
  }
}

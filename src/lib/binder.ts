import { extractNamedParamTokens } from "./param-parser";
import { SqlBindError, validateBindParams } from "./bind-validator";
import { applyCompiledSqlTemplate, compileSqlTemplate, CompiledSqlTemplate } from "./sql-compiler";
import { getPlaceholderStyle, normalizeStatementDialect } from "./dialect";

export type SqlStatement = {
  sql: string;
  values: unknown[];
};

export type BindSqlOptions = {
  strict?: boolean;
  dialect?: string;
  queryName?: string;
};

type CachedSqlTemplate = {
  names: string[];
  template: CompiledSqlTemplate;
};

const compiledSqlCache = new Map<string, CachedSqlTemplate>();

function cacheKey(sql: string, dialect: string) {
  return `${dialect}\0${sql}`;
}

function getCompiledSqlTemplate(sql: string, dialect: string): CachedSqlTemplate {
  const key = cacheKey(sql, dialect);
  const cached = compiledSqlCache.get(key);
  if (cached) return cached;

  const tokens = extractNamedParamTokens(sql);
  const compiled = {
    names: [...new Set(tokens.map((token: { name: string }) => token.name))],
    template: compileSqlTemplate(sql, tokens, {
      placeholder: getPlaceholderStyle(dialect)
    })
  };

  compiledSqlCache.set(key, compiled);
  return compiled;
}

export function bindSql(sql: string, params: Record<string, unknown> = {}, options: BindSqlOptions = {}): SqlStatement {
  const dialect = normalizeStatementDialect(options.dialect);
  const compiled = getCompiledSqlTemplate(sql, dialect);

  validateBindParams(sql, compiled.names, params, {
    ...options,
    dialect
  });
  return applyCompiledSqlTemplate(compiled.template, params);
}

export { SqlBindError };

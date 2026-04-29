import { extractNamedParamTokens } from "./param-parser";
import { SqlBindError, validateBindParams } from "./bind-validator";
import { compileSql } from "./sql-compiler";
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

export function bindSql(sql: string, params: Record<string, unknown> = {}, options: BindSqlOptions = {}): SqlStatement {
  const tokens = extractNamedParamTokens(sql);
  const names = [...new Set(tokens.map((token: { name: string }) => token.name))];
  const dialect = normalizeStatementDialect(options.dialect);

  validateBindParams(sql, names, params, {
    ...options,
    dialect
  });
  return compileSql(sql, tokens, params, {
    placeholder: getPlaceholderStyle(dialect)
  });
}

export { SqlBindError };

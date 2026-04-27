import { extractNamedParamTokens } from "./param-parser";
import { SqlBindError, validateBindParams } from "./bind-validator";
import { compileSql } from "./sql-compiler";
import { DIALECT, normalizeDialect } from "./dialect";

export type SqlStatement = {
  sql: string;
  values: unknown[];
};

export type BindSqlOptions = {
  strict?: boolean;
  dialect?: string;
};

export function bindSql(sql: string, params: Record<string, unknown> = {}, options: BindSqlOptions = {}): SqlStatement {
  const tokens = extractNamedParamTokens(sql);
  const names = [...new Set(tokens.map((token: { name: string }) => token.name))];
  const dialect = options.dialect ? normalizeDialect(options.dialect) : DIALECT.SQLITE;

  validateBindParams(sql, names, params, options);
  return compileSql(sql, tokens, params, {
    placeholder: dialect === DIALECT.PG ? "numbered" : "question"
  });
}

export { SqlBindError };

import { extractNamedParamTokens } from "./param-parser";
import { SqlBindError, validateBindParams } from "./bind-validator";
import { compileSql } from "./sql-compiler";

export type SqlStatement = {
  sql: string;
  values: unknown[];
};

export function bindSql(sql: string, params: Record<string, unknown> = {}, options: { strict?: boolean } = {}): SqlStatement {
  const tokens = extractNamedParamTokens(sql);
  const names = [...new Set(tokens.map((token: { name: string }) => token.name))];

  validateBindParams(sql, names, params, options);
  return compileSql(sql, tokens, params);
}

export { SqlBindError };

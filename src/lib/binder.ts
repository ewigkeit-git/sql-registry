const { extractNamedParamTokens } = require("./param-parser");
const { SqlBindError, validateBindParams } = require("./bind-validator");
const { compileSql } = require("./sql-compiler");

function bindSql(sql: string, params: Record<string, unknown> = {}, options: { strict?: boolean } = {}) {
  const tokens = extractNamedParamTokens(sql);
  const names = [...new Set(tokens.map((token: { name: string }) => token.name))];

  validateBindParams(sql, names, params, options);
  return compileSql(sql, tokens, params);
}

module.exports = {
  SqlBindError,
  bindSql
};

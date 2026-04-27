export type NamedParamToken = {
  name: string;
  start: number;
  end: number;
};

export function compileSql(sql: string, tokens: NamedParamToken[], params: Record<string, unknown> = {}) {
  const values: unknown[] = [];
  const parts: string[] = [];
  let lastIndex = 0;

  for (const token of tokens) {
    parts.push(sql.slice(lastIndex, token.start));
    parts.push("?");
    values.push(params[token.name]);
    lastIndex = token.end;
  }

  parts.push(sql.slice(lastIndex));

  return {
    sql: parts.join(""),
    values
  };
}

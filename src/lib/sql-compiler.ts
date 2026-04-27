export type NamedParamToken = {
  name: string;
  start: number;
  end: number;
};

export type CompileSqlOptions = {
  placeholder?: "question" | "numbered";
};

export function compileSql(
  sql: string,
  tokens: NamedParamToken[],
  params: Record<string, unknown> = {},
  options: CompileSqlOptions = {}
) {
  const values: unknown[] = [];
  const parts: string[] = [];
  let lastIndex = 0;
  const placeholder = options.placeholder || "question";

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    parts.push(sql.slice(lastIndex, token.start));
    parts.push(placeholder === "numbered" ? `$${i + 1}` : "?");
    values.push(params[token.name]);
    lastIndex = token.end;
  }

  parts.push(sql.slice(lastIndex));

  return {
    sql: parts.join(""),
    values
  };
}

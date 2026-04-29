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
  const numberedParamIndexes = new Map<string, number>();
  const orderedTokens = [...tokens].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  for (const token of orderedTokens) {
    parts.push(sql.slice(lastIndex, token.start));

    if (placeholder === "numbered") {
      let paramIndex = numberedParamIndexes.get(token.name);
      if (paramIndex === undefined) {
        paramIndex = numberedParamIndexes.size + 1;
        numberedParamIndexes.set(token.name, paramIndex);
        values.push(params[token.name]);
      }
      parts.push(`$${paramIndex}`);
    } else {
      parts.push("?");
      values.push(params[token.name]);
    }

    lastIndex = token.end;
  }

  parts.push(sql.slice(lastIndex));

  return {
    sql: parts.join(""),
    values
  };
}

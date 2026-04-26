function stripQuotedAndCommented(sql: string) {
  let out = "";
  let i = 0;

  function maskSegment(start: number, end: number) {
    for (let j = start; j < end; j++) {
      out += sql[j] === "\n" ? "\n" : " ";
    }
  }

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      maskSegment(start, i);
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      maskSegment(start, i);
      continue;
    }

    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      maskSegment(start, i);
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      maskSegment(start, i);
      continue;
    }

    if (ch === "$") {
      const rest = sql.slice(i);
      const tagMatch = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const start = i;
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx === -1) {
          i = sql.length;
        } else {
          i = closeIdx + tag.length;
        }
        maskSegment(start, i);
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function extractNamedParamTokens(sql: string) {
  const cleaned = stripQuotedAndCommented(sql);
  const regex = /(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g;
  const tokens = [];

  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const [fullMatch, prefix, name] = match;
    const start = match.index + prefix.length;
    const end = match.index + fullMatch.length;

    tokens.push({
      name,
      start,
      end
    });
  }

  return tokens;
}

function extractNamedParams(sql: string) {
  const names = new Set();

  for (const token of extractNamedParamTokens(sql)) {
    names.add(token.name);
  }

  return [...names];
}

module.exports = {
  stripQuotedAndCommented,
  extractNamedParamTokens,
  extractNamedParams
};

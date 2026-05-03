import * as fs from "fs";
import * as path from "path";
import { collectMarkdownDependencyFiles, QueryEntry, SqlRegistry, SqlRegistryValidationError } from "../lib/sql-registry";
import { getExplainPrefix } from "../lib/dialect";
import { compileBuilderScript } from "../lib/builder";
import { createDocsTranslator } from "./i18n";

export type GenerateDocsOptions = {
  dialect?: string;
  outFile: string;
  lang?: string;
  strict?: boolean;
  theme?: DocsTheme;
  title?: string;
};

export type GenerateDocsResult = {
  ok: boolean;
  outFile: string;
  files: string[];
  queries: string[];
  errors: string[];
};

export type DocsTheme = "auto" | "light" | "dark";

type QueryDoc = {
  id: string;
  entry: QueryEntry;
  isStatic: boolean;
  filePath: string;
  line?: number;
  references: string[];
};

type DynamicSqlOp = {
  type: "append";
  slot: string;
  sql: string;
  queryName?: string;
};

type DynamicSqlBranch = {
  id: string;
  label: string;
  ops: DynamicSqlOp[];
};

type DynamicSqlDoc = {
  queryId: string;
  baseSql: string;
  explainPrefix: string;
  always: DynamicSqlOp[];
  branches: DynamicSqlBranch[];
};

function isMarkdownFile(filePath: string) {
  return [".md", ".markdown"].includes(path.extname(filePath).toLowerCase());
}

function collectMarkdownFiles(inputPath: string, errors: string[], files: string[] = []) {
  const fullPath = path.resolve(inputPath);

  if (!fs.existsSync(fullPath)) {
    errors.push(`path not found: ${fullPath}`);
    return files;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    if (isMarkdownFile(fullPath)) {
      files.push(fullPath);
    } else {
      errors.push(`path is not a markdown file: ${fullPath}`);
    }
    return files;
  }

  if (!stat.isDirectory()) {
    errors.push(`path is not a file or directory: ${fullPath}`);
    return files;
  }

  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    const entryPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(entryPath, errors, files);
    } else if (entry.isFile() && isMarkdownFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

function rootMarkdownFiles(files: string[]) {
  const inputFileSet = new Set(files);
  const importedInputFiles = new Set<string>();

  for (const filePath of files) {
    try {
      for (const dependencyPath of collectMarkdownDependencyFiles(filePath)) {
        if (dependencyPath !== filePath && inputFileSet.has(dependencyPath)) {
          importedInputFiles.add(dependencyPath);
        }
      }
    } catch {
      // loadFile reports import errors with full validation context later.
    }
  }

  return files.filter(filePath => !importedInputFiles.has(filePath));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function anchorId(queryId: string) {
  return `q-${queryId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function fileAnchorId(filePath: string) {
  return `f-${path.resolve(filePath).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function relativePath(filePath: string) {
  return path.relative(process.cwd(), filePath) || filePath;
}

function collectAppendQueryReferences(code = "") {
  const references = new Set<string>();
  const patterns = [
    /\bappendQuery\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g,
    /\bappendQueryIf\s*\(\s*['"][^'"]+['"]\s*,\s*[^,]+,\s*['"]([^'"]+)['"]/g,
    /\bat\s*\(\s*['"][^'"]+['"]\s*\)\s*\.\s*appendQuery\s*\(\s*['"]([^'"]+)['"]/g,
    /\bat\s*\(\s*['"][^'"]+['"]\s*\)\s*\.\s*appendQueryIf\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      references.add(match[1]);
    }
  }

  return [...references].sort();
}

function loadRegistry(paths: string[], options: GenerateDocsOptions) {
  const errors: string[] = [];
  const files = paths.flatMap(inputPath => collectMarkdownFiles(inputPath, errors));
  const uniqueFiles = [...new Set(files)].sort();
  const registry = new SqlRegistry({
    dialect: options.dialect,
    strict: options.strict !== false
  });

  if (uniqueFiles.length === 0) {
    errors.push("no markdown registry files found");
  }

  for (const filePath of rootMarkdownFiles(uniqueFiles)) {
    try {
      registry.loadFile(filePath);
    } catch (err: unknown) {
      if (err instanceof SqlRegistryValidationError) {
        errors.push(...err.errors);
      } else if (err instanceof Error) {
        errors.push(err.message);
      } else {
        errors.push(String(err));
      }
    }
  }

  return {
    registry,
    errors,
    files: registry.files.length > 0 ? registry.files : uniqueFiles
  };
}

function buildQueryDocs(registry: SqlRegistry): QueryDoc[] {
  return registry.list().map(id => {
    const entry = registry.get(id);
    const source = entry.source;
    return {
      id,
      entry,
      isStatic: registry.isStatic(id),
      filePath: source?.filePath || "",
      line: source?.queryLine,
      references: collectAppendQueryReferences(entry.meta.builder)
    };
  });
}

function renderReferenceLinks(references: string[], knownIds: Set<string>, noneLabel: string) {
  if (references.length === 0) return `<span class="muted">${escapeHtml(noneLabel)}</span>`;
  return references.map(reference => {
    if (!knownIds.has(reference)) {
      return `<span class="missing-ref">${escapeHtml(reference)}</span>`;
    }
    return `<a href="#${anchorId(reference)}" data-query-link="${escapeHtml(reference)}">${escapeHtml(reference)}</a>`;
  }).join(", ");
}

function referencedByLabel(lang: string) {
  return lang === "ja" ? "参照元" : "Referenced by";
}

function referencedSqlIdsLabel(lang: string) {
  return lang === "ja" ? "参照SQL ID" : "Referenced SQL IDs";
}

function builderDefinitionLabel(lang: string) {
  return lang === "ja" ? "Builder定義" : "Builder Definition";
}

function sqlDefinitionLabel(lang: string) {
  return lang === "ja" ? "SQL定義" : "SQL Definition";
}

function dynamicSqlLabel(lang: string) {
  return lang === "ja" ? "動的SQL生成" : "Dynamic SQL";
}

function descriptionLabel(lang: string) {
  return lang === "ja" ? "説明" : "Description";
}

function renderDescription(value: unknown, noneLabel: string) {
  const lines = String(value || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return `<span class="muted">${escapeHtml(noneLabel)}</span>`;
  return lines.map(line => escapeHtml(line)).join("<br>");
}

function renderReferencedByTable(referrers: string[], queryById: Map<string, QueryDoc>, labels: ReturnType<typeof createDocsTranslator>) {
  const { t } = labels;
  if (referrers.length === 0) return `<p class="muted">${escapeHtml(t("none"))}</p>`;

  return [
    `<table class="mini-table"><thead><tr><th>SQL ID</th><th>${escapeHtml(descriptionLabel(labels.lang))}</th></tr></thead><tbody>`,
    ...referrers.map(id => {
      const query = queryById.get(id);
      return [
        "<tr>",
        `<td><a href="#${anchorId(id)}" data-query-link="${escapeHtml(id)}"><code>${escapeHtml(id)}</code></a></td>`,
        `<td>${renderDescription(query?.entry.meta.description, t("none"))}</td>`,
        "</tr>"
      ].join("");
    }),
    "</tbody></table>"
  ].join("");
}

function renderBuilderScript(code: string, knownIds: Set<string>) {
  const spans: Array<{ start: number; end: number; id: string }> = [];
  const patterns = [
    /\bappendQuery\s*\(\s*(['"])[^'"]+\1\s*,\s*(['"])([^'"]+)\2/g,
    /\bappendQueryIf\s*\(\s*(['"])[^'"]+\1\s*,\s*[^,]+,\s*(['"])([^'"]+)\2/g,
    /\bat\s*\(\s*(['"])[^'"]+\1\s*\)\s*\.\s*appendQuery\s*\(\s*(['"])([^'"]+)\2/g,
    /\bat\s*\(\s*(['"])[^'"]+\1\s*\)\s*\.\s*appendQueryIf\s*\(\s*[^,]+,\s*(['"])([^'"]+)\2/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const id = match[3];
      const relativeStart = match[0].lastIndexOf(id);
      if (relativeStart < 0) continue;
      spans.push({
        start: match.index + relativeStart,
        end: match.index + relativeStart + id.length,
        id
      });
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const nonOverlapping = spans.filter((span, index) => index === 0 || span.start >= spans[index - 1].end);
  if (nonOverlapping.length === 0) return escapeHtml(code);

  let html = "";
  let offset = 0;
  for (const span of nonOverlapping) {
    html += escapeHtml(code.slice(offset, span.start));
    const label = escapeHtml(code.slice(span.start, span.end));
    if (knownIds.has(span.id)) {
      html += `<a href="#${anchorId(span.id)}" data-query-link="${escapeHtml(span.id)}">${label}</a>`;
    } else {
      html += `<span class="missing-ref">${label}</span>`;
    }
    offset = span.end;
  }
  html += escapeHtml(code.slice(offset));
  return html;
}

function renderParamTable(entry: QueryEntry, labels: ReturnType<typeof createDocsTranslator>) {
  const { t } = labels;
  const params = entry.meta.params || [];
  if (params.length === 0) return `<p class="muted">${escapeHtml(t("noParams"))}</p>`;
  return [
    `<table class="mini-table"><thead><tr><th>${escapeHtml(t("physicalName"))}</th><th>${escapeHtml(t("logicalName"))}</th><th>${escapeHtml(t("type"))}</th></tr></thead><tbody>`,
    ...params.map(param => [
      "<tr>",
      `<td><code>${escapeHtml(param.name)}</code></td>`,
      `<td>${escapeHtml(param.description)}</td>`,
      `<td>${param.type ? `<code>${escapeHtml(param.type)}</code>` : "<span class=\"muted\">any</span>"}</td>`,
      "</tr>"
    ].join("")),
    "</tbody></table>"
  ].join("");
}

function renderSqlBlocks(entry: QueryEntry, dialect: string | undefined, labels: ReturnType<typeof createDocsTranslator>, dynamicSqlHtml = "", dynamicQueryId = "") {
  const { t } = labels;
  const blocks = Object.entries(entry.sql).sort(([a], [b]) => a.localeCompare(b));
  return blocks.map(([blockDialect, sql]) => {
    const explainPrefix = getExplainPrefix(dialect || blockDialect);
    return [
      `<section class="sql-block">`,
      `<div class="block-title">${escapeHtml(t("sql"))} <span>${escapeHtml(blockDialect)}</span></div>`,
      `<pre><code>${escapeHtml(sql)}</code></pre>`,
      dynamicSqlHtml,
      `<div class="block-title">${escapeHtml(t("explain"))}</div>`,
      `<pre><code${dynamicQueryId ? ` data-dynamic-explain-output="${escapeHtml(dynamicQueryId)}"` : ""}>${escapeHtml(`${explainPrefix} ${sql}`)}</code></pre>`,
      `</section>`
    ].join("");
  }).join("");
}

function selectSql(entry: QueryEntry, dialect: string | undefined) {
  if (dialect && entry.sql[dialect]) return entry.sql[dialect];
  return entry.sql.default || Object.entries(entry.sql).sort(([a], [b]) => a.localeCompare(b))[0]?.[1] || "";
}

function encodeJsonForHtml(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function expressionLabel(expression: any): string {
  if (!expression || typeof expression !== "object") return "condition";

  switch (expression.type) {
    case "member":
      return `${expression.root}.${expression.key}`;
    case "literal":
      return JSON.stringify(expression.value);
    case "undefined":
      return "undefined";
    case "unary":
      return `${expression.operator}${expressionLabel(expression.argument)}`;
    case "binary":
    case "logical":
      return `${expressionLabel(expression.left)} ${expression.operator} ${expressionLabel(expression.right)}`;
    case "conditional":
      return `${expressionLabel(expression.test)} ? ${expressionLabel(expression.consequent)} : ${expressionLabel(expression.alternate)}`;
    default:
      return "condition";
  }
}

function normalizeDynamicOp(op: any, queryById: Map<string, QueryDoc>, dialect: string | undefined): DynamicSqlOp | null {
  if (op.type === "append") {
    return { type: "append", slot: String(op.slot), sql: String(op.sql) };
  }

  if (op.type === "appendQuery") {
    const target = queryById.get(String(op.queryName));
    return {
      type: "append",
      slot: String(op.slot),
      sql: target ? selectSql(target.entry, dialect) : `/* missing query: ${String(op.queryName)} */`,
      queryName: String(op.queryName)
    };
  }

  if (op.type === "limit") {
    return { type: "append", slot: String(op.slot), sql: `LIMIT :limit_${String(op.slot).replace(/[^A-Za-z0-9_]/g, char => `_x${char.charCodeAt(0).toString(16)}_`)}` };
  }

  if (op.type === "offset") {
    return { type: "append", slot: String(op.slot), sql: `OFFSET :offset_${String(op.slot).replace(/[^A-Za-z0-9_]/g, char => `_x${char.charCodeAt(0).toString(16)}_`)}` };
  }

  return null;
}

function buildDynamicSqlDocs(queries: QueryDoc[], dialect: string | undefined): DynamicSqlDoc[] {
  const queryById = new Map(queries.map(query => [query.id, query]));
  const docs: DynamicSqlDoc[] = [];

  for (const query of queries) {
    if (!query.entry.meta.builder) continue;

    const program = compileBuilderScript(query.entry.meta.builder);
    const ops = program?.ops || [];
    if (ops.length === 0) continue;

    const always: DynamicSqlOp[] = [];
    const branchMap = new Map<string, DynamicSqlBranch>();

    for (const op of ops as any[]) {
      const dynamicOp = normalizeDynamicOp(op, queryById, dialect);
      if (!dynamicOp) continue;

      if (!op.condition) {
        always.push(dynamicOp);
        continue;
      }

      const key = JSON.stringify(op.condition);
      if (!branchMap.has(key)) {
        branchMap.set(key, {
          id: `${query.id}-branch-${branchMap.size + 1}`,
          label: expressionLabel(op.condition),
          ops: []
        });
      }
      branchMap.get(key)?.ops.push(dynamicOp);
    }

    if (always.length === 0 && branchMap.size === 0) continue;

    docs.push({
      queryId: query.id,
      baseSql: selectSql(query.entry, dialect),
      explainPrefix: getExplainPrefix(dialect || Object.keys(query.entry.sql).sort()[0]),
      always,
      branches: [...branchMap.values()]
    });
  }

  return docs;
}

function minifyInlineScript(script: string) {
  return script
    .replace(/^\s+|\s+$/gm, "")
    .replace(/\n+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*([{}()[\];,:?=<>+\-*/|&!])\s*/g, "$1");
}

function normalizeDocsTheme(theme: string | undefined): DocsTheme {
  if (theme === "light" || theme === "dark" || theme === "auto") return theme;
  return "auto";
}

function findNearestPackageJson(startPath: string) {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isFile()
    ? path.dirname(startPath)
    : startPath;
  current = path.resolve(current);

  while (true) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) return packagePath;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function packageLabel(paths: string[]) {
  for (const inputPath of paths) {
    const packagePath = findNearestPackageJson(inputPath);
    if (!packagePath) continue;

    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      const name = String(packageJson.name || "sql-registry");
      const version = String(packageJson.version || "").trim();
      return version ? `${name} v${version}` : name;
    } catch {
      // Keep looking; a malformed package.json should not prevent docs generation.
    }
  }

  return "sql-registry";
}

function docsTitleSuffix(lang?: string) {
  return lang === "ja" ? "SQL設計書" : "docs";
}

const DOCS_SCRIPT = minifyInlineScript(String.raw`
(function () {
  var _0 = Array.prototype.slice.call(document.querySelectorAll(".query-detail"));
  var _1 = document.getElementById("overview");
  var _2 = Array.prototype.slice.call(document.querySelectorAll("[data-query-link]"));
  var _10 = document.documentElement;
  var _11 = Array.prototype.slice.call(document.querySelectorAll("[data-theme-toggle]"));
  var _12 = "sql-registry-docs-theme";

  function _13(_4) {
    return _4 === "light" || _4 === "dark" || _4 === "auto" ? _4 : "auto";
  }

  function _14() {
    try {
      return localStorage.getItem(_12) || "";
    } catch (_4) {
      return "";
    }
  }

  function _15(_4) {
    try {
      localStorage.setItem(_12, _4);
    } catch (_5) {}
  }

  function _16(_4) {
    var _5 = _13(_4);
    _10.setAttribute("data-theme", _5);
    _11.forEach(function (_6) {
      var _7 = _6.getAttribute("data-theme-toggle") === _5;
      _6.classList.toggle("active", _7);
      _6.setAttribute("aria-pressed", _7 ? "true" : "false");
    });
  }

  if (_11.length) {
    _16(_14() || _10.getAttribute("data-theme"));
    _11.forEach(function (_4) {
      _4.addEventListener("click", function () {
        var _5 = _13(_4.getAttribute("data-theme-toggle"));
        _15(_5);
        _16(_5);
      });
    });
  }

  function _3(_4) {
    _2.forEach(function (_5) {
      _5.classList.toggle("active", _5.getAttribute("data-query-link") === _4);
    });
  }

  function _6() {
    if (_1) _1.hidden = false;
    _0.forEach(function (_7) { _7.hidden = true; });
    _3("");
  }

  function _8(_4) {
    var _9 = false;
    if (_1) _1.hidden = true;
    _0.forEach(function (_7) {
      var _a = _7.getAttribute("data-query-id") === _4;
      _7.hidden = !_a;
      _9 = _9 || _a;
    });
    if (!_9) {
      _6();
      return;
    }
    _3(_4);
  }

  document.addEventListener("click", function (_b) {
    var _c = _b.target;
    if (!(_c instanceof Element)) return;
    var _d = _c.closest("[data-query-link]");
    if (_d) {
      var _4 = _d.getAttribute("data-query-link");
      if (_4) _8(_4);
      return;
    }
    if (_c.closest("[data-overview-link]")) {
      _6();
    }
  });

  function _e() {
    var _f = decodeURIComponent(window.location.hash || "");
    var _a = _0.find(function (_7) { return "#" + _7.id === _f; });
    if (_a) {
      _8(_a.getAttribute("data-query-id") || "");
    } else {
      _6();
    }
  }

  function _17(_4) {
    return String(_4 == null ? "" : _4)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function _18(_4) {
    var _5 = 0;
    var _6 = null;
    var _7 = false;
    var _8 = false;
    for (var _9 = 0; _9 < _4.length; _9++) {
      var _a = _4[_9];
      var _b = _4[_9 + 1];
      if (_7) {
        if (_a === "\n" || _a === "\r") _7 = false;
        continue;
      }
      if (_8) {
        if (_a === "*" && _b === "/") {
          _8 = false;
          _9++;
        }
        continue;
      }
      if (_6) {
        if (_a === _6) _6 = null;
        continue;
      }
      if (_a === "-" && _b === "-") {
        _7 = true;
        _9++;
        continue;
      }
      if (_a === "/" && _b === "*") {
        _8 = true;
        _9++;
        continue;
      }
      if (_a === "'" || _a === '"' || _a === "\`") {
        _6 = _a;
        continue;
      }
      if (_a === "(") _5++;
      if (_a === ")") _5 = Math.max(0, _5 - 1);
      if (_5 === 0 && /\bwhere\b/i.test(_4.slice(_9, _9 + 5))) return true;
    }
    return false;
  }

  function _19(_4, _5, _6) {
    var _7 = [];
    (_5 || []).forEach(function (_8) {
      String(_8.sql || "").trim().split(/\r?\n/).forEach(function (_9) {
        _7.push({ line: _9, group: _8.group });
      });
    });
    if (_4 === "where" && _7.length > 0 && !_18(_6) && !/^where\b/i.test(_7[0].line)) {
      _7[0].line = "WHERE " + _7[0].line.replace(/^(?:and|or)\b\s*/i, "");
    }
    return _7;
  }

  function _1f(_4) {
    return _4.group == null ? _4.line : "\uE000" + _4.group + "\uE001" + _4.line;
  }

  function _1a(_4, _5) {
    var _6 = {};
    (_4.always || []).forEach(function (_7) {
      if (!_6[_7.slot]) _6[_7.slot] = [];
      _6[_7.slot].push({ sql: _7.sql, group: null });
    });
    _5.forEach(function (_7) {
      if (!_6[_7.slot]) _6[_7.slot] = [];
      _6[_7.slot].push({ sql: _7.sql, group: _7.group });
    });
    return String(_4.baseSql || "").replace(/\/\*#([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+-\s*.*?)?\*\//g, function (_7, _8, _9) {
      return _19(_8, _6[_8] || [], String(_4.baseSql || "").slice(0, _9)).map(_1f).join("\n");
    }).trim().split(/\r?\n/).map(function (_7) {
      var _8 = /^(\s*)\uE000(\d+)\uE001/.exec(_7);
      return {
        line: _8 ? _8[1] + _7.slice(_8[0].length) : _7,
        added: Boolean(_8),
        group: _8 ? Number(_8[2]) : 0
      };
    });
  }

  function _1d(_4) {
    return "hsl(" + ((_4 * 47) % 360) + " 70% 42%)";
  }

  function _1e(_4) {
    return "hsl(" + ((_4 * 47) % 360) + " 70% 42% / 0.16)";
  }

  function _1b(_4, _5) {
    var _6 = [];
    (_4.branches || []).forEach(function (_7, _c) {
      var _8 = _5.querySelector('[data-dynamic-branch="' + _7.id + '"]');
      if (_8 && _8.checked) {
        (_7.ops || []).forEach(function (_9) {
          var _a = {};
          Object.keys(_9 || {}).forEach(function (_b) { _a[_b] = _9[_b]; });
          _a.group = _c;
          _6.push(_a);
        });
      }
    });
    var _9 = _1a(_4, _6);
    var _a = _5.querySelector("[data-dynamic-output]");
    if (_a) _a.innerHTML = _9.map(function (_b) {
      return '<span class="' + (_b.added ? "dynamic-line-added" : "") + '"' + (_b.added ? ' style="--branch-color:' + _1d(_b.group) + ';--branch-bg:' + _1e(_b.group) + '"' : "") + '>' + _17(_b.line) + '</span>';
    }).join("\n");
    var _d = document.querySelector('[data-dynamic-explain-output="' + _4.queryId + '"]');
    if (_d) {
      var _e = _9.map(function (_b) {
        return { line: _b.line, added: _b.added, group: _b.group };
      });
      if (_e.length > 0) _e[0].line = String(_4.explainPrefix || "EXPLAIN") + " " + _e[0].line;
      _d.innerHTML = _e.map(function (_b) {
        return '<span class="' + (_b.added ? "dynamic-line-added" : "") + '"' + (_b.added ? ' style="--branch-color:' + _1d(_b.group) + ';--branch-bg:' + _1e(_b.group) + '"' : "") + '>' + _17(_b.line) + '</span>';
      }).join("\n");
    }
  }

  function _1c() {
    var _4 = document.getElementById("dynamic-sql-data");
    if (!_4) return;
    var _5 = [];
    try {
      _5 = JSON.parse(_4.textContent || "[]");
    } catch (_6) {
      return;
    }
    _5.forEach(function (_6) {
      var _7 = document.querySelector('[data-dynamic-sql="' + _6.queryId + '"]');
      if (!_7) return;
      var _8 = (_6.branches || []).map(function (_9, _a) {
        return '<label class="dynamic-toggle" style="--branch-color:' + _1d(_a) + ';--branch-bg:' + _1e(_a) + '"><input type="checkbox" data-dynamic-branch="' + _17(_9.id) + '"><span>' + _17(_9.label) + '</span></label>';
      }).join("");
      _7.innerHTML = '<div class="dynamic-actions"><button type="button" data-dynamic-all="on">全ON</button><button type="button" data-dynamic-all="off">全OFF</button></div><div class="dynamic-toggles">' + _8 + '</div><div class="dynamic-subtitle">SQL</div><pre><code data-dynamic-output></code></pre>';
      Array.prototype.slice.call(_7.querySelectorAll("[data-dynamic-all]")).forEach(function (_9) {
        _9.addEventListener("click", function () {
          var _a = _9.getAttribute("data-dynamic-all") === "on";
          Array.prototype.slice.call(_7.querySelectorAll("[data-dynamic-branch]")).forEach(function (_b) {
            _b.checked = _a;
          });
          _1b(_6, _7);
        });
      });
      Array.prototype.slice.call(_7.querySelectorAll("[data-dynamic-branch]")).forEach(function (_9) {
        _9.addEventListener("change", function () { _1b(_6, _7); });
      });
      _1b(_6, _7);
    });
  }

  window.addEventListener("hashchange", _e);
  _1c();
  _e();
})();
`);

const DOCS_CSS = `
:root {
  color-scheme: light dark;
  --bg:#f7f8fa;
  --sidebar:#eef2f6;
  --panel:#fff;
  --table-head:#f0f3f7;
  --code-bg:#111827;
  --code-text:#e6edf3;
  --badge-bg:#f7f8fa;
  --dynamic-bg:#fff8e5;
  --dynamic-line:#d8b365;
  --text:#20242a;
  --muted:#68717d;
  --line:#d9dee7;
  --accent:#1769aa;
  --warn:#a94442;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0f141b;
    --sidebar:#161d27;
    --panel:#151b24;
    --table-head:#1d2632;
    --code-bg:#0a0f16;
    --code-text:#d7e0ea;
    --badge-bg:#202936;
    --dynamic-bg:#2d2616;
    --dynamic-line:#8f7132;
    --text:#e8edf3;
    --muted:#9aa7b6;
    --line:#2a3543;
    --accent:#77b7f7;
    --warn:#ff8a8a;
  }
}
:root[data-theme="dark"] {
  --bg:#0f141b;
  --sidebar:#161d27;
  --panel:#151b24;
  --table-head:#1d2632;
  --code-bg:#0a0f16;
  --code-text:#d7e0ea;
  --badge-bg:#202936;
  --dynamic-bg:#2d2616;
  --dynamic-line:#8f7132;
  --text:#e8edf3;
  --muted:#9aa7b6;
  --line:#2a3543;
  --accent:#77b7f7;
  --warn:#ff8a8a;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.layout { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; min-height: 100vh; }
aside { position: sticky; top: 0; height: 100vh; overflow: auto; border-right: 1px solid var(--line); background: var(--sidebar); padding: 18px; }
main { padding: 24px 28px 56px; min-width: 0; }
h1 { font-size: 28px; margin: 0 0 6px; }
h2 { font-size: 22px; margin: 34px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
h3 { font-size: 17px; margin: 22px 0 10px; }
.subtitle, .muted { color: var(--muted); }
.menu-title { font-weight: 700; margin: 18px 0 8px; }
.menu-list { list-style: none; padding: 0; margin: 0; }
.menu-list li { margin: 4px 0; overflow-wrap: anywhere; }
.menu-list a.active { font-weight: 700; color: var(--text); }
.theme-toggle { position: fixed; top: 14px; right: 18px; z-index: 10; display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 4px 18px rgba(0,0,0,.08); }
.theme-toggle button { border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 12px; line-height: 1; min-width: 44px; padding: 7px 9px; }
.theme-toggle button.active { background: var(--accent); color: var(--panel); font-weight: 700; }
.theme-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dynamic-actions { display: flex; gap: 6px; margin: 8px 0; }
.dynamic-actions button { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; font: inherit; font-size: 12px; padding: 5px 8px; }
.dynamic-actions button:hover { border-color: var(--accent); color: var(--accent); }
.dynamic-subtitle { color: var(--muted); font-size: 12px; font-weight: 700; margin: 10px 0 4px; text-transform: uppercase; }
.dynamic-toggles { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 10px; }
.dynamic-toggle { align-items: center; border: 1px solid var(--line); border-left: 4px solid var(--branch-color); border-radius: 6px; cursor: pointer; display: inline-flex; gap: 6px; padding: 6px 8px; }
.dynamic-toggle:has(input:checked) { background: var(--branch-bg); border-color: var(--branch-color); }
.dynamic-toggle input { margin: 0; }
.dynamic-line-added { background: var(--branch-bg); box-shadow: inset 3px 0 0 var(--branch-color); display: inline-block; margin: 0 -4px; padding: 0 4px 0 8px; width: calc(100% + 8px); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; }
.view[hidden], .query-detail[hidden] { display: none; }
.file-summary { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.file-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.summary-table, .mini-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); }
.summary-table th, .summary-table td, .mini-table th, .mini-table td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
.summary-table th, .mini-table th { background: var(--table-head); font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
pre { margin: 8px 0 14px; padding: 12px; overflow: auto; background: var(--code-bg); color: var(--code-text); border-radius: 6px; line-height: 1.45; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 12px; background: var(--badge-bg); }
.badge.dynamic { border-color: var(--dynamic-line); background: var(--dynamic-bg); }
.missing-ref { color: var(--warn); font-weight: 600; }
.block-title { font-weight: 700; margin: 12px 0 6px; }
.block-title span { color: var(--muted); font-weight: 500; margin-left: 6px; }
.file-path { overflow-wrap: anywhere; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } aside { position: relative; height: auto; } main { padding: 64px 18px 18px; } .theme-toggle { right: 12px; } }
`.trim();

function renderHtml(title: string, documentTitle: string, dialect: string | undefined, files: string[], queries: QueryDoc[], errors: string[], lang?: string, theme?: DocsTheme) {
  const labels = createDocsTranslator(lang);
  const { t } = labels;
  const docsTheme = normalizeDocsTheme(theme);
  const knownIds = new Set(queries.map(query => query.id));
  const queryById = new Map(queries.map(query => [query.id, query]));
  const dynamicSqlDocs = buildDynamicSqlDocs(queries, dialect);
  const referencedBy = new Map<string, string[]>();
  const byFile = new Map<string, QueryDoc[]>();
  for (const file of files) byFile.set(file, []);
  for (const query of queries) {
    if (!byFile.has(query.filePath)) byFile.set(query.filePath, []);
    byFile.get(query.filePath)?.push(query);
    for (const reference of query.references) {
      if (!knownIds.has(reference)) continue;
      const referrers = referencedBy.get(reference) || [];
      referrers.push(query.id);
      referencedBy.set(reference, referrers);
    }
  }
  for (const referrers of referencedBy.values()) referrers.sort();

  return `<!doctype html>
<html lang="${escapeHtml(labels.lang)}" data-theme="${escapeHtml(docsTheme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle)}</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<div class="theme-toggle" aria-label="Theme">
  <button type="button" data-theme-toggle="auto" aria-pressed="false">Auto</button>
  <button type="button" data-theme-toggle="light" aria-pressed="false">Light</button>
  <button type="button" data-theme-toggle="dark" aria-pressed="false">Dark</button>
</div>
<div class="layout">
<aside>
  <div class="menu-title">${escapeHtml(t("home"))}</div>
  <ul class="menu-list">
    <li><a href="#overview" data-overview-link>${escapeHtml(t("overview"))}</a></li>
  </ul>
  <div class="menu-title">${escapeHtml(t("sqlIds"))}</div>
  <ul class="menu-list">
    ${queries.map(query => `<li><a href="#${anchorId(query.id)}" data-query-link="${escapeHtml(query.id)}">${escapeHtml(query.id)}</a></li>`).join("")}
  </ul>
  <div class="menu-title">${escapeHtml(t("files"))}</div>
  <ul class="menu-list">
    ${[...byFile.keys()].sort().map(file => `<li><a href="#${fileAnchorId(file)}" data-file-link>${escapeHtml(relativePath(file))}</a></li>`).join("")}
  </ul>
</aside>
<main>
  <section id="overview" class="view">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${queries.length} query definitions in ${files.length} file(s)${dialect ? `, dialect ${escapeHtml(dialect)}` : ""}</p>
    ${errors.length > 0 ? `<section class="panel"><h2>${escapeHtml(t("validationErrors"))}</h2><ul>${errors.map(error => `<li class="missing-ref">${escapeHtml(error)}</li>`).join("")}</ul></section>` : ""}

    <h2>${escapeHtml(t("overview"))}</h2>
    <table class="summary-table">
      <thead><tr><th>SQL ID</th><th>${escapeHtml(t("files"))}</th><th>${escapeHtml(t("type"))}</th><th>${escapeHtml(t("params"))}</th><th>${escapeHtml(referencedSqlIdsLabel(labels.lang))}</th></tr></thead>
      <tbody>
        ${queries.map(query => `<tr>
          <td><a href="#${anchorId(query.id)}" data-query-link="${escapeHtml(query.id)}"><code>${escapeHtml(query.id)}</code></a></td>
          <td class="file-path"><a href="#${fileAnchorId(query.filePath)}" data-file-link>${escapeHtml(relativePath(query.filePath))}${query.line ? `:${query.line}` : ""}</a></td>
          <td><span class="badge ${query.isStatic ? "" : "dynamic"}">${query.isStatic ? escapeHtml(t("static")) : escapeHtml(t("dynamic"))}</span></td>
          <td>${(query.entry.meta.params || []).map(param => `<code>${escapeHtml(param.name)}</code>`).join(", ") || `<span class="muted">${escapeHtml(t("none"))}</span>`}</td>
          <td>${renderReferenceLinks(query.references, knownIds, t("none"))}</td>
        </tr>`).join("")}
      </tbody>
    </table>

    <h2>${escapeHtml(t("files"))}</h2>
    <div class="file-summary">
      ${[...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, fileQueries]) => `
        <section id="${fileAnchorId(file)}" class="file-card">
          <strong>${escapeHtml(relativePath(file))}</strong>
          <div class="muted">${fileQueries.length} query definition(s)</div>
        </section>
      `).join("")}
    </div>
  </section>

  ${queries.map(query => `
    <article id="${anchorId(query.id)}" class="panel query-detail" data-query-id="${escapeHtml(query.id)}" hidden>
      <h3><code>${escapeHtml(query.id)}</code> <span class="badge ${query.isStatic ? "" : "dynamic"}">${query.isStatic ? escapeHtml(t("static")) : escapeHtml(t("dynamic"))}</span></h3>
      <p class="file-path"><strong>${escapeHtml(t("source"))}:</strong> ${escapeHtml(relativePath(query.filePath))}${query.line ? `:${query.line}` : ""}</p>
      ${query.entry.meta.description ? `<p>${escapeHtml(query.entry.meta.description)}</p>` : ""}
      ${query.entry.meta.tags && query.entry.meta.tags.length > 0 ? `<p><strong>${escapeHtml(t("tags"))}:</strong> ${query.entry.meta.tags.map(tag => `<span class="badge">${escapeHtml(tag)}</span>`).join(" ")}</p>` : ""}
      <h4>${escapeHtml(t("params"))}</h4>
      ${renderParamTable(query.entry, labels)}
      <h4>${escapeHtml(referencedByLabel(labels.lang))}</h4>
      ${renderReferencedByTable(referencedBy.get(query.id) || [], queryById, labels)}
      ${query.entry.meta.builder ? `<h4>${escapeHtml(builderDefinitionLabel(labels.lang))}</h4><pre><code>${renderBuilderScript(query.entry.meta.builder, knownIds)}</code></pre>` : ""}
      <h4>${escapeHtml(sqlDefinitionLabel(labels.lang))}</h4>
      ${renderSqlBlocks(query.entry, dialect, labels, dynamicSqlDocs.some(doc => doc.queryId === query.id) ? `<div class="block-title">${escapeHtml(dynamicSqlLabel(labels.lang))}</div><div class="dynamic-sql" data-dynamic-sql="${escapeHtml(query.id)}"></div>` : "", dynamicSqlDocs.some(doc => doc.queryId === query.id) ? query.id : "")}
    </article>
  `).join("")}
</main>
</div>
<script type="application/json" id="dynamic-sql-data">${encodeJsonForHtml(dynamicSqlDocs)}</script>
<script src="./app.js"></script>
</body>
</html>`;
}

export function generateDocs(paths: string[], options: GenerateDocsOptions): GenerateDocsResult {
  const { registry, errors, files } = loadRegistry(paths, options);
  const queries = errors.length === 0 ? buildQueryDocs(registry) : [];
  const outFile = path.resolve(options.outFile);
  const defaultTitle = `${packageLabel(paths)} ${docsTitleSuffix(options.lang)}`;
  const html = renderHtml(options.title || defaultTitle, defaultTitle, options.dialect, files, queries, errors, options.lang, options.theme);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, "utf8");
  fs.writeFileSync(path.join(path.dirname(outFile), "style.css"), `${DOCS_CSS}\n`, "utf8");
  fs.writeFileSync(path.join(path.dirname(outFile), "app.js"), `${DOCS_SCRIPT}\n`, "utf8");

  return {
    ok: errors.length === 0,
    outFile,
    files,
    queries: queries.map(query => query.id),
    errors
  };
}

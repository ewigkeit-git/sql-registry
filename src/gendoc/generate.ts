import * as fs from "fs";
import * as path from "path";
import { collectMarkdownDependencyFiles, QueryEntry, SqlRegistry, SqlRegistryValidationError } from "../lib/sql-registry";
import { getExplainPrefix } from "../lib/dialect";
import { createDocsTranslator } from "./i18n";

export type GenerateDocsOptions = {
  dialect?: string;
  outFile: string;
  lang?: string;
  strict?: boolean;
  title?: string;
};

export type GenerateDocsResult = {
  ok: boolean;
  outFile: string;
  files: string[];
  queries: string[];
  errors: string[];
};

type QueryDoc = {
  id: string;
  entry: QueryEntry;
  isStatic: boolean;
  filePath: string;
  line?: number;
  references: string[];
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

function renderSqlBlocks(entry: QueryEntry, dialect: string | undefined, labels: ReturnType<typeof createDocsTranslator>) {
  const { t } = labels;
  const blocks = Object.entries(entry.sql).sort(([a], [b]) => a.localeCompare(b));
  return blocks.map(([blockDialect, sql]) => {
    const explainPrefix = getExplainPrefix(dialect || blockDialect);
    return [
      `<section class="sql-block">`,
      `<div class="block-title">${escapeHtml(t("sql"))} <span>${escapeHtml(blockDialect)}</span></div>`,
      `<pre><code>${escapeHtml(sql)}</code></pre>`,
      `<div class="block-title">${escapeHtml(t("explain"))}</div>`,
      `<pre><code>${escapeHtml(`${explainPrefix} ${sql}`)}</code></pre>`,
      `</section>`
    ].join("");
  }).join("");
}

function minifyInlineScript(script: string) {
  return script
    .replace(/^\s+|\s+$/gm, "")
    .replace(/\n+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*([{}()[\];,:?=<>+\-*/|&!])\s*/g, "$1");
}

function renderHtml(title: string, dialect: string | undefined, files: string[], queries: QueryDoc[], errors: string[], lang?: string) {
  const labels = createDocsTranslator(lang);
  const { t } = labels;
  const knownIds = new Set(queries.map(query => query.id));
  const byFile = new Map<string, QueryDoc[]>();
  for (const file of files) byFile.set(file, []);
  for (const query of queries) {
    if (!byFile.has(query.filePath)) byFile.set(query.filePath, []);
    byFile.get(query.filePath)?.push(query);
  }

  const script = minifyInlineScript(`
(function () {
  var _0 = Array.prototype.slice.call(document.querySelectorAll(".query-detail"));
  var _1 = document.getElementById("overview");
  var _2 = Array.prototype.slice.call(document.querySelectorAll("[data-query-link]"));

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

  window.addEventListener("hashchange", _e);
  _e();
})();
`);

  return `<!doctype html>
<html lang="${escapeHtml(labels.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; --bg:#f7f8fa; --panel:#fff; --text:#20242a; --muted:#68717d; --line:#d9dee7; --accent:#1769aa; --warn:#a94442; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.layout { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; min-height: 100vh; }
aside { position: sticky; top: 0; height: 100vh; overflow: auto; border-right: 1px solid var(--line); background: #eef2f6; padding: 18px; }
main { padding: 24px 28px 56px; min-width: 0; }
h1 { font-size: 28px; margin: 0 0 6px; }
h2 { font-size: 22px; margin: 34px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
h3 { font-size: 17px; margin: 22px 0 10px; }
.subtitle, .muted { color: var(--muted); }
.menu-title { font-weight: 700; margin: 18px 0 8px; }
.menu-list { list-style: none; padding: 0; margin: 0; }
.menu-list li { margin: 4px 0; overflow-wrap: anywhere; }
.menu-list a.active { font-weight: 700; color: var(--text); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; }
.view[hidden], .query-detail[hidden] { display: none; }
.file-summary { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.file-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.summary-table, .mini-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); }
.summary-table th, .summary-table td, .mini-table th, .mini-table td { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
.summary-table th, .mini-table th { background: #f0f3f7; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
pre { margin: 8px 0 14px; padding: 12px; overflow: auto; background: #111827; color: #e6edf3; border-radius: 6px; line-height: 1.45; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #f7f8fa; }
.badge.dynamic { border-color: #d8b365; background: #fff8e5; }
.missing-ref { color: var(--warn); font-weight: 600; }
.block-title { font-weight: 700; margin: 12px 0 6px; }
.block-title span { color: var(--muted); font-weight: 500; margin-left: 6px; }
.file-path { overflow-wrap: anywhere; }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } aside { position: relative; height: auto; } main { padding: 18px; } }
</style>
</head>
<body>
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
      <thead><tr><th>SQL ID</th><th>${escapeHtml(t("files"))}</th><th>${escapeHtml(t("type"))}</th><th>${escapeHtml(t("params"))}</th><th>appendQuery</th></tr></thead>
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
      <h4>${escapeHtml(t("appendQuery"))}</h4>
      <p>${renderReferenceLinks(query.references, knownIds, t("none"))}</p>
      ${query.entry.meta.builder ? `<h4>${escapeHtml(t("builder"))}</h4><pre><code>${escapeHtml(query.entry.meta.builder)}</code></pre>` : ""}
      <h4>${escapeHtml(t("sql"))}</h4>
      ${renderSqlBlocks(query.entry, dialect, labels)}
    </article>
  `).join("")}
</main>
</div>
<script>${script}</script>
</body>
</html>`;
}

export function generateDocs(paths: string[], options: GenerateDocsOptions): GenerateDocsResult {
  const { registry, errors, files } = loadRegistry(paths, options);
  const queries = errors.length === 0 ? buildQueryDocs(registry) : [];
  const outFile = path.resolve(options.outFile);
  const html = renderHtml(options.title || "sql-registry docs", options.dialect, files, queries, errors, options.lang);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, "utf8");

  return {
    ok: errors.length === 0,
    outFile,
    files,
    queries: queries.map(query => query.id),
    errors
  };
}

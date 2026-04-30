const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
import { extractNamedParams } from "./param-parser";
import { normalizeDialect } from "./dialect";
import { bindSql } from "./binder";
import { BuilderScriptProgram, compileBuilderScript, extractSlotNames, SqlBuilder, SqlBuilderError } from "./builder";
import { transpileBuilderScript } from "./builder-script";
import {
  buildParamTypeMap,
  normalizeParamType,
  validateParamTypes
} from "./param-types";

const QUERY_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const STATIC_SLOT_MARKER_PATTERN = /\/\*#[A-Za-z_][A-Za-z0-9_.-]*(?:\s+-\s*.*?)?\*\//s;

export type ParamMeta = {
  name: string;
  description: string;
  type?: string;
};

export type QueryMeta = {
  description?: string;
  tags?: string[];
  params: ParamMeta[];
  orderable?: Record<string, string>;
  builder?: string;
};

export type QueryEntry = {
  meta: QueryMeta;
  sql: Record<string, string>;
};

type QuerySourceInfo = {
  filePath: string;
  queryLine: number;
  sqlLines: Record<string, number>;
  builderLine?: number;
  paramLines: Record<string, number>;
};

export type ParseMarkdownResult = {
  queries: Record<string, QueryEntry>;
  errors: string[];
  files: string[];
};

export type ImportDirective = {
  path: string;
  namespace: string | null;
  description: string;
};

export type ImportDirectiveError = {
  error: string;
};

export type SqlRegistryOptions = {
  strict?: boolean;
  dialect?: string;
  compiledSqlCacheSize?: number;
};

export type BindOptions = {
  strict?: boolean;
  dialect?: string;
  compiledSqlCacheSize?: number;
};

export type BuilderOptions = {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  orderable?: Record<string, string>;
  dialect?: string;
  compiledSqlCacheSize?: number;
  runScript?: boolean;
  maxLimit?: number;
  maxOffset?: number;
};

type QueryRuntimeCache = {
  entry: QueryEntry;
  sql: string;
  builderScript?: string;
  params: ParamMeta[];
  paramTypes: Record<string, string>;
  baseParamNames: string[];
  allowedSlots: Set<string>;
  builderProgram: BuilderScriptProgram | null;
};

type AstNode = {
  type: string;
  [key: string]: unknown;
};

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function compileQueryBuilderProgram(name: string, code?: string) {
  if (!code) return null;

  try {
    return compileBuilderScript(code);
  } catch (err: unknown) {
    if (err instanceof SqlBuilderError) {
      throw err;
    }

    throw new SqlBuilderError(`failed to run builder script: ${getErrorMessage(err)}`, {
      queryName: name
    });
  }
}

function location(filePath: string, line?: number) {
  return line ? `${filePath}:${line}` : filePath;
}

function asAstNode(value: unknown): AstNode | null {
  return value && typeof value === "object" && "type" in value
    ? value as AstNode
    : null;
}

function astArray(value: unknown): AstNode[] {
  return Array.isArray(value)
    ? value.map(asAstNode).filter((node): node is AstNode => Boolean(node))
    : [];
}

function isImportDirectiveError(parsed: ImportDirective | ImportDirectiveError): parsed is ImportDirectiveError {
  return "error" in parsed;
}

export class SqlRegistryError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SqlRegistryError";
    this.details = details;
  }
}

export class SqlRegistryValidationError extends SqlRegistryError {
  errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message.startsWith("structure error:") ? message : `structure error: ${message}`, {
      category: "structure",
      errors
    });
    this.name = "SqlRegistryValidationError";
    this.errors = errors;
  }
}

function parseParamMeta(value: string): ParamMeta {
  const match = value.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_][A-Za-z0-9_]*))?(?:\s*-\s*(.+))?$/);
  if (!match) {
    throw new SqlRegistryError(`structure error: invalid param format: ${value}`, {
      category: "structure"
    });
  }

  const meta: ParamMeta = {
    name: match[1],
    description: match[3] ? match[3].trim() : ""
  };

  if (match[2]) {
    meta.type = normalizeParamType(match[2]) || undefined;
  }

  return meta;
}

function parseSqlInfo(info: string): { dialect: string | null; error?: string } {
  const parts = String(info || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] !== "sql") return { dialect: null };
  if (parts.length > 2) {
    return { dialect: null, error: `invalid sql fenced block info: ${info}` };
  }
  if (!parts[1] || parts[1] === "default") return { dialect: "default" };

  try {
    return { dialect: normalizeDialect(parts[1]) };
  } catch (err: unknown) {
    return { dialect: null, error: getErrorMessage(err) };
  }
}

function parseBuilderInfo(info: string) {
  const parts = String(info || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return false;
  return ["js", "ts"].includes(parts[0]) && parts[1] === "builder";
}

function formatFenceInfo(info: string) {
  return info ? info : "(empty)";
}

function stripMarkdownListMarker(text: string) {
  return text.replace(/^[-*+]\s+/, "");
}

function findDuplicates(arr: string[]) {
  const seen = new Set<string>();
  const dup = new Set<string>();

  for (const v of arr) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }

  return [...dup];
}

function isValidQueryId(name: string) {
  return QUERY_ID_PATTERN.test(name);
}

function parseQueryHeading(value: string) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\s+-\s+(.+))?$/);

  if (!match) {
    return {
      name: trimmed,
      description: ""
    };
  }

  return {
    name: match[1],
    description: match[2] ? match[2].trim() : ""
  };
}

function formatQueryHeading(name: string, description = "") {
  return description ? `${name} - ${description}` : name;
}

function applyNamespaceToHeadingLine(line: string, namespacePrefix: string) {
  if (!namespacePrefix) return line;

  return line.replace(/^##\s+(.+)$/, (_, name) => {
    const heading = parseQueryHeading(String(name));
    if (!heading.name) return `## ${heading.name}`;
    return `## ${formatQueryHeading(`${namespacePrefix}.${heading.name}`, heading.description)}`;
  });
}

function isFenceDelimiter(line: string) {
  return /^```/.test(line);
}

function validateEntry(name: string, entry: QueryEntry, source?: QuerySourceInfo) {
  const errors: string[] = [];
  const queryLoc = source ? location(source.filePath, source.queryLine) : "";
  const queryPrefix = queryLoc ? `${queryLoc}: ` : "";

  if (!entry.sql.default || !entry.sql.default.trim()) {
    errors.push(`${queryPrefix}[${name}] default sql block is required`);
  }

  const paramDefs = Array.isArray(entry.meta.params) ? entry.meta.params : [];
  const paramNames = paramDefs.map((p: ParamMeta) => p.name);
  const paramDefByName = new Map(paramDefs.map((p: ParamMeta) => [p.name, p]));
  const builderMeta = extractBuilderScriptMeta(entry.meta.builder || "");
  const declaredParamNames = [...new Set(paramNames)];
  const builderInputParamNames = new Set(builderMeta.inputParams);
  const dynamicallyBoundParamNames = new Set(builderMeta.boundParams);
  const internallyGeneratedParamNames = new Set(builderMeta.internalParams);

  for (const error of builderMeta.errors) {
    const builderLoc = source ? location(source.filePath, source.builderLine || source.queryLine) : "";
    errors.push(`${builderLoc ? `${builderLoc}: ` : ""}[${name}] ${error}`);
  }

  const dupParams = findDuplicates(paramNames);
  if (dupParams.length > 0) {
    errors.push(`${queryPrefix}[${name}] duplicate params in meta: ${dupParams.join(", ")}`);
  }

  const undeclaredInputParams = builderMeta.inputParams.filter((p: string) => !paramNames.includes(p));
  if (undeclaredInputParams.length > 0) {
    const builderLoc = source ? location(source.filePath, source.builderLine || source.queryLine) : "";
    errors.push(`${builderLoc ? `${builderLoc}: ` : ""}[${name}] params read in builder but not declared in meta: ${undeclaredInputParams.join(", ")}`);
  }

  const undeclaredBoundParams = builderMeta.boundParams.filter(
    (p: string) => !internallyGeneratedParamNames.has(p) && !paramNames.includes(p)
  );
  if (undeclaredBoundParams.length > 0) {
    const builderLoc = source ? location(source.filePath, source.builderLine || source.queryLine) : "";
    errors.push(`${builderLoc ? `${builderLoc}: ` : ""}[${name}] params bound in builder but not declared in meta: ${undeclaredBoundParams.join(", ")}`);
  }

  const inputParamsWithoutType = builderMeta.inputParams.filter((p: string) => {
    const def = paramDefByName.get(p);
    return def && !def.type;
  });
  if (inputParamsWithoutType.length > 0) {
    errors.push(`${queryPrefix}[${name}] params read in builder must declare a type: ${inputParamsWithoutType.join(", ")}`);
  }

  const inputParamsWithoutDescription = builderMeta.inputParams.filter((p: string) => {
    const def = paramDefByName.get(p);
    return def && !def.description;
  });
  if (inputParamsWithoutDescription.length > 0) {
    errors.push(`${queryPrefix}[${name}] params read in builder must declare a description: ${inputParamsWithoutDescription.join(", ")}`);
  }

  for (const [dialect, sqlValue] of Object.entries(entry.sql)) {
    const sqlLoc = source ? location(source.filePath, source.sqlLines[dialect] || source.queryLine) : "";
    const sqlPrefix = sqlLoc ? `${sqlLoc}: ` : "";
    const sql = String(sqlValue || "");
    if (!sql || !sql.trim()) {
      errors.push(`${sqlPrefix}[${name}][${dialect}] SQL block is empty`);
      continue;
    }

    const sqlParams: string[] = extractNamedParams(sql);
    const metaOnly = declaredParamNames.filter(
      p => !sqlParams.includes(p) &&
        !dynamicallyBoundParamNames.has(p) &&
        !builderInputParamNames.has(p)
    );
    const sqlOnly = sqlParams.filter((p: string) => !declaredParamNames.includes(p) && !internallyGeneratedParamNames.has(p));

    if (metaOnly.length > 0) {
      errors.push(
        `${sqlPrefix}[${name}][${dialect}] params declared in meta but not used in SQL: ${metaOnly.join(", ")}`
      );
    }

    if (sqlOnly.length > 0) {
      errors.push(
        `${sqlPrefix}[${name}][${dialect}] params used in SQL but not declared in meta: ${sqlOnly.join(", ")}`
      );
    }
  }

  return errors;
}

function validateQueryReferences(filePath: string, queries: Record<string, QueryEntry>, sources: Record<string, QuerySourceInfo> = {}) {
  const errors: string[] = [];
  const queryNames = Object.keys(queries);

  for (const [name, entry] of Object.entries(queries)) {
    const source = sources[name];
    const builderLoc = source ? location(filePath, source.builderLine || source.queryLine) : filePath;
    const builderMeta = extractBuilderScriptMeta(entry.meta.builder || "");
    const invalid = builderMeta.queryRefs.filter((queryName: string) => !isValidQueryId(queryName));
    const missing = builderMeta.queryRefs.filter(
      (queryName: string) => isValidQueryId(queryName) && !queryNames.includes(queryName)
    );

    if (invalid.length > 0) {
      errors.push(`${builderLoc}: [${name}] structure error: appendQuery references invalid query id: ${invalid.join(", ")}`);
    }

    if (missing.length > 0) {
      errors.push(`${builderLoc}: [${name}] structure error: appendQuery references unknown query: ${missing.join(", ")}`);
    }
  }

  return errors;
}

function extractBuilderScriptMeta(code: string) {
  const inputParams = new Set<string>();
  const boundParams = new Set<string>();
  const internalParams = new Set<string>();
  const queryRefs = new Set<string>();

  if (!code || !code.trim()) {
    return {
      inputParams: [],
      boundParams: [],
      internalParams: [],
      queryRefs: [],
      errors: []
    };
  }

  let ast;
  try {
    ast = acorn.parse(transpileBuilderScript(code, { throwOnDiagnostics: true }), {
      ecmaVersion: 2020,
      sourceType: "script"
    });
  } catch (err: unknown) {
    return {
      inputParams: [],
      boundParams: [],
      internalParams: [],
      queryRefs: [],
      errors: [`structure error: builder script parse error: ${getErrorMessage(err)}`]
    };
  }

  function visit(node: unknown) {
    const astNode = asAstNode(node);
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (
      astNode?.type === "MemberExpression" &&
      !astNode.computed &&
      asAstNode(astNode.object)?.type === "Identifier" &&
      asAstNode(astNode.object)?.name === "params" &&
      asAstNode(astNode.property)?.type === "Identifier"
    ) {
      inputParams.add(String(asAstNode(astNode.property)?.name));
    }

    if (astNode?.type === "CallExpression") {
      const calleeName = getCalleeName(astNode.callee);
      const objectArgIndex = calleeName === "param"
        ? 0
        : calleeName !== null && ["append", "appendQuery"].includes(calleeName)
          ? 2
          : calleeName === "set"
            ? 1
            : -1;

      if (objectArgIndex >= 0) {
        const objectArg = astArray(astNode.arguments)[objectArgIndex];
        if (objectArg && objectArg.type === "ObjectExpression") {
          for (const property of astArray(objectArg.properties)) {
            if (
              property.type === "Property" &&
              !property.computed &&
              property.key
            ) {
              const key = asAstNode(property.key);
              if (key?.type === "Identifier") {
                boundParams.add(String(key.name));
                if (calleeName === "param") internalParams.add(String(key.name));
              } else if (key?.type === "Literal") {
                boundParams.add(String(key.value));
                if (calleeName === "param") internalParams.add(String(key.value));
              }
            }
          }
        }
      }

      if (calleeName === "appendQuery") {
        const queryNameArgIndex = asAstNode(astNode.callee)?.type === "MemberExpression" ? 0 : 1;
        const queryNameArg = astArray(astNode.arguments)[queryNameArgIndex];
        if (queryNameArg?.type === "Literal" && typeof queryNameArg.value === "string") {
          queryRefs.add(String(queryNameArg.value));
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        visit(value);
      }
    }
  }

  visit(ast);

  return {
    inputParams: [...inputParams],
    boundParams: [...boundParams],
    internalParams: [...internalParams],
    queryRefs: [...queryRefs],
    errors: []
  };
}

function getCalleeName(callee: unknown) {
  const node = asAstNode(callee);
  if (!node) return null;
  if (node.type === "Identifier") return String(node.name);
  const property = asAstNode(node.property);
  if (node.type === "MemberExpression" && !node.computed && property?.type === "Identifier") {
    return String(property.name);
  }
  return null;
}

export function parseImportDirective(line: string): ImportDirective | ImportDirectiveError | null {
  const trimmed = line.trim();

  if (!trimmed.startsWith("@import ")) {
    return null;
  }

  // @import "./child.md"
  // @import "./child.md" as user
  // @import "./child.md" - 説明
  // @import "./child.md" as user - 説明
  const match = trimmed.match(
    /^@import\s+"([^"]+)"(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+-\s+(.+))?$/
  );

  if (!match) {
    return {
      error: `invalid import syntax: ${line}`
    };
  }

  return {
    path: match[1].trim(),
    namespace: match[2] ? match[2].trim() : null,
    description: match[3] ? match[3].trim() : ""
  };
}

export function resolveImports(
  filePath: string,
  stack: string[] = [],
  namespacePrefix = "",
  collectedFiles = new Set<string>()
): string {
  const fullPath = path.resolve(filePath);

  if (stack.includes(fullPath)) {
    throw new SqlRegistryError(
      `structure error: circular import detected: ${[...stack, fullPath].join(" -> ")}`,
      { category: "structure" }
    );
  }

  if (!fs.existsSync(fullPath)) {
    throw new SqlRegistryError(`structure error: markdown file not found: ${fullPath}`, {
      category: "structure"
    });
  }

  collectedFiles.add(fullPath);

  const src = fs.readFileSync(fullPath, "utf-8").replace(/^\uFEFF/, "");
  const dir = path.dirname(fullPath);
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const parsed = parseImportDirective(line);

    if (!parsed) {
      out.push(applyNamespaceToHeadingLine(line, namespacePrefix));
      continue;
    }

    if (isImportDirectiveError(parsed)) {
      throw new SqlRegistryError(`structure error: ${parsed.error} in ${fullPath}`, {
        category: "structure"
      });
    }

    const importTarget = parsed.path;
    const importNamespace = parsed.namespace;
    const importDescription = parsed.description;

    const childPath = path.resolve(dir, importTarget);
    const nextPrefix = importNamespace
      ? (namespacePrefix ? `${namespacePrefix}.${importNamespace}` : importNamespace)
      : namespacePrefix;

    const expanded = resolveImports(
      childPath,
      [...stack, fullPath],
      nextPrefix,
      collectedFiles
    );

    if (importDescription || importNamespace) {
      const metaParts: string[] = [];
      if (importNamespace) metaParts.push(`ns=${nextPrefix}`);
      if (importDescription) metaParts.push(`desc=${importDescription}`);
      out.push(`<!-- import: ${importTarget}${metaParts.length ? " | " + metaParts.join(" | ") : ""} -->`);
    }

    out.push(expanded);
  }

  return out.join("\n");
}

export function parseMarkdownFile(filePath: string): ParseMarkdownResult {
  const collectedFiles = new Set<string>();
  const src = resolveImports(filePath, [], "", collectedFiles);
  const lines = src.split(/\r?\n/);
  const queries: Record<string, QueryEntry> = {};
  const errors: string[] = [];
  const sources: Record<string, QuerySourceInfo> = {};

  let currentName: string | null = null;
  let currentMeta: Partial<QueryMeta> = {};
  let currentParams: ParamMeta[] = [];
  let currentSql: Record<string, string> = {};
  let currentDescriptionFromHeading = false;
  let currentQueryLine = 0;
  let currentSqlLines: Record<string, number> = {};
  let currentBuilderLine: number | undefined;
  let currentParamLines: Record<string, number> = {};

  function flush() {
    if (!currentName) return;

    if (queries[currentName]) {
      errors.push(`${location(filePath, currentQueryLine)}: duplicate query name in file: ${currentName}`);
      return;
    }

    const entry: QueryEntry = {
      meta: {
        ...currentMeta,
        params: currentParams
      } as QueryMeta,
      sql: currentSql
    };

    const source = {
      filePath,
      queryLine: currentQueryLine,
      sqlLines: currentSqlLines,
      builderLine: currentBuilderLine,
      paramLines: currentParamLines
    };
    errors.push(...validateEntry(currentName, entry, source));
    queries[currentName] = entry;
    sources[currentName] = source;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^##\s+(.+)$/);

    if (headingMatch) {
      flush();
      const heading = parseQueryHeading(headingMatch[1]);
      currentName = heading.name;
      currentMeta = heading.description ? { description: heading.description } : {};
      currentDescriptionFromHeading = Boolean(heading.description);
      currentParams = [];
      currentSql = {};
      currentQueryLine = i + 1;
      currentSqlLines = {};
      currentBuilderLine = undefined;
      currentParamLines = {};

      if (!currentName) {
        errors.push(`${location(filePath, i + 1)}: empty query name`);
      } else if (!isValidQueryId(currentName)) {
        errors.push(`${location(filePath, i + 1)}: [${currentName}] structure error: invalid query id: ${currentName}`);
      }

      continue;
    }

    if (!currentName) {
      if (isFenceDelimiter(line)) {
        const fenceLine = i + 1;
        let closed = false;

        while (++i < lines.length) {
          if (isFenceDelimiter(lines[i])) {
            closed = true;
            break;
          }
        }

        errors.push(`${location(filePath, fenceLine)}: fenced block outside query`);
        if (!closed) {
          errors.push(`${location(filePath, fenceLine)}: unclosed fenced block outside query`);
        }
      }

      continue;
    }

    const fenceMatch = isFenceDelimiter(line) ? line.match(/^```(.*)$/) : null;
    if (fenceMatch) {
      const fenceLine = i + 1;
      const info = fenceMatch[1].trim();
      const contentLines: string[] = [];
      let closed = false;

      while (++i < lines.length) {
        if (/^```/.test(lines[i])) {
          closed = true;
          break;
        }
        contentLines.push(lines[i]);
      }

      if (!closed) {
        errors.push(`${location(filePath, fenceLine)}: [${currentName}] unclosed fenced block`);
        break;
      }

      const content = contentLines.join("\n").trim();
      const sqlInfo = parseSqlInfo(info);
      if (sqlInfo.error) {
        errors.push(`${location(filePath, fenceLine)}: [${currentName}] ${sqlInfo.error}`);
        continue;
      }

      if (sqlInfo.dialect) {
        const dialect = sqlInfo.dialect;
        if (currentSql[dialect]) {
          errors.push(`${location(filePath, fenceLine)}: [${currentName}][${dialect}] duplicate sql block for dialect: ${dialect}`);
        } else {
          currentSql[dialect] = content;
          currentSqlLines[dialect] = fenceLine;
        }
        continue;
      }

      if (parseBuilderInfo(info)) {
        if ("builder" in currentMeta) {
          errors.push(`${location(filePath, fenceLine)}: [${currentName}] duplicate builder block`);
        } else {
          currentMeta.builder = content;
          currentBuilderLine = fenceLine;
        }
        continue;
      }

      errors.push(`${location(filePath, fenceLine)}: [${currentName}] unsupported fenced block info: ${formatFenceInfo(info)}`);
      continue;
    }

    const text = stripMarkdownListMarker(line.trim());
    if (!text) continue;
    if (text.startsWith("<!--")) {
      const commentLine = i + 1;
      let closed = text.includes("-->");
      while (!text.includes("-->") && i + 1 < lines.length) {
        i++;
        if (lines[i].includes("-->")) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        errors.push(`${location(filePath, commentLine)}: [${currentName}] unclosed HTML comment`);
      }
      continue;
    }

    if (text === "orderable:") {
      if ("orderable" in currentMeta) {
        errors.push(`${location(filePath, i + 1)}: [${currentName}] duplicate meta key: orderable`);
      } else {
        const orderable: Record<string, string> = {};
        let foundEntry = false;

        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (!nextLine.trim()) {
            i++;
            continue;
          }

          const orderableMatch = nextLine.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/);
          if (!orderableMatch) break;

          foundEntry = true;
          orderable[orderableMatch[1]] = orderableMatch[2].trim();
          i++;
        }

        if (!foundEntry) {
          errors.push(`${location(filePath, i + 1)}: [${currentName}] orderable block is empty`);
        } else {
          currentMeta.orderable = orderable;
        }
      }

      continue;
    }

    if (!text.startsWith("param:") && !text.includes(":")) {
      if ("description" in currentMeta) {
        currentMeta.description = [currentMeta.description, text]
          .filter(Boolean)
          .join("\n");
      }
      continue;
    }

    const idx = text.indexOf(":");
    const key = text.slice(0, idx).trim();
    const value = text.slice(idx + 1).trim();

    if (key === "param") {
      try {
        const param = parseParamMeta(value);
        currentParams.push(param);
        currentParamLines[param.name] = i + 1;
      } catch (err: unknown) {
        errors.push(`${location(filePath, i + 1)}: [${currentName}] ${getErrorMessage(err)}`);
      }
      continue;
    }

    if (key === "description") {
      if ("description" in currentMeta && !currentDescriptionFromHeading) {
        errors.push(`${location(filePath, i + 1)}: [${currentName}] duplicate meta key: description`);
      } else {
        currentMeta.description = value;
        currentDescriptionFromHeading = false;
      }
      continue;
    }

    if (key === "tags") {
      if ("tags" in currentMeta) {
        errors.push(`${location(filePath, i + 1)}: [${currentName}] duplicate meta key: tags`);
      } else {
        currentMeta.tags = value
          .split(",")
          .map((v: string) => v.trim())
          .filter(Boolean);
      }
      continue;
    }

    errors.push(`${location(filePath, i + 1)}: [${currentName}] unknown meta key: ${key}`);
  }

  flush();
  errors.push(...validateQueryReferences(filePath, queries, sources));

  return {
    queries,
    errors,
    files: [...collectedFiles]
  };
}

export function resolveSql(entry: QueryEntry | null | undefined, dialect: string) {
  if (!entry || !entry.sql) return null;
  return entry.sql[dialect] || entry.sql.default || null;
}

export class SqlRegistry {
  strict: boolean;
  dialect: string;
  compiledSqlCacheSize?: number;
  queries: Record<string, QueryEntry>;
  files: string[];
  private rootFiles: string[];
  private runtimeCache: Map<string, QueryRuntimeCache>;

  constructor(options: SqlRegistryOptions = {}) {
    this.strict = options.strict !== false;
    this.dialect = normalizeDialect(options.dialect);
    this.compiledSqlCacheSize = options.compiledSqlCacheSize;
    this.queries = {};
    this.files = [];
    this.rootFiles = [];
    this.runtimeCache = new Map();
  }

  private mergeParsedFile(filePath: string, result: ParseMarkdownResult) {
    for (const [name, entry] of Object.entries(result.queries)) {
      if (this.queries[name]) {
        const error = `duplicate query name across registry: ${name}`;
        if (this.strict) {
          throw new SqlRegistryValidationError("failed to merge registry", [`structure error: ${error}`]);
        }
        continue;
      }
      this.queries[name] = entry;
    }

    for (const file of result.files || [path.resolve(filePath)]) {
      if (!this.files.includes(file)) {
        this.files.push(file);
      }
    }

    return this;
  }

  loadFile(filePath: string) {
    const fullPath = path.resolve(filePath);
    const result = parseMarkdownFile(fullPath);

    if (result.errors.length > 0 && this.strict) {
      throw new SqlRegistryValidationError(
        "failed to load markdown registry file",
        result.errors
      );
    }

    this.mergeParsedFile(fullPath, result);
    this.runtimeCache.clear();

    if (!this.rootFiles.includes(fullPath)) {
      this.rootFiles.push(fullPath);
    }

    return this;
  }

  reload() {
    const rootFiles = [...this.rootFiles];
    const nextQueries: Record<string, QueryEntry> = {};
    const nextFiles: string[] = [];
    const errors: string[] = [];

    for (const filePath of rootFiles) {
      const result = parseMarkdownFile(filePath);
      errors.push(...result.errors);

      for (const [name, entry] of Object.entries(result.queries)) {
        if (nextQueries[name]) {
          const error = `structure error: duplicate query name across registry: ${name}`;
          errors.push(error);
          if (!this.strict) continue;
        }
        nextQueries[name] = entry;
      }

      for (const file of result.files || [filePath]) {
        if (!nextFiles.includes(file)) {
          nextFiles.push(file);
        }
      }
    }

    if (errors.length > 0 && this.strict) {
      throw new SqlRegistryValidationError(
        "failed to reload markdown registry files",
        errors
      );
    }

    this.queries = nextQueries;
    this.files = nextFiles;
    this.runtimeCache.clear();

    return this;
  }

  has(name: string) {
    return Boolean(this.queries[name]);
  }

  get(name: string) {
    const entry = this.queries[name];
    if (!entry) {
      throw new SqlRegistryError(`input error: query not found: ${name}`, {
        category: "input",
        queryName: name
      });
    }
    return entry;
  }

  getMeta(name: string) {
    return this.get(name).meta;
  }

  getSql(name: string) {
    const entry = this.get(name);
    const dialect = this.dialect || "default";
    const sql = entry.sql[dialect] || entry.sql.default;

    if (!sql) {
      throw new SqlRegistryError(`structure error: sql not found`, {
        category: "structure",
        queryName: name,
        dialect
      });
    }

    return sql;
  }

  isStatic(name: string) {
    const entry = this.get(name);
    if (entry.meta.builder) return false;
    return !STATIC_SLOT_MARKER_PATTERN.test(this.getSql(name));
  }

  private getRuntime(name: string) {
    const entry = this.get(name);
    const sql = this.getSql(name);
    const key = `${name}\0${this.dialect}`;
    const cached = this.runtimeCache.get(key);

    if (
      cached &&
      cached.entry === entry &&
      cached.sql === sql &&
      cached.builderScript === entry.meta.builder &&
      cached.params === entry.meta.params
    ) {
      return cached;
    }

    const runtime: QueryRuntimeCache = {
      entry,
      sql,
      builderScript: entry.meta.builder,
      params: entry.meta.params,
      paramTypes: buildParamTypeMap(entry.meta.params),
      baseParamNames: extractNamedParams(sql),
      allowedSlots: extractSlotNames(sql),
      builderProgram: compileQueryBuilderProgram(name, entry.meta.builder)
    };

    this.runtimeCache.set(key, runtime);
    return runtime;
  }

  bind(name: string, params: Record<string, unknown> = {}, options: BindOptions = {}) {
    const entry = this.get(name);
    const runtime = this.getRuntime(name);
    validateParamTypes(params, runtime.paramTypes, {
      queryName: name
    });
    return bindSql(runtime.sql, params, {
      dialect: this.dialect,
      queryName: name,
      compiledSqlCacheSize: this.compiledSqlCacheSize,
      ...options
    });
  }

  builder(name: string, options: BuilderOptions = {}) {
    const entry = this.get(name);
    const runtime = this.getRuntime(name);
    validateParamTypes(options.params || {}, runtime.paramTypes, {
      queryName: name
    });
    const orderable = {
      ...(entry.meta.orderable || {}),
      ...(options.orderable || {})
    };
    const builder = new SqlBuilder(this, name, runtime.sql, {
      ...options,
      dialect: options.dialect || this.dialect,
      compiledSqlCacheSize: options.compiledSqlCacheSize ?? this.compiledSqlCacheSize,
      orderable,
      paramTypes: runtime.paramTypes,
      allowedSlots: runtime.allowedSlots,
      baseParamNames: runtime.baseParamNames
    });
    const baseParams: Record<string, unknown> = {};
    const inputParams = options.params || {};

    for (const paramName of runtime.baseParamNames) {
      if (Object.prototype.hasOwnProperty.call(inputParams, paramName)) {
        baseParams[paramName] = inputParams[paramName];
      }
    }

    builder.addParams(baseParams);

    if (entry.meta.builder && options.runScript !== false) {
      builder.runCompiledBuilderScript(runtime.builderProgram, {
        params: inputParams,
        context: options.context || {}
      });
    }

    return builder;
  }

  list() {
    return Object.keys(this.queries).sort();
  }

  toJSON() {
    return {
      files: [...this.files],
      queries: this.queries
    };
  }
}

export { SqlBuilder, SqlBuilderError, extractNamedParams };

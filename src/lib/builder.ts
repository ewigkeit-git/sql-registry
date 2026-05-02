const acorn = require("acorn");
import { bindSql } from "./binder";
import { extractNamedParams } from "./param-parser";
import { buildExplain as buildExplainStmt } from "./explain-builder";
import { validateParamTypes } from "./param-types";
import { transpileBuilderScript } from "./builder-script";
import { LruCache } from "./lru-cache";

export class SqlBuilderError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message.startsWith("input error:") ? message : `input error: ${message}`);
    this.name = "SqlBuilderError";
    this.details = {
      category: "input",
      ...details
    };
  }
}

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

const BUILDER_FUNCTION_NAMES = new Set([
  "at",
  "append",
  "appendIf",
  "appendQuery",
  "appendQueryIf",
  "param",
  "set",
  "setIf",
  "orderBy",
  "limit",
  "offset"
]);

const SLOT_MARKER_PATTERN = /\/\*#([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+-\s*.*?)?\*\//gs;
const MAX_FRAGMENT_PARAM_CACHE_SIZE = 4096;
const fragmentParamCache = new LruCache<string, string[]>(MAX_FRAGMENT_PARAM_CACHE_SIZE);

type BuilderSlotApi = {
  __builderSlotApi: true;
  append: (sql: string, params?: Record<string, unknown>) => SqlBuilder;
  appendIf: (condition: unknown, sql: string, params?: Record<string, unknown>) => SqlBuilder;
  appendQuery: (queryName: string, params?: Record<string, unknown>) => SqlBuilder;
  appendQueryIf: (condition: unknown, queryName: string, params?: Record<string, unknown>) => SqlBuilder;
};

type SqlRegistryLike = {
  getSql: (queryName: string) => string;
};

export type SqlBuilderOptions = {
  dialect?: string;
  compiledSqlCacheSize?: number;
  orderable?: Record<string, string>;
  maxLimit?: number;
  maxOffset?: number;
  paramTypes?: Record<string, string>;
  allowedSlots?: Set<string> | string[];
  baseParamNames?: string[];
};

export type BindOptions = {
  strict?: boolean;
  dialect?: string;
  compiledSqlCacheSize?: number;
};

export type ExplainOptions = BindOptions & {
  dialect?: string;
  analyze?: boolean;
};

type BuilderScriptInput = {
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

type AstNode = {
  type: string;
  [key: string]: unknown;
};

type CompiledExpression =
  | { type: "array"; items: CompiledExpression[] }
  | { type: "binary"; operator: string; left: CompiledExpression; right: CompiledExpression }
  | { type: "conditional"; test: CompiledExpression; consequent: CompiledExpression; alternate: CompiledExpression }
  | { type: "literal"; value: unknown }
  | { type: "logical"; operator: string; left: CompiledExpression; right: CompiledExpression }
  | { type: "member"; root: "params" | "context"; key: string }
  | { type: "object"; properties: { key: string; value: CompiledExpression }[] }
  | { type: "template"; parts: (string | CompiledExpression)[] }
  | { type: "unary"; operator: string; argument: CompiledExpression }
  | { type: "undefined" };

type BuilderOp =
  | { type: "append"; slot: string; sql: string; params?: CompiledExpression; condition?: CompiledExpression }
  | { type: "appendQuery"; slot: string; queryName: string; params?: CompiledExpression; condition?: CompiledExpression }
  | { type: "limit"; slot: string; value: CompiledExpression }
  | { type: "offset"; slot: string; value: CompiledExpression }
  | { type: "orderBy"; slot: string; columnKey: CompiledExpression; asc?: CompiledExpression }
  | { type: "param"; params: CompiledExpression }
  | { type: "set"; sql: string; params?: CompiledExpression; condition?: CompiledExpression };

export type BuilderScriptProgram = {
  ast: AstNode;
  ops: BuilderOp[] | null;
};

type EvalEnv = Record<string, unknown>;

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
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

function assertSafeKey(key: string) {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new SqlBuilderError(`forbidden property access: ${key}`);
  }
}

function getFragmentParamNames(sql: string) {
  const cached = fragmentParamCache.get(sql);
  if (cached) return cached;

  const names = extractNamedParams(sql);
  fragmentParamCache.set(sql, names);
  return names;
}

function validateAppendParams(sql: string, params: Record<string, unknown>, details: Record<string, unknown>) {
  const sqlParamNames: string[] = getFragmentParamNames(sql);
  const paramNames = Object.keys(params);
  const missing = sqlParamNames.filter(name => !paramNames.includes(name));
  const extra = paramNames.filter(name => !sqlParamNames.includes(name));

  if (missing.length > 0) {
    throw new SqlBuilderError(`append params missing for SQL params: ${missing.join(", ")}`, {
      ...details,
      missing,
      allowed: sqlParamNames
    });
  }

  if (extra.length > 0) {
    throw new SqlBuilderError(`append params not used in SQL: ${extra.join(", ")}`, {
      ...details,
      extra,
      allowed: sqlParamNames
    });
  }
}

function createPlainObject() {
  return Object.create(null);
}

function countAstNodes(node: unknown): number {
  if (!node || typeof node !== "object") return 0;

  let count = 1;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) count += countAstNodes(item);
      continue;
    }

    count += countAstNodes(value);
  }

  return count;
}

function isLoopStatement(node: AstNode | null) {
  return node !== null && [
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "WhileStatement",
    "DoWhileStatement"
  ].includes(node.type);
}

function validateControlFlowDepth(node: unknown, state = { ifDepth: 0 }): void {
  const astNode = asAstNode(node);
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) {
      validateControlFlowDepth(item, state);
    }
    return;
  }

  const nextState = {
    ifDepth: state.ifDepth
  };

  if (astNode?.type === "IfStatement") {
    nextState.ifDepth += 1;
    if (nextState.ifDepth > 2) {
      throw new SqlBuilderError("if nesting exceeds the allowed depth");
    }
  }

  if (isLoopStatement(astNode)) {
    throw new SqlBuilderError("loop statements are not allowed");
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      validateControlFlowDepth(value, nextState);
    }
  }
}

function getPropertyKey(node: AstNode) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  throw new SqlBuilderError(`unsupported property key: ${node.type}`);
}

function assertStaticStringArgument(args: AstNode[], index: number, description: string) {
  const arg = args[index];

  if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
    throw new SqlBuilderError(`${description} must be a string literal`);
  }
}

function assertObjectExpressionArgument(args: AstNode[], index: number, description: string) {
  const arg = args[index];

  if (arg && arg.type !== "ObjectExpression") {
    throw new SqlBuilderError(`${description} must be an object literal`);
  }
}

function assertNonEmptyObjectExpressionArgument(args: AstNode[], index: number, description: string) {
  const arg = args[index];

  if (!arg) return;

  if (arg.type !== "ObjectExpression") {
    throw new SqlBuilderError(`${description} must be an object literal`);
  }

  if (astArray(arg.properties).length === 0) {
    throw new SqlBuilderError(`${description} must not be empty`);
  }
}

function validateBuilderCallArguments(node: AstNode) {
  const callee = asAstNode(node.callee);
  const args = astArray(node.arguments);
  if (!callee) return;

  if (callee.type === "Identifier") {
    switch (String(callee.name)) {
      case "at":
        assertStaticStringArgument(args, 0, "slot name");
        return;
      case "append":
        assertStaticStringArgument(args, 0, "slot name");
        assertStaticStringArgument(args, 1, "append SQL");
        assertObjectExpressionArgument(args, 2, "append params");
        return;
      case "appendIf":
        assertStaticStringArgument(args, 0, "slot name");
        assertStaticStringArgument(args, 2, "append SQL");
        assertObjectExpressionArgument(args, 3, "append params");
        return;
      case "appendQuery":
        assertStaticStringArgument(args, 0, "slot name");
        assertStaticStringArgument(args, 1, "query name");
        assertNonEmptyObjectExpressionArgument(args, 2, "appendQuery params");
        return;
      case "appendQueryIf":
        assertStaticStringArgument(args, 0, "slot name");
        assertStaticStringArgument(args, 2, "query name");
        assertNonEmptyObjectExpressionArgument(args, 3, "appendQuery params");
        return;
      case "param":
        assertObjectExpressionArgument(args, 0, "param params");
        return;
      case "set":
        assertStaticStringArgument(args, 0, "set SQL");
        assertObjectExpressionArgument(args, 1, "set params");
        return;
      case "setIf":
        assertStaticStringArgument(args, 1, "set SQL");
        assertObjectExpressionArgument(args, 2, "set params");
        return;
      case "orderBy":
      case "limit":
      case "offset":
        assertStaticStringArgument(args, 0, "slot name");
        return;
      default:
        return;
    }
  }

  if (callee.type === "MemberExpression") {
    if (callee.computed) {
      throw new SqlBuilderError("computed helper methods are not allowed");
    }

    const property = asAstNode(callee.property);
    const key = property ? String(property.name) : "";

    if (key === "append") {
      assertStaticStringArgument(args, 0, "append SQL");
      assertObjectExpressionArgument(args, 1, "append params");
    }

    if (key === "appendIf") {
      assertStaticStringArgument(args, 1, "append SQL");
      assertObjectExpressionArgument(args, 2, "append params");
    }

    if (key === "appendQuery") {
      assertStaticStringArgument(args, 0, "query name");
      assertNonEmptyObjectExpressionArgument(args, 1, "appendQuery params");
    }

    if (key === "appendQueryIf") {
      assertStaticStringArgument(args, 1, "query name");
      assertNonEmptyObjectExpressionArgument(args, 2, "appendQuery params");
    }
  }
}

function validateBuilderCallExpressionTree(node: AstNode | null): void {
  if (!node) return;

  if (node.type === "CallExpression") {
    validateBuilderCallArguments(node);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        validateBuilderCallExpressionTree(asAstNode(item));
      }
      continue;
    }

    validateBuilderCallExpressionTree(asAstNode(value));
  }
}

function validateExecutableBuilderCalls(node: AstNode): void {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
      for (const statement of astArray(node.body)) {
        validateExecutableBuilderCalls(statement);
      }
      return;

    case "VariableDeclaration":
      for (const declaration of astArray(node.declarations)) {
        validateBuilderCallExpressionTree(asAstNode(declaration.init));
      }
      return;

    case "ExpressionStatement":
      validateBuilderCallExpressionTree(asAstNode(node.expression));
      return;

    case "IfStatement":
      validateBuilderCallExpressionTree(asAstNode(node.test));
      {
        const consequent = asAstNode(node.consequent);
        if (consequent) validateExecutableBuilderCalls(consequent);
        const alternate = asAstNode(node.alternate);
        if (alternate) validateExecutableBuilderCalls(alternate);
      }
      return;

    case "EmptyStatement":
      return;

    default:
      return;
  }
}

function combineConditions(left: CompiledExpression | undefined, right: CompiledExpression | undefined) {
  if (!left) return right;
  if (!right) return left;
  return {
    type: "logical",
    operator: "&&",
    left,
    right
  } as CompiledExpression;
}

function literalString(node: AstNode | undefined) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? String(node.value)
    : null;
}

function compileExpression(node: AstNode | null): CompiledExpression | null {
  if (!node) return null;

  switch (node.type) {
    case "Literal":
      return { type: "literal", value: node.value };

    case "Identifier":
      return node.name === "undefined" ? { type: "undefined" } : null;

    case "MemberExpression": {
      if (node.computed) return null;
      const object = asAstNode(node.object);
      const property = asAstNode(node.property);
      if (
        object?.type !== "Identifier" ||
        !["params", "context"].includes(String(object.name)) ||
        property?.type !== "Identifier"
      ) {
        return null;
      }

      const key = String(property.name);
      if (FORBIDDEN_KEYS.has(key)) return null;
      return {
        type: "member",
        root: String(object.name) as "params" | "context",
        key
      };
    }

    case "ObjectExpression": {
      const properties: { key: string; value: CompiledExpression }[] = [];
      for (const property of astArray(node.properties)) {
        if (property.type !== "Property" || property.kind !== "init" || property.computed) return null;
        const keyNode = asAstNode(property.key);
        const value = compileExpression(asAstNode(property.value));
        if (!keyNode || !value) return null;
        const key = String(getPropertyKey(keyNode));
        if (FORBIDDEN_KEYS.has(key)) return null;
        properties.push({ key, value });
      }
      return { type: "object", properties };
    }

    case "ArrayExpression": {
      const items: CompiledExpression[] = [];
      for (const element of Array.isArray(node.elements) ? node.elements : []) {
        const item = compileExpression(asAstNode(element));
        if (!item) return null;
        items.push(item);
      }
      return { type: "array", items };
    }

    case "TemplateLiteral": {
      const parts: (string | CompiledExpression)[] = [];
      const quasis = astArray(node.quasis);
      const expressions = astArray(node.expressions);
      for (let i = 0; i < quasis.length; i++) {
        const value = quasis[i].value as { cooked?: string } | undefined;
        parts.push(value?.cooked || "");
        if (i < expressions.length) {
          const expression = compileExpression(expressions[i]);
          if (!expression) return null;
          parts.push(expression);
        }
      }
      return { type: "template", parts };
    }

    case "UnaryExpression": {
      const argument = compileExpression(asAstNode(node.argument));
      if (!argument || !["!", "+", "-"].includes(String(node.operator))) return null;
      return { type: "unary", operator: String(node.operator), argument };
    }

    case "BinaryExpression": {
      const left = compileExpression(asAstNode(node.left));
      const right = compileExpression(asAstNode(node.right));
      if (!left || !right) return null;
      return { type: "binary", operator: String(node.operator), left, right };
    }

    case "LogicalExpression": {
      const operator = String(node.operator);
      if (!["&&", "||"].includes(operator)) return null;
      const left = compileExpression(asAstNode(node.left));
      const right = compileExpression(asAstNode(node.right));
      if (!left || !right) return null;
      return { type: "logical", operator, left, right };
    }

    case "ConditionalExpression": {
      const test = compileExpression(asAstNode(node.test));
      const consequent = compileExpression(asAstNode(node.consequent));
      const alternate = compileExpression(asAstNode(node.alternate));
      if (!test || !consequent || !alternate) return null;
      return { type: "conditional", test, consequent, alternate };
    }

    default:
      return null;
  }
}

function compileAtSlotCall(node: AstNode | null) {
  if (!node || node.type !== "CallExpression") return null;
  const callee = asAstNode(node.callee);
  if (callee?.type !== "Identifier" || callee.name !== "at") return null;
  return literalString(astArray(node.arguments)[0]);
}

function compileOptionalExpression(node: AstNode | undefined): CompiledExpression | null | undefined {
  if (node === undefined) return undefined;
  return compileExpression(node);
}

function compileHelperCall(node: AstNode, condition?: CompiledExpression): BuilderOp | null {
  if (node.type !== "CallExpression") return null;
  const callee = asAstNode(node.callee);
  const args = astArray(node.arguments);

  if (callee?.type === "Identifier") {
    const name = String(callee.name);
    if (name === "append") {
      const slot = literalString(args[0]);
      const sql = literalString(args[1]);
      const params = compileOptionalExpression(args[2]);
      if (!slot || !sql) return null;
      if (params === null) return null;
      return { type: "append", slot, sql, params, condition };
    }
    if (name === "appendIf") {
      const slot = literalString(args[0]);
      const callCondition = compileExpression(args[1]);
      const sql = literalString(args[2]);
      const params = compileOptionalExpression(args[3]);
      if (!slot || !callCondition || !sql) return null;
      if (params === null) return null;
      return { type: "append", slot, sql, params, condition: combineConditions(condition, callCondition) };
    }
    if (name === "appendQuery") {
      const slot = literalString(args[0]);
      const queryName = literalString(args[1]);
      const params = compileOptionalExpression(args[2]);
      if (!slot || !queryName) return null;
      if (params === null) return null;
      return { type: "appendQuery", slot, queryName, params, condition };
    }
    if (name === "appendQueryIf") {
      const slot = literalString(args[0]);
      const callCondition = compileExpression(args[1]);
      const queryName = literalString(args[2]);
      const params = compileOptionalExpression(args[3]);
      if (!slot || !callCondition || !queryName) return null;
      if (params === null) return null;
      return { type: "appendQuery", slot, queryName, params, condition: combineConditions(condition, callCondition) };
    }
    if (name === "param") {
      const params = compileExpression(args[0]);
      return params ? { type: "param", params } : null;
    }
    if (name === "set") {
      const sql = literalString(args[0]);
      const params = compileOptionalExpression(args[1]);
      if (!sql) return null;
      if (params === null) return null;
      return { type: "set", sql, params, condition };
    }
    if (name === "setIf") {
      const callCondition = compileExpression(args[0]);
      const sql = literalString(args[1]);
      const params = compileOptionalExpression(args[2]);
      if (!callCondition || !sql) return null;
      if (params === null) return null;
      return { type: "set", sql, params, condition: combineConditions(condition, callCondition) };
    }
    if (name === "orderBy") {
      const slot = literalString(args[0]);
      const columnKey = compileExpression(args[1]);
      const asc = compileOptionalExpression(args[2]);
      if (!slot || !columnKey) return null;
      if (asc === null) return null;
      return { type: "orderBy", slot, columnKey, asc };
    }
    if (name === "limit" || name === "offset") {
      const slot = literalString(args[0]);
      const value = compileExpression(args[1]);
      if (!slot || !value) return null;
      return { type: name, slot, value };
    }
  }

  if (callee?.type === "MemberExpression" && !callee.computed) {
    const slot = compileAtSlotCall(asAstNode(callee.object));
    const property = asAstNode(callee.property);
    if (!slot || property?.type !== "Identifier") return null;
    const name = String(property.name);
    if (name === "append") {
      const sql = literalString(args[0]);
      const params = compileOptionalExpression(args[1]);
      if (!sql) return null;
      if (params === null) return null;
      return { type: "append", slot, sql, params, condition };
    }
    if (name === "appendIf") {
      const callCondition = compileExpression(args[0]);
      const sql = literalString(args[1]);
      const params = compileOptionalExpression(args[2]);
      if (!callCondition || !sql) return null;
      if (params === null) return null;
      return { type: "append", slot, sql, params, condition: combineConditions(condition, callCondition) };
    }
    if (name === "appendQuery") {
      const queryName = literalString(args[0]);
      const params = compileOptionalExpression(args[1]);
      if (!queryName) return null;
      if (params === null) return null;
      return { type: "appendQuery", slot, queryName, params, condition };
    }
    if (name === "appendQueryIf") {
      const callCondition = compileExpression(args[0]);
      const queryName = literalString(args[1]);
      const params = compileOptionalExpression(args[2]);
      if (!callCondition || !queryName) return null;
      if (params === null) return null;
      return { type: "appendQuery", slot, queryName, params, condition: combineConditions(condition, callCondition) };
    }
  }

  return null;
}

function compileStatementOps(node: AstNode, condition?: CompiledExpression): BuilderOp[] | null {
  switch (node.type) {
    case "ExpressionStatement": {
      const expression = asAstNode(node.expression);
      if (!expression) return null;
      const op = compileHelperCall(expression, condition);
      return op ? [op] : null;
    }

    case "BlockStatement": {
      const ops: BuilderOp[] = [];
      for (const statement of astArray(node.body)) {
        const statementOps = compileStatementOps(statement, condition);
        if (!statementOps) return null;
        ops.push(...statementOps);
      }
      return ops;
    }

    case "IfStatement": {
      if (node.alternate) return null;
      const test = compileExpression(asAstNode(node.test));
      const consequent = asAstNode(node.consequent);
      if (!test || !consequent) return null;
      return compileStatementOps(consequent, combineConditions(condition, test));
    }

    case "EmptyStatement":
      return [];

    default:
      return null;
  }
}

function tryCompileBuilderOps(ast: AstNode): BuilderOp[] | null {
  if (ast.type !== "Program") return null;
  const ops: BuilderOp[] = [];

  for (const statement of astArray(ast.body)) {
    const statementOps = compileStatementOps(statement);
    if (!statementOps) return null;
    ops.push(...statementOps);
  }

  return ops;
}

export function extractSlotNames(sql: string): Set<string> {
  const names = new Set<string>();
  const regex = new RegExp(SLOT_MARKER_PATTERN);
  let match;

  while ((match = regex.exec(sql)) !== null) {
    names.add(match[1]);
  }

  return names;
}

function hasTopLevelWhere(sql: string) {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let dollarQuote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, i)) {
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        if (quote === "'" && next === "'") {
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (char === "(") {
      depth++;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && /\bwhere\b/i.test(sql.slice(i, i + 5))) {
      const before = i === 0 ? "" : sql[i - 1];
      const after = sql[i + 5] || "";
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
        return true;
      }
    }
  }

  return false;
}

function renderSlot(slotName: string, fragments: string[], baseSql: string, markerOffset: number, joiner: string) {
  if (slotName !== "where" || fragments.length === 0 || hasTopLevelWhere(baseSql.slice(0, markerOffset))) {
    return fragments.join(joiner);
  }

  const [first, ...rest] = fragments;
  const normalizedFirst = /^where\b/i.test(first)
    ? first
    : `WHERE ${first.replace(/^(?:and|or)\b\s*/i, "")}`;

  return [normalizedFirst, ...rest].join(joiner);
}

function normalizeNonNegativeInteger(name: string, value: unknown, max: number) {
  const numberValue = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;

  if (
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    numberValue < 0
  ) {
    throw new SqlBuilderError(`${name} must be a non-negative integer`, {
      value
    });
  }

  if (numberValue > max) {
    throw new SqlBuilderError(`${name} exceeds maximum value: ${max}`, {
      value: numberValue,
      max
    });
  }

  return numberValue;
}

function encodeParamNamePart(value: string) {
  return value.replace(/[^A-Za-z0-9_]/g, char => `_x${char.charCodeAt(0).toString(16)}_`);
}

function pagingParamName(name: "limit" | "offset", slotName: string) {
  return `${name}_${encodeParamNamePart(slotName)}`;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function evaluateUnaryExpression(node: AstNode, env: EvalEnv): unknown {
  const argument = asAstNode(node.argument);
  const value = argument ? evaluateExpression(argument, env) : undefined;

  switch (node.operator) {
    case "!":
      return !value;
    case "+":
      return +toNumber(value);
    case "-":
      return -toNumber(value);
    default:
      throw new SqlBuilderError(`unsupported unary operator: ${node.operator}`);
  }
}

function evaluateBinaryExpression(node: AstNode, env: EvalEnv): unknown {
  const leftNode = asAstNode(node.left);
  const rightNode = asAstNode(node.right);
  const left = leftNode ? evaluateExpression(leftNode, env) : undefined;
  const right = rightNode ? evaluateExpression(rightNode, env) : undefined;
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);

  switch (node.operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      return left == right; // eslint-disable-line eqeqeq
    case "!=":
      return left != right; // eslint-disable-line eqeqeq
    case ">":
      return leftNumber > rightNumber;
    case ">=":
      return leftNumber >= rightNumber;
    case "<":
      return leftNumber < rightNumber;
    case "<=":
      return leftNumber <= rightNumber;
    case "+":
      return typeof left === "string" || typeof right === "string"
        ? String(left) + String(right)
        : leftNumber + rightNumber;
    case "-":
      return leftNumber - rightNumber;
    case "*":
      return leftNumber * rightNumber;
    case "/":
      return leftNumber / rightNumber;
    case "%":
      return leftNumber % rightNumber;
    default:
      throw new SqlBuilderError(`unsupported binary operator: ${node.operator}`);
  }
}

function evaluateLogicalExpression(node: AstNode, env: EvalEnv): unknown {
  if (node.operator === "&&") {
    const leftNode = asAstNode(node.left);
    const rightNode = asAstNode(node.right);
    return (leftNode ? evaluateExpression(leftNode, env) : undefined) &&
      (rightNode ? evaluateExpression(rightNode, env) : undefined);
  }

  if (node.operator === "||") {
    const leftNode = asAstNode(node.left);
    const rightNode = asAstNode(node.right);
    return (leftNode ? evaluateExpression(leftNode, env) : undefined) ||
      (rightNode ? evaluateExpression(rightNode, env) : undefined);
  }

  throw new SqlBuilderError(`unsupported logical operator: ${node.operator}`);
}

function evaluateMemberExpression(node: AstNode, env: EvalEnv): unknown {
  const objectNode = asAstNode(node.object);
  const target = objectNode ? evaluateExpression(objectNode, env) : undefined;
  if (target == null) {
    throw new SqlBuilderError("cannot read property of null or undefined");
  }

  const propertyNode = asAstNode(node.property);
  const key = node.computed
    ? String(propertyNode ? evaluateExpression(propertyNode, env) : "")
    : String(propertyNode ? propertyNode.name : "");

  assertSafeKey(key);
  return (target as Record<string, unknown>)[key];
}

function evaluateCallExpression(node: AstNode, env: EvalEnv): unknown {
  const args = astArray(node.arguments).map((argument: AstNode) => {
    if (argument.type === "SpreadElement") {
      throw new SqlBuilderError("spread arguments are not allowed");
    }
    return evaluateExpression(argument, env);
  });

  const callee = asAstNode(node.callee);
  if (callee && callee.type === "Identifier") {
    if (!BUILDER_FUNCTION_NAMES.has(String(callee.name))) {
      throw new SqlBuilderError(`unsupported function: ${String(callee.name)}`);
    }

    const fn = env[String(callee.name)];
    if (typeof fn !== "function") {
      throw new SqlBuilderError(`unsupported function: ${String(callee.name)}`);
    }
    return fn(...args);
  }

  if (callee && callee.type === "MemberExpression") {
    const objectNode = asAstNode(callee.object);
    const propertyNode = asAstNode(callee.property);
    const target = objectNode ? evaluateExpression(objectNode, env) : undefined;
    const key = callee.computed
      ? String(propertyNode ? evaluateExpression(propertyNode, env) : "")
      : String(propertyNode ? propertyNode.name : "");

    assertSafeKey(key);

    if (!target || (target as Record<string, unknown>).__builderSlotApi !== true) {
      throw new SqlBuilderError("method calls are only allowed on at(...) helpers");
    }

    const fn = (target as Record<string, unknown>)[key];
    if (typeof fn !== "function") {
      throw new SqlBuilderError(`unsupported helper method: ${key}`);
    }

    return fn(...args);
  }

  throw new SqlBuilderError(`unsupported callee: ${callee ? callee.type : "unknown"}`);
}

function evaluateExpression(node: AstNode, env: EvalEnv): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;

    case "TemplateLiteral":
      return astArray(node.quasis).reduce((out: string, quasi: AstNode, index: number) => {
        const value = quasi.value as { cooked?: string } | undefined;
        let next = out + (value?.cooked || "");
        const expressions = astArray(node.expressions);
        if (index < expressions.length) {
          next += String(evaluateExpression(expressions[index], env));
        }
        return next;
      }, "");

    case "Identifier":
      if (node.name === "undefined") return undefined;
      if (!(String(node.name) in env)) {
        throw new SqlBuilderError(`unknown identifier: ${node.name}`);
      }
      return env[String(node.name)];

    case "ObjectExpression": {
      const out: Record<string, unknown> = createPlainObject();

      for (const property of astArray(node.properties)) {
        if (property.type !== "Property" || property.kind !== "init") {
          throw new SqlBuilderError(`unsupported object property: ${property.type}`);
        }
        if (property.computed) {
          throw new SqlBuilderError("computed object keys are not allowed");
        }

        const keyNode = asAstNode(property.key);
        if (!keyNode) throw new SqlBuilderError("unsupported object property key");
        const key = String(getPropertyKey(keyNode));
        assertSafeKey(key);
        const valueNode = asAstNode(property.value);
        out[key] = valueNode ? evaluateExpression(valueNode, env) : undefined;
      }

      return out;
    }

    case "ArrayExpression":
      return (Array.isArray(node.elements) ? node.elements : []).map((element: unknown) => {
        const elementNode = asAstNode(element);
        if (!element) return null;
        return elementNode ? evaluateExpression(elementNode, env) : null;
      });

    case "UnaryExpression":
      return evaluateUnaryExpression(node, env);

    case "BinaryExpression":
      return evaluateBinaryExpression(node, env);

    case "LogicalExpression":
      return evaluateLogicalExpression(node, env);

    case "ConditionalExpression":
      {
        const testNode = asAstNode(node.test);
        const consequentNode = asAstNode(node.consequent);
        const alternateNode = asAstNode(node.alternate);
        return (testNode ? evaluateExpression(testNode, env) : undefined)
          ? (consequentNode ? evaluateExpression(consequentNode, env) : undefined)
          : (alternateNode ? evaluateExpression(alternateNode, env) : undefined);
      }

    case "MemberExpression":
      return evaluateMemberExpression(node, env);

    case "CallExpression":
      return evaluateCallExpression(node, env);

    default:
      throw new SqlBuilderError(`unsupported expression: ${node.type}`);
  }
}

function executeStatement(node: AstNode, env: EvalEnv): void {
  switch (node.type) {
    case "VariableDeclaration":
      if (!["const", "let"].includes(String(node.kind))) {
        throw new SqlBuilderError(`unsupported variable declaration: ${node.kind}`);
      }

      for (const declaration of astArray(node.declarations)) {
        const idNode = asAstNode(declaration.id);
        if (!idNode || idNode.type !== "Identifier") {
          throw new SqlBuilderError(`unsupported variable pattern: ${idNode ? idNode.type : "unknown"}`);
        }

        const varName = String(idNode.name);
        assertSafeKey(varName);
        const initNode = asAstNode(declaration.init);
        env[varName] = initNode
          ? evaluateExpression(initNode, env)
          : undefined;
      }
      return;

    case "ExpressionStatement":
      {
        const expressionNode = asAstNode(node.expression);
        if (expressionNode) evaluateExpression(expressionNode, env);
      }
      return;

    case "IfStatement":
      if (asAstNode(node.test) && evaluateExpression(asAstNode(node.test) as AstNode, env)) {
        const consequent = asAstNode(node.consequent);
        if (consequent) executeStatement(consequent, env);
      } else {
        const alternate = asAstNode(node.alternate);
        if (alternate) executeStatement(alternate, env);
      }
      return;

    case "BlockStatement":
      for (const statement of astArray(node.body)) {
        executeStatement(statement, env);
      }
      return;

    case "EmptyStatement":
      return;

    default:
      throw new SqlBuilderError(`unsupported statement: ${node.type}`);
  }
}

function executeAst(ast: AstNode, env: EvalEnv): void {
  for (const statement of astArray(ast.body)) {
    executeStatement(statement, env);
  }
}

function evaluateCompiledExpression(expression: CompiledExpression, input: BuilderScriptInput): unknown {
  const params = input.params || {};
  const context = input.context || {};

  switch (expression.type) {
    case "literal":
      return expression.value;

    case "undefined":
      return undefined;

    case "member":
      return expression.root === "params"
        ? params[expression.key]
        : context[expression.key];

    case "object": {
      const out: Record<string, unknown> = createPlainObject();
      for (const property of expression.properties) {
        out[property.key] = evaluateCompiledExpression(property.value, input);
      }
      return out;
    }

    case "array":
      return expression.items.map(item => evaluateCompiledExpression(item, input));

    case "template":
      return expression.parts.reduce((out: string, part) => {
        return out + (typeof part === "string" ? part : String(evaluateCompiledExpression(part, input)));
      }, "");

    case "unary": {
      const value = evaluateCompiledExpression(expression.argument, input);
      switch (expression.operator) {
        case "!":
          return !value;
        case "+":
          return +toNumber(value);
        case "-":
          return -toNumber(value);
        default:
          throw new SqlBuilderError(`unsupported unary operator: ${expression.operator}`);
      }
    }

    case "binary": {
      const left = evaluateCompiledExpression(expression.left, input);
      const right = evaluateCompiledExpression(expression.right, input);
      const leftNumber = toNumber(left);
      const rightNumber = toNumber(right);

      switch (expression.operator) {
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "==":
          return left == right; // eslint-disable-line eqeqeq
        case "!=":
          return left != right; // eslint-disable-line eqeqeq
        case ">":
          return leftNumber > rightNumber;
        case ">=":
          return leftNumber >= rightNumber;
        case "<":
          return leftNumber < rightNumber;
        case "<=":
          return leftNumber <= rightNumber;
        case "+":
          return typeof left === "string" || typeof right === "string"
            ? String(left) + String(right)
            : leftNumber + rightNumber;
        case "-":
          return leftNumber - rightNumber;
        case "*":
          return leftNumber * rightNumber;
        case "/":
          return leftNumber / rightNumber;
        case "%":
          return leftNumber % rightNumber;
        default:
          throw new SqlBuilderError(`unsupported binary operator: ${expression.operator}`);
      }
    }

    case "logical":
      return expression.operator === "&&"
        ? evaluateCompiledExpression(expression.left, input) && evaluateCompiledExpression(expression.right, input)
        : evaluateCompiledExpression(expression.left, input) || evaluateCompiledExpression(expression.right, input);

    case "conditional":
      return evaluateCompiledExpression(expression.test, input)
        ? evaluateCompiledExpression(expression.consequent, input)
        : evaluateCompiledExpression(expression.alternate, input);
  }
}

function evaluateCompiledParams(expression: CompiledExpression | undefined, input: BuilderScriptInput) {
  return (expression ? evaluateCompiledExpression(expression, input) : {}) as Record<string, unknown>;
}

function shouldRunOp(op: BuilderOp, input: BuilderScriptInput) {
  return !("condition" in op) || !op.condition || Boolean(evaluateCompiledExpression(op.condition, input));
}

export function compileBuilderScript(code: string): BuilderScriptProgram | null {
  if (!code || !code.trim()) return null;
  const runnableCode = transpileBuilderScript(code);
  const ast = acorn.parse(runnableCode, {
    ecmaVersion: 2020,
    sourceType: "script"
  });

  if (countAstNodes(ast) > 1000) {
    throw new SqlBuilderError("builder script is too large");
  }

  validateControlFlowDepth(ast);
  validateExecutableBuilderCalls(ast);
  return {
    ast,
    ops: tryCompileBuilderOps(ast)
  };
}

export class SqlBuilder {
  registry: SqlRegistryLike | null;
  queryName: string;
  baseSql: string;
  baseParamNames: string[];
  params: Record<string, unknown>;
  slots: Record<string, string[]>;
  slotJoiners: Record<string, string>;
  dialect: string;
  compiledSqlCacheSize?: number;
  orderable: Record<string, string>;
  allowedSlots: Set<string>;
  maxLimit: number;
  maxOffset: number;
  paramTypes: Record<string, string>;

  constructor(registry: SqlRegistryLike | null, queryName: string, baseSql: string, options: SqlBuilderOptions = {}) {
    this.registry = registry;
    this.queryName = queryName;
    this.baseSql = baseSql;
    this.baseParamNames = options.baseParamNames || extractNamedParams(baseSql);

    this.params = {};
    this.slots = {};
    this.slotJoiners = {};

    this.dialect = options.dialect || "sqlite";
    this.compiledSqlCacheSize = options.compiledSqlCacheSize;
    this.orderable = options.orderable || {};
    this.allowedSlots = options.allowedSlots instanceof Set
      ? new Set(options.allowedSlots)
      : new Set(options.allowedSlots || extractSlotNames(baseSql));
    this.maxLimit = options.maxLimit || 1000;
    this.maxOffset = options.maxOffset || 100000;
    this.paramTypes = options.paramTypes || {};
  }

  at(slotName: string): BuilderSlotApi {
    this.assertKnownSlot(slotName);
    const builder = this;

    return {
      __builderSlotApi: true,

      append: (sql: string, params: Record<string, unknown> = {}) => {
        builder.appendTo(slotName, sql, params);
        return builder;
      },

      appendIf: (condition: unknown, sql: string, params: Record<string, unknown> = {}) => {
        builder.appendIf(slotName, condition, sql, params);
        return builder;
      },

      appendQuery: (queryName: string, params?: Record<string, unknown>) => {
        if (!builder.registry) {
          throw new SqlBuilderError("registry is required for appendQuery");
        }
        const sql = builder.registry.getSql(queryName);
        builder.validateAppendQueryParams(queryName, sql, params);
        builder.appendTo(slotName, sql, params || {});
        return builder;
      },

      appendQueryIf: (condition: unknown, queryName: string, params?: Record<string, unknown>) => {
        builder.appendQueryIf(slotName, condition, queryName, params);
        return builder;
      }
    };
  }

  assertKnownSlot(slotName: string) {
    if (!slotName) {
      throw new SqlBuilderError("slotName is required", {
        queryName: this.queryName
      });
    }

    if (!this.allowedSlots.has(slotName)) {
      throw new SqlBuilderError(`slot marker not found in sql: ${slotName}`, {
        queryName: this.queryName,
        slotName,
        allowed: [...this.allowedSlots]
      });
    }
  }

  appendTo(slotName: string, sql: string, params: Record<string, unknown> = {}) {
    this.assertKnownSlot(slotName);
    validateAppendParams(sql, params, {
      queryName: this.queryName,
      slotName
    });

    if (!this.slots[slotName]) {
      this.slots[slotName] = [];
    }

    if (sql && sql.trim()) {
      this.slots[slotName].push(sql.trim());
    }

    this.addParams(params);
    return this;
  }

  append(slotName: string, sql: string, params: Record<string, unknown> = {}) {
    return this.appendTo(slotName, sql, params);
  }

  appendIf(slotName: string, condition: unknown, sql: string, params: Record<string, unknown> = {}) {
    this.assertKnownSlot(slotName);
    if (!condition) return this;
    return this.appendTo(slotName, sql, params);
  }

  set(sql: string, params: Record<string, unknown> = {}) {
    this.slotJoiners.set = ",\n";
    return this.appendTo("set", sql, params);
  }

  validateAppendQueryParams(queryName: string, sql: string, params?: Record<string, unknown>) {
    if (params === undefined) return;

    const keys = Object.keys(params);
    if (keys.length === 0) {
      throw new SqlBuilderError("appendQuery params must not be empty", {
        queryName
      });
    }

    const sqlParamNames: string[] = getFragmentParamNames(sql);
    const extra = keys.filter(key => !sqlParamNames.includes(key));
    if (extra.length > 0) {
      throw new SqlBuilderError(`appendQuery params not used in query: ${extra.join(", ")}`, {
        queryName,
        extra,
        allowed: sqlParamNames
      });
    }
  }

  appendQuery(slotName: string, queryName: string, params?: Record<string, unknown>) {
    return this.at(slotName).appendQuery(queryName, params);
  }

  appendQueryIf(slotName: string, condition: unknown, queryName: string, params?: Record<string, unknown>) {
    this.assertKnownSlot(slotName);
    if (!condition) return this;
    return this.appendQuery(slotName, queryName, params);
  }

  setIf(condition: unknown, sql: string, params: Record<string, unknown> = {}) {
    if (!condition) return this;
    return this.set(sql, params);
  }

  addParams(params: Record<string, unknown> = {}) {
    validateParamTypes(params, this.paramTypes, {
      queryName: this.queryName
    });

    for (const [key, value] of Object.entries(params)) {
      if (key in this.params && this.params[key] !== value) {
        throw new SqlBuilderError(`duplicate param with different value: ${key}`, {
          queryName: this.queryName,
          paramName: key,
          currentValue: this.params[key],
          newValue: value
        });
      }

      this.params[key] = value;
    }

    return this;
  }

  orderBy(slotName: string, columnKey: string, asc = true) {
    if (!columnKey) return this;
    this.assertKnownSlot(slotName);

    const column = this.orderable[columnKey];

    if (!column) {
      throw new SqlBuilderError(`invalid order column: ${columnKey}`, {
        queryName: this.queryName,
        columnKey,
        allowed: Object.keys(this.orderable)
      });
    }

    const direction = asc ? "ASC" : "DESC";
    this.slots[slotName] = [`ORDER BY ${column} ${direction}`];

    return this;
  }

  limit(slotName: string, value: unknown) {
    if (value == null) return this;
    const limit = normalizeNonNegativeInteger("limit", value, this.maxLimit);
    const paramName = pagingParamName("limit", slotName);
    return this.appendTo(slotName, `LIMIT :${paramName}`, { [paramName]: limit });
  }

  offset(slotName: string, value: unknown) {
    if (value == null) return this;
    const offset = normalizeNonNegativeInteger("offset", value, this.maxOffset);
    const paramName = pagingParamName("offset", slotName);
    return this.appendTo(slotName, `OFFSET :${paramName}`, { [paramName]: offset });
  }

  renderSql() {
    const usedSlots = new Set();

    const sql = this.baseSql.replace(
      SLOT_MARKER_PATTERN,
      (_match, slotName, markerOffset) => {
        usedSlots.add(slotName);
        return renderSlot(
          slotName,
          this.slots[slotName] || [],
          this.baseSql,
          markerOffset,
          this.slotJoiners[slotName] || "\n"
        );
      }
    );

    const unknownSlots = Object.keys(this.slots).filter(
      slotName => !usedSlots.has(slotName)
    );

    if (unknownSlots.length > 0) {
      throw new SqlBuilderError("slot marker not found in sql", {
        queryName: this.queryName,
        slots: unknownSlots
      });
    }

    return sql.trim();
  }

  runBuilderOps(ops: BuilderOp[], input: BuilderScriptInput = {}) {
    try {
      for (const op of ops) {
        if (!shouldRunOp(op, input)) continue;

        switch (op.type) {
          case "append":
            this.appendTo(op.slot, op.sql, evaluateCompiledParams(op.params, input));
            break;
          case "appendQuery":
            this.appendQuery(op.slot, op.queryName, op.params ? evaluateCompiledParams(op.params, input) : undefined);
            break;
          case "limit":
            this.limit(op.slot, evaluateCompiledExpression(op.value, input));
            break;
          case "offset":
            this.offset(op.slot, evaluateCompiledExpression(op.value, input));
            break;
          case "orderBy":
            this.orderBy(
              op.slot,
              String(evaluateCompiledExpression(op.columnKey, input)),
              op.asc === undefined ? true : Boolean(evaluateCompiledExpression(op.asc, input))
            );
            break;
          case "param":
            this.addParams(evaluateCompiledParams(op.params, input));
            break;
          case "set":
            this.set(op.sql, evaluateCompiledParams(op.params, input));
            break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof SqlBuilderError) {
        throw err;
      }

      throw new SqlBuilderError(`failed to run builder script: ${getErrorMessage(err)}`, {
        queryName: this.queryName
      });
    }

    return this;
  }

  runCompiledBuilderScript(program: BuilderScriptProgram | null, input: BuilderScriptInput = {}) {
    if (!program) return this;
    if (program.ops) {
      return this.runBuilderOps(program.ops, input);
    }

    const params = input.params || {};
    const context = input.context || {};
    const env = {
      params,
      context,

      at: (slotName: string) => this.at(slotName),

      append: (slotName: string, sql: string, bindParams: Record<string, unknown> = {}) => {
        this.appendTo(slotName, sql, bindParams);
        return this;
      },

      appendIf: (slotName: string, condition: unknown, sql: string, bindParams: Record<string, unknown> = {}) => {
        this.appendIf(slotName, condition, sql, bindParams);
        return this;
      },

      appendQuery: (slotName: string, queryName: string, bindParams?: Record<string, unknown>) => {
        this.appendQuery(slotName, queryName, bindParams);
        return this;
      },

      appendQueryIf: (slotName: string, condition: unknown, queryName: string, bindParams?: Record<string, unknown>) => {
        this.appendQueryIf(slotName, condition, queryName, bindParams);
        return this;
      },

      param: (bindParams: Record<string, unknown> = {}) => {
        this.addParams(bindParams);
        return this;
      },

      set: (sql: string, bindParams: Record<string, unknown> = {}) => {
        this.set(sql, bindParams);
        return this;
      },

      setIf: (condition: unknown, sql: string, bindParams: Record<string, unknown> = {}) => {
        this.setIf(condition, sql, bindParams);
        return this;
      },

      orderBy: (slotName: string, columnKey: string, asc = true) => {
        this.orderBy(slotName, columnKey, asc);
        return this;
      },

      limit: (slotName: string, value: unknown) => {
        this.limit(slotName, value);
        return this;
      },

      offset: (slotName: string, value: unknown) => {
        this.offset(slotName, value);
        return this;
      }
    };

    try {
      executeAst(program.ast, env);
    } catch (err: unknown) {
      if (err instanceof SqlBuilderError) {
        throw err;
      }

      throw new SqlBuilderError(`failed to run builder script: ${getErrorMessage(err)}`, {
        queryName: this.queryName
      });
    }

    return this;
  }

  runBuilderScript(code: string, input: BuilderScriptInput = {}) {
    try {
      return this.runCompiledBuilderScript(compileBuilderScript(code), input);
    } catch (err: unknown) {
      if (err instanceof SqlBuilderError) {
        throw err;
      }

      throw new SqlBuilderError(`failed to run builder script: ${getErrorMessage(err)}`, {
        queryName: this.queryName
      });
    }
  }

  toSql() {
    return this.renderSql();
  }

  build(options: BindOptions = {}) {
    const sql = this.renderSql();
    return bindSql(sql, this.params, {
      dialect: this.dialect,
      queryName: this.queryName,
      compiledSqlCacheSize: this.compiledSqlCacheSize,
      ...options
    });
  }

  buildExplain(options: ExplainOptions = {}) {
    const stmt = this.build(options);
    return buildExplainStmt(stmt, {
      dialect: this.dialect,
      ...options
    });
  }
}

export function getFragmentParamCacheSize() {
  return fragmentParamCache.size;
}

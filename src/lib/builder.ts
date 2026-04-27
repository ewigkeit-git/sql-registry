const acorn = require("acorn");
import { bindSql } from "./binder";
import { extractNamedParams } from "./param-parser";
import { buildExplain as buildExplainStmt } from "./explain-builder";
import { validateParamTypes } from "./param-types";
import { transpileBuilderScript } from "./builder-script";

export class SqlBuilderError extends Error {
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SqlBuilderError";
    this.details = details;
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
  "appendQuery",
  "param",
  "set",
  "orderBy",
  "limit",
  "offset"
]);

type BuilderSlotApi = {
  __builderSlotApi: true;
  append: (sql: string, params?: Record<string, unknown>) => SqlBuilder;
  appendQuery: (queryName: string, params?: Record<string, unknown>) => SqlBuilder;
};

type SqlRegistryLike = {
  getSql: (queryName: string) => string;
};

export type SqlBuilderOptions = {
  dialect?: string;
  orderable?: Record<string, string>;
  maxLimit?: number;
  maxOffset?: number;
  paramTypes?: Record<string, string>;
};

export type BindOptions = {
  strict?: boolean;
  dialect?: string;
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
      case "appendQuery":
        assertStaticStringArgument(args, 0, "slot name");
        assertStaticStringArgument(args, 1, "query name");
        assertNonEmptyObjectExpressionArgument(args, 2, "appendQuery params");
        return;
      case "param":
        assertObjectExpressionArgument(args, 0, "param params");
        return;
      case "set":
        assertStaticStringArgument(args, 0, "set SQL");
        assertObjectExpressionArgument(args, 1, "set params");
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

    if (key === "appendQuery") {
      assertStaticStringArgument(args, 0, "query name");
      assertNonEmptyObjectExpressionArgument(args, 1, "appendQuery params");
    }
  }
}

function extractSlotNames(sql: string): Set<string> {
  const names = new Set<string>();
  const regex = /\/\*#([A-Za-z_][A-Za-z0-9_.-]*)\*\//g;
  let match;

  while ((match = regex.exec(sql)) !== null) {
    names.add(match[1]);
  }

  return names;
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
  validateBuilderCallArguments(node);

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

export class SqlBuilder {
  registry: SqlRegistryLike | null;
  queryName: string;
  baseSql: string;
  params: Record<string, unknown>;
  slots: Record<string, string[]>;
  slotJoiners: Record<string, string>;
  dialect: string;
  orderable: Record<string, string>;
  allowedSlots: Set<string>;
  maxLimit: number;
  maxOffset: number;
  paramTypes: Record<string, string>;

  constructor(registry: SqlRegistryLike | null, queryName: string, baseSql: string, options: SqlBuilderOptions = {}) {
    this.registry = registry;
    this.queryName = queryName;
    this.baseSql = baseSql;

    this.params = {};
    this.slots = {};
    this.slotJoiners = {};

    this.dialect = options.dialect || "sqlite";
    this.orderable = options.orderable || {};
    this.allowedSlots = extractSlotNames(baseSql);
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

      appendQuery: (queryName: string, params?: Record<string, unknown>) => {
        if (!builder.registry) {
          throw new SqlBuilderError("registry is required for appendQuery");
        }
        const sql = builder.registry.getSql(queryName);
        builder.validateAppendQueryParams(queryName, sql, params);
        builder.appendTo(slotName, sql, params || {});
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

    const sqlParamNames: string[] = extractNamedParams(sql);
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

  addParams(params: Record<string, unknown> = {}) {
    validateParamTypes(params, this.paramTypes);

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
      /\/\*#([A-Za-z_][A-Za-z0-9_.-]*)\*\//g,
      (_, slotName) => {
        usedSlots.add(slotName);
        return (this.slots[slotName] || []).join(this.slotJoiners[slotName] || "\n");
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

  runBuilderScript(code: string, input: BuilderScriptInput = {}) {
    if (!code || !code.trim()) return this;
    const runnableCode = transpileBuilderScript(code);

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

      appendQuery: (slotName: string, queryName: string, bindParams?: Record<string, unknown>) => {
        this.appendQuery(slotName, queryName, bindParams);
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
      const ast = acorn.parse(runnableCode, {
        ecmaVersion: 2020,
        sourceType: "script"
      });

      if (countAstNodes(ast) > 1000) {
        throw new SqlBuilderError("builder script is too large");
      }

      validateControlFlowDepth(ast);
      executeAst(ast, env);
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

  toSql() {
    return this.renderSql();
  }

  build(options: BindOptions = {}) {
    const sql = this.renderSql();
    return bindSql(sql, this.params, {
      dialect: this.dialect,
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

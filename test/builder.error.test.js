const assert = require("assert");
const { SqlBuilder, SqlBuilderError } = require("../dist/lib/builder");
const { test } = require("./harness");

function assertBuilderError(name, fn, pattern) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SqlBuilderError, `${name}: expected SqlBuilderError`);
    if (pattern) {
      assert.match(error.message, pattern, name);
    }
    return;
  }

  assert.fail(`${name}: expected SqlBuilderError`);
}

function builderWithSlots(sql = "SELECT * FROM users /*#where*/ /*#set*/ /*#order*/ /*#paging*/") {
  return new SqlBuilder(
    {
      getSql(queryName) {
        if (queryName === "fragments.active") return "AND active = :active";
        if (queryName === "fragments.range") return "AND created_at BETWEEN :from AND :to";
        if (queryName === "fragments.noParams") return "AND deleted_at IS NULL";
        return "AND unknown_id = :unknownId";
      }
    },
    "users.search",
    sql,
    {
      orderable: {
        createdAt: "users.created_at"
      },
      maxLimit: 50,
      maxOffset: 100
    }
  );
}

const appendMissingCases = [
  ["single", "where", "AND id = :id", {}],
  ["second", "where", "AND id = :id AND role = :role", { id: 1 }],
  ["first", "where", "AND id = :id AND role = :role", { role: "admin" }],
  ["repeated", "where", "AND id = :id OR parent_id = :id", {}],
  ["newline", "where", "AND name = :name\nAND age = :age", { name: "A" }],
  ["set-name", "set", "name = :name", {}],
  ["set-json", "set", "profile = :profile", {}],
  ["limit-like", "paging", "LIMIT :limit", {}],
  ["offset-like", "paging", "OFFSET :offset", {}],
  ["underscore", "where", "AND user_id = :user_id", {}],
  ["numeric-suffix", "where", "AND value = :value1", {}],
  ["adjacent", "where", "AND a = :a AND b = :b AND c = :c", { a: 1, c: 3 }],
  ["comment-ignored-real-missing", "where", "-- :ignored\nAND id = :id", {}],
  ["quote-ignored-real-missing", "where", "AND note = ':ignored' AND id = :id", {}],
  ["cast-real-missing", "where", "AND id = :id::int", {}],
  ["json-path-real-missing", "where", "AND data->>:key = :value", { key: "name" }],
  ["subquery", "where", "AND id IN (SELECT user_id FROM logs WHERE type = :type)", {}],
  ["between-from", "where", "AND created_at BETWEEN :from AND :to", { to: "2026-01-01" }],
  ["between-to", "where", "AND created_at BETWEEN :from AND :to", { from: "2026-01-01" }],
  ["many", "where", "AND a = :a AND b = :b AND c = :c AND d = :d", { a: 1, b: 2 }]
];

const appendExtraCases = [
  ["no-param", "where", "AND active = 1", { active: true }],
  ["wrong-name", "where", "AND id = :id", { userId: 1 }],
  ["one-extra", "where", "AND id = :id", { id: 1, extra: 2 }],
  ["comment-only", "where", "-- :id", { id: 1 }],
  ["quote-only", "where", "AND note = ':id'", { id: 1 }],
  ["double-quote-only", "where", 'AND "id:field" IS NOT NULL', { field: 1 }],
  ["block-comment-only", "where", "/* :id */ AND active = 1", { id: 1 }],
  ["dollar-quote-only", "where", "AND body = $$:id$$", { id: 1 }],
  ["cast-only", "where", "AND now()::timestamp IS NOT NULL", { timestamp: 1 }],
  ["schema-only", "where", "AND public.users.id IS NOT NULL", { users: 1 }],
  ["set-extra", "set", "name = :name", { name: "A", active: true }],
  ["set-wrong", "set", "name = :name", { displayName: "A" }],
  ["paging-extra", "paging", "LIMIT :limit", { limit: 10, offset: 0 }],
  ["underscore-wrong", "where", "AND user_id = :user_id", { user: 1 }],
  ["numeric-wrong", "where", "AND value = :value1", { value: 1 }],
  ["case-sensitive", "where", "AND id = :id", { ID: 1 }],
  ["hyphen-not-param", "where", "AND x = :-bad", { bad: 1 }],
  ["colon-space", "where", "AND x = : id", { id: 1 }],
  ["two-extra", "where", "AND id = :id", { id: 1, a: 1, b: 2 }],
  ["empty-sql", "where", "", { id: 1 }]
];

const appendQueryCases = [
  ["missing-omitted", () => builderWithSlots().appendQuery("where", "fragments.active"), /missing/],
  ["missing-empty", () => builderWithSlots().appendQuery("where", "fragments.range", { from: "2026-01-01" }), /missing/],
  ["extra", () => builderWithSlots().appendQuery("where", "fragments.active", { active: true, unused: 1 }), /not used/],
  ["wrong-name", () => builderWithSlots().appendQuery("where", "fragments.active", { enabled: true }), /not used|missing/],
  ["no-param-extra", () => builderWithSlots().appendQuery("where", "fragments.noParams", { active: true }), /not used/],
  ["unknown-fragment-missing", () => builderWithSlots().appendQuery("where", "fragments.unknown", {}), /must not be empty|missing/],
  ["slot-api-missing", () => builderWithSlots().at("where").appendQuery("fragments.active"), /missing/],
  ["slot-api-extra", () => builderWithSlots().at("where").appendQuery("fragments.noParams", { id: 1 }), /not used/],
  ["slot-api-wrong", () => builderWithSlots().at("where").appendQuery("fragments.range", { fromDate: "x", toDate: "y" }), /not used|missing/],
  ["bad-slot", () => builderWithSlots().appendQuery("missing", "fragments.active", { active: true }), /slot marker/]
];

const directBuilderCases = [
  ["unknown-slot", () => builderWithSlots().append("missing", "AND id = :id", { id: 1 }), /slot marker/],
  ["duplicate-conflict", () => builderWithSlots().append("where", "AND id = :id", { id: 1 }).append("where", "AND other_id = :id", { id: 2 }), /duplicate param/],
  ["invalid-order", () => builderWithSlots().orderBy("order", "name"), /slot marker|invalid order/],
  ["invalid-column", () => builderWithSlots().orderBy("order", "name"), /slot marker|invalid order/],
  ["limit-negative", () => builderWithSlots().limit("paging", -1), /non-negative integer/],
  ["limit-float", () => builderWithSlots().limit("paging", 1.5), /non-negative integer/],
  ["limit-too-large", () => builderWithSlots().limit("paging", 51), /exceeds maximum/],
  ["limit-empty-string", () => builderWithSlots().limit("paging", ""), /non-negative integer/],
  ["offset-negative", () => builderWithSlots().offset("paging", -1), /non-negative integer/],
  ["offset-float", () => builderWithSlots().offset("paging", 1.5), /non-negative integer/],
  ["offset-too-large", () => builderWithSlots().offset("paging", 101), /exceeds maximum/],
  ["offset-empty-string", () => builderWithSlots().offset("paging", ""), /non-negative integer/]
];

const scriptCases = [
  ["unknown-global", "process.exit(1)", /unknown identifier|unsupported function/],
  ["eval", "eval('append()')", /unsupported function/],
  ["function-call", "Number(params.id)", /unsupported function/],
  ["dynamic-slot", "append(params.slot, 'AND id = :id', { id: 1 })", /slot name must be a string literal/],
  ["dynamic-sql", "append('where', params.sql, { id: 1 })", /append SQL must be a string literal/],
  ["dynamic-bind-object", "append('where', 'AND id = :id', params.binds)", /append params must be an object literal/],
  ["append-if-dynamic-slot", "appendIf(params.slot, true, 'AND id = :id', { id: 1 })", /slot name must be a string literal/],
  ["append-if-dynamic-sql", "appendIf('where', true, params.sql, { id: 1 })", /append SQL must be a string literal/],
  ["append-if-dynamic-bind-object", "appendIf('where', true, 'AND id = :id', params.binds)", /append params must be an object literal/],
  ["template-sql", "append('where', `AND id = ${params.id}`, { id: 1 })", /append SQL must be a string literal/],
  ["append-missing", "append('where', 'AND id = :id')", /missing/],
  ["append-extra", "append('where', 'AND active = 1', { active: true })", /not used/],
  ["set-dynamic-sql", "set(params.sql, { name: 'A' })", /set SQL must be a string literal/],
  ["set-dynamic-bind-object", "set('name = :name', params.binds)", /set params must be an object literal/],
  ["set-missing", "set('name = :name')", /missing/],
  ["set-extra", "set('name = :name', { name: 'A', active: true })", /not used/],
  ["append-query-empty", "appendQuery('where', 'fragments.active', {})", /must not be empty/],
  ["append-query-extra", "appendQuery('where', 'fragments.active', { active: true, unused: 1 })", /not used/],
  ["append-query-missing", "appendQuery('where', 'fragments.active')", /missing/],
  ["at-dynamic-slot", "at(params.slot).append('AND id = :id', { id: 1 })", /slot name must be a string literal/],
  ["at-computed-method", "at('where')['append']('AND id = :id', { id: 1 })", /computed helper methods/],
  ["at-unknown-method", "at('where').remove('AND id = :id', { id: 1 })", /unsupported helper method/],
  ["at-append-if-dynamic-sql", "at('where').appendIf(true, params.sql, { id: 1 })", /append SQL must be a string literal/],
  ["at-append-if-dynamic-bind-object", "at('where').appendIf(true, 'AND id = :id', params.binds)", /append params must be an object literal/],
  ["member-call-non-helper", "params.id.toString()", /method calls are only allowed/],
  ["for-loop", "for (let i = 0; i < 1; i++) { append('where', 'AND id = :id', { id: i }) }", /loop statements/],
  ["for-of", "for (const id of params.ids) { append('where', 'AND id = :id', { id }) }", /loop statements/],
  ["for-in", "for (const key in params) { append('where', 'AND id = :id', { id: 1 }) }", /loop statements/],
  ["while", "while (params.active) { append('where', 'AND active = :active', { active: true }) }", /loop statements/],
  ["do-while", "do { append('where', 'AND active = :active', { active: true }) } while (params.active)", /loop statements/],
  ["deep-if", "if (params.a) { if (params.b) { if (params.c) { append('where', 'AND id = :id', { id: 1 }) } } }", /if nesting/],
  ["function-declaration", "function x() {}", /unsupported statement/],
  ["arrow-function", "const fn = () => 1", /unsupported expression/],
  ["class-declaration", "class X {}", /unsupported statement/],
  ["return", "return", /unsupported statement|failed to run/],
  ["throw", "throw new Error('x')", /unsupported statement/],
  ["try-catch", "try { append('where', 'AND id = :id', { id: 1 }) } catch (e) {}", /unsupported statement/],
  ["switch", "switch (params.x) { case 1: append('where', 'AND id = :id', { id: 1 }) }", /unsupported statement/],
  ["debugger", "debugger", /unsupported statement/],
  ["const-destructure", "const { id } = params", /unsupported variable pattern/],
  ["array-destructure", "const [id] = params.ids", /unsupported variable pattern/],
  ["var", "var id = 1", /unsupported variable declaration/],
  ["assignment", "params.id = 1", /unsupported expression/],
  ["assignment-to-context", "context.id = 1", /unsupported expression/],
  ["update", "let i = 1; i++", /unsupported expression/],
  ["spread-call", "append(...params.args)", /spread arguments|slot name must be a string literal/],
  ["computed-object-key", "append('where', 'AND id = :id', { [params.key]: 1 })", /computed object keys/],
  ["spread-object", "append('where', 'AND id = :id', { ...params.binds })", /unsupported object property/],
  ["forbidden-param-key", "param({ constructor: 1 })", /forbidden property access/],
  ["forbidden-member", "params.constructor", /forbidden property access/],
  ["forbidden-proto-member", "params.__proto__", /forbidden property access/],
  ["forbidden-prototype-member", "params.prototype", /forbidden property access/],
  ["null-member", "context.missing.value", /cannot read property/],
  ["unsupported-logical", "params.a ?? params.b", /unsupported logical operator|unsupported expression|failed to run/],
  ["optional-chaining", "params?.id", /unsupported expression/],
  ["global-this", "globalThis.process", /unknown identifier/],
  ["require", "require('fs')", /unsupported function/],
  ["function-constructor", "Function('return 1')", /unsupported function/],
  ["unsupported-callee", "(params.fn)()", /unsupported callee|method calls/],
  ["new-expression", "new Date()", /unsupported expression/],
  ["await-expression", "await params.id", /failed to run|Unexpected/],
  ["import-expression", "import('fs')", /failed to run|unsupported expression/]
];

test("SqlBuilder rejects more than 100 invalid builder and append patterns", async () => {
  let count = 0;

  for (const [name, slot, sql, params] of appendMissingCases) {
    count++;
    assertBuilderError(
      `append missing: ${name}`,
      () => builderWithSlots().append(slot, sql, params),
      /append params missing/
    );
  }

  for (const [name, slot, sql, params] of appendExtraCases) {
    count++;
    assertBuilderError(
      `append extra: ${name}`,
      () => builderWithSlots().append(slot, sql, params),
      /append params not used|append params missing/
    );
  }

  for (const [name, fn, pattern] of appendQueryCases) {
    count++;
    assertBuilderError(`appendQuery: ${name}`, fn, pattern);
  }

  for (const [name, fn, pattern] of directBuilderCases) {
    count++;
    assertBuilderError(`direct builder: ${name}`, fn, pattern);
  }

  for (const [name, code, pattern] of scriptCases) {
    count++;
    assertBuilderError(
      `script: ${name}`,
      () => builderWithSlots().runBuilderScript(code, {
        params: {
          a: true,
          b: true,
          c: true,
          active: true,
          bindParams: { id: 1 },
          binds: { id: 1 },
          fn: () => null,
          id: 1,
          ids: [1],
          key: "id",
          slot: "where",
          sql: "AND id = :id",
          args: ["where", "AND id = :id", { id: 1 }]
        },
        context: {}
      }),
      pattern
    );
  }

  assert.strictEqual(count, 124);
});

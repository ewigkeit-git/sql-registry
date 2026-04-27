const assert = require("assert");
const { test } = require("./harness");
const {
  stripQuotedAndCommented,
  extractNamedParamTokens,
  extractNamedParams
} = require("../dist/lib/param-parser");
const { bindSql } = require("../dist/lib/binder");

function tokenNames(sql) {
  return extractNamedParamTokens(sql).map(token => token.name);
}

function normalizeMask(value) {
  return value.replace(/[^\n ]/g, "x");
}

const extractionCases = [
  {
    name: "single param",
    sql: "select :id",
    names: ["id"]
  },
  {
    name: "param after punctuation",
    sql: "where(id=:id)",
    names: ["id"]
  },
  {
    name: "multiple params preserve first-seen unique order",
    sql: "where id = :id or parent_id = :id or role = :role",
    names: ["id", "role"],
    tokenNames: ["id", "id", "role"]
  },
  {
    name: "token extraction preserves repeated params",
    sql: "where id = :id or parent_id = :id",
    names: ["id"],
    tokenNames: ["id", "id"]
  },
  {
    name: "underscore and digits after first char",
    sql: "where a = :user_id_2",
    names: ["user_id_2"]
  },
  {
    name: "digit cannot start name",
    sql: "select :1bad, :good",
    names: ["good"]
  },
  {
    name: "single quoted literal ignored",
    sql: "select ':id' as literal, :real",
    names: ["real"]
  },
  {
    name: "escaped single quote ignored",
    sql: "select 'it''s :ignored' as literal, :real",
    names: ["real"]
  },
  {
    name: "double quoted identifier ignored",
    sql: 'select ":ignored" as literal, :real',
    names: ["real"]
  },
  {
    name: "escaped double quote ignored",
    sql: 'select "a "" :ignored "" b", :real',
    names: ["real"]
  },
  {
    name: "line comment ignored",
    sql: "select :id -- :ignored\nwhere name = :name",
    names: ["id", "name"]
  },
  {
    name: "block comment ignored",
    sql: "select :id /* :ignored */ where name = :name",
    names: ["id", "name"]
  },
  {
    name: "multi-line block comment preserves following params",
    sql: "select :id /* :ignored\n still :ignored */\nwhere name = :name",
    names: ["id", "name"]
  },
  {
    name: "postgres anonymous dollar quote ignored",
    sql: "select $$ :ignored $$, :real",
    names: ["real"]
  },
  {
    name: "postgres tagged dollar quote ignored",
    sql: "select $tag$ :ignored $tag$, :real",
    names: ["real"]
  },
  {
    name: "postgres cast does not create param",
    sql: "select :id::int",
    names: ["id"]
  },
  {
    name: "postgres cast with schema-qualified type does not create param",
    sql: "select :value::public.custom_type",
    names: ["value"]
  },
  {
    name: "postgres array cast does not create param",
    sql: "select :ids::int[]",
    names: ["ids"]
  },
  {
    name: "postgres jsonb cast does not create param",
    sql: "select :payload::jsonb",
    names: ["payload"]
  },
  {
    name: "double colon alone ignored",
    sql: "select now()::timestamp",
    names: []
  },
  {
    name: "multiple postgres casts without named params are ignored",
    sql: "select now()::timestamp, '{}'::jsonb, array[1,2]::int[]",
    names: []
  },
  {
    name: "postgres casts between named params keep only named params",
    sql: "where created_at >= :from::timestamp and status = :status::text",
    names: ["from", "status"]
  },
  {
    name: "url-ish double colon ignored after first colon",
    sql: "select 'x'::text, :real",
    names: ["real"]
  },
  {
    name: "colon in json path literal ignored",
    sql: "select json_extract(data, '$.:ignored'), :real",
    names: ["real"]
  },
  {
    name: "unclosed single quote masks to end",
    sql: "select ':ignored, :alsoIgnored",
    names: []
  },
  {
    name: "unclosed double quote masks to end",
    sql: 'select ":ignored, :alsoIgnored',
    names: []
  },
  {
    name: "unclosed block comment masks to end",
    sql: "select :id /* :ignored, :alsoIgnored",
    names: ["id"]
  },
  {
    name: "unclosed dollar quote masks to end",
    sql: "select :id, $tag$ :ignored, :alsoIgnored",
    names: ["id"]
  },
  {
    name: "adjacent params",
    sql: "select :a,:b,:c",
    names: ["a", "b", "c"]
  },
  {
    name: "param at start of SQL",
    sql: ":id",
    names: ["id"]
  },
  {
    name: "colon followed by space ignored",
    sql: "select : id, :real",
    names: ["real"]
  },
  {
    name: "colon followed by dash ignored",
    sql: "select :-bad, :real",
    names: ["real"]
  },
  {
    name: "schema-qualified names unaffected",
    sql: "select public.users.id from public.users where id = :id",
    names: ["id"]
  }
];

for (const scenario of extractionCases) {
  test(`param-parser extracts params: ${scenario.name}`, () => {
    const tokens = extractNamedParamTokens(scenario.sql);

    assert.deepStrictEqual(
      tokens.map(token => token.name),
      scenario.tokenNames || scenario.names
    );

    assert.deepStrictEqual(extractNamedParams(scenario.sql), scenario.names);
  });
}

test("param-parser token positions point at original sql slices", () => {
  const sql = "select ':literal' as x, :id as id -- :ignored\nwhere role = :role";
  const tokens = extractNamedParamTokens(sql);

  assert.deepStrictEqual(tokens.map(token => sql.slice(token.start, token.end)), [
    ":id",
    ":role"
  ]);
});

test("param-parser token positions survive comments and quotes before params", () => {
  const sql = [
    "select ':ignored' as a,",
    "  /* :ignored */",
    "  :id as id,",
    "  $$ :ignored $$ as b,",
    "  :name as name"
  ].join("\n");

  assert.deepStrictEqual(
    extractNamedParamTokens(sql).map(token => ({
      name: token.name,
      slice: sql.slice(token.start, token.end)
    })),
    [
      { name: "id", slice: ":id" },
      { name: "name", slice: ":name" }
    ]
  );
});

test("stripQuotedAndCommented preserves string length", () => {
  const samples = [
    "select ':id', :real",
    "select :id -- :ignored\nwhere name = :name",
    "select :id /* :ignored\nstill ignored */ where x = :x",
    "select $tag$ :ignored\nstill ignored $tag$, :real",
    "select \"quoted :identifier\", :real"
  ];

  for (const sql of samples) {
    assert.strictEqual(stripQuotedAndCommented(sql).length, sql.length);
  }
});

test("stripQuotedAndCommented preserves newline positions", () => {
  const sql = "select :id /* :ignored\nstill ignored */\nwhere name = :name";
  const stripped = stripQuotedAndCommented(sql);

  const originalNewlines = [...sql].map((ch, index) => ch === "\n" ? index : -1).filter(index => index >= 0);
  const strippedNewlines = [...stripped].map((ch, index) => ch === "\n" ? index : -1).filter(index => index >= 0);

  assert.deepStrictEqual(strippedNewlines, originalNewlines);
});

test("stripQuotedAndCommented masks quoted and commented bytes with spaces", () => {
  const sql = "select ':id' -- :ignored\nwhere id = :id";
  const stripped = stripQuotedAndCommented(sql);

  assert.strictEqual(stripped.includes(":ignored"), false);
  assert.strictEqual(stripped.includes("':id'"), false);
  assert.strictEqual(normalizeMask(stripped).length, normalizeMask(sql).length);
});

test("bindSql uses the same param-parser token stream", () => {
  const sql = "select ':literal' as x, :id as id -- :ignored\nwhere id = :id and role = :role";

  assert.deepStrictEqual(bindSql(sql, { id: 7, role: "admin" }), {
    sql: "select ':literal' as x, ? as id -- :ignored\nwhere id = ? and role = ?",
    values: [7, 7, "admin"]
  });
});

test("param-parser generated matrix for quote/comment wrappers", () => {
  const wrappers = [
    ["single quote", value => `'${value}'`],
    ["double quote", value => `"${value}"`],
    ["line comment", value => `-- ${value}\n`],
    ["block comment", value => `/* ${value} */`],
    ["anonymous dollar quote", value => `$$ ${value} $$`],
    ["tagged dollar quote", value => `$tag$ ${value} $tag$`]
  ];

  for (const [label, wrap] of wrappers) {
    const sql = `select ${wrap(":ignored")} as masked, :real as real`;
    assert.deepStrictEqual(tokenNames(sql), ["real"], label);
  }
});

test("param-parser generated matrix for valid names", () => {
  const names = [
    "a",
    "id",
    "_id",
    "user_id",
    "user_id_2",
    "A",
    "CamelCase",
    "snake_CASE_123"
  ];

  for (const name of names) {
    assert.deepStrictEqual(tokenNames(`select :${name}`), [name]);
  }
});

test("param-parser generated matrix for invalid starts", () => {
  const starts = ["1", "9", "-", ".", "$", " "];

  for (const start of starts) {
    assert.deepStrictEqual(tokenNames(`select :${start}bad, :ok`), ["ok"]);
  }
});

test("param-parser generated matrix for params around operators", () => {
  const snippets = [
    "a=:a",
    "a = :a",
    "(:a)",
    "coalesce(:a, :b)",
    ":a+:b",
    ":a * :b",
    "case when :a then :b else :c end"
  ];

  for (const snippet of snippets) {
    const names = tokenNames(`select ${snippet}`);
    assert.ok(names.length > 0, snippet);
    for (const name of names) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  }
});

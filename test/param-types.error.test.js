const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SqlRegistry } = require("../index");
const { SqlBuilder } = require("../dist/lib/builder");
const { normalizeParamType } = require("../dist/lib/param-types");
const { test } = require("./harness");

function registryWithParam(name, type, sql) {
  const registry = new SqlRegistry({ strict: false });
  registry.queries.test = {
    meta: {
      params: [
        {
          name,
          type,
          description: "Test param"
        }
      ]
    },
    sql: {
      default: sql
    }
  };
  return registry;
}

function assertInvalidParam(registry, paramName, value) {
  assert.throws(
    () => registry.bind("test", { [paramName]: value }),
    new RegExp(`invalid type for param: ${paramName}`)
  );
}

test("SqlRegistry rejects unknown param types while loading markdown", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-unknown-param-type.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.findByUuid",
      "param: id:uuid - User ID",
      "",
      "```sql",
      "SELECT * FROM users WHERE id = :id",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /unsupported param type: uuid/);
      return true;
    }
  );
});

test("SqlRegistry rejects malformed empty param type syntax", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-empty-param-type.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.findById",
      "param: id: - User ID",
      "",
      "```sql",
      "SELECT * FROM users WHERE id = :id",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /invalid param format: id: - User ID/);
      return true;
    }
  );
});

test("SqlRegistry rejects builder params reads without param metadata", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-builder-undeclared-input.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.search",
      "",
      "```sql",
      "SELECT * FROM users /*#where*/",
      "```",
      "",
      "```js builder",
      "if (params.name) {",
      "  append('where', 'AND name = :name', { name: params.name });",
      "}",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /params read in builder but not declared in meta: name/);
      return true;
    }
  );
});

test("SqlRegistry rejects builder params reads without type metadata", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-builder-input-without-type.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.search",
      "param: name - User name",
      "",
      "```sql",
      "SELECT * FROM users /*#where*/",
      "```",
      "",
      "```js builder",
      "if (params.name) {",
      "  append('where', 'AND name = :name', { name: params.name });",
      "}",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /params read in builder must declare a type: name/);
      return true;
    }
  );
});

test("SqlRegistry rejects builder params reads without description metadata", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-builder-input-without-description.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.search",
      "param: name:string",
      "",
      "```sql",
      "SELECT * FROM users /*#where*/",
      "```",
      "",
      "```js builder",
      "if (params.name) {",
      "  append('where', 'AND name = :name', { name: params.name });",
      "}",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /params read in builder must declare a description: name/);
      return true;
    }
  );
});

test("SqlRegistry rejects builder bound params unless declared or internally generated", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-builder-undeclared-bound.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.search",
      "",
      "```sql",
      "SELECT * FROM users /*#where*/",
      "```",
      "",
      "```js builder",
      "append('where', 'AND active = :active', { active: true });",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /params bound in builder but not declared in meta: active/);
      return true;
    }
  );
});

test("param type aliases are case-insensitive", async () => {
  assert.strictEqual(normalizeParamType("TIMESTAMP"), "date");
  assert.strictEqual(normalizeParamType("DateTime"), "date");
});

test("timestamp alias reports date as the normalized expected type", async () => {
  const registry = registryWithParam(
    "createdAt",
    "date",
    "SELECT * FROM events WHERE created_at >= :createdAt"
  );

  assert.throws(
    () => registry.bind("test", { createdAt: 1 }),
    error => {
      assert.strictEqual(error.details.expected, "date");
      assert.match(error.message, /invalid type for param: createdAt/);
      return true;
    }
  );
});

test("date params reject non-string non-Date values", async () => {
  const registry = registryWithParam(
    "createdAt",
    "date",
    "SELECT * FROM events WHERE created_at >= :createdAt"
  );

  for (const value of [1, true, {}, []]) {
    assertInvalidParam(registry, "createdAt", value);
  }
});

test("json params reject unsupported top-level values", async () => {
  const registry = registryWithParam(
    "payload",
    "json",
    "SELECT * FROM events WHERE payload = :payload"
  );

  for (const value of [undefined, () => true, Symbol("x"), 1n]) {
    assertInvalidParam(registry, "payload", value);
  }
});

test("json params reject unsupported nested object and array values", async () => {
  const registry = registryWithParam(
    "payload",
    "json",
    "SELECT * FROM events WHERE payload = :payload"
  );

  for (const value of [
    { ok: true, bad: undefined },
    { ok: true, bad: () => true },
    { ok: true, bad: 1n },
    [true, undefined],
    [true, () => true],
    [true, 1n]
  ]) {
    assertInvalidParam(registry, "payload", value);
  }
});

test("json params reject circular references", async () => {
  const registry = registryWithParam(
    "payload",
    "json",
    "SELECT * FROM events WHERE payload = :payload"
  );
  const payload = {};
  payload.self = payload;

  assertInvalidParam(registry, "payload", payload);
});

test("number params reject NaN and infinity", async () => {
  const registry = registryWithParam(
    "score",
    "number",
    "SELECT * FROM metrics WHERE score = :score"
  );

  for (const value of [NaN, Infinity, -Infinity]) {
    assertInvalidParam(registry, "score", value);
  }
});

test("integer params reject fractional unsafe and string values", async () => {
  const registry = registryWithParam(
    "count",
    "integer",
    "SELECT * FROM metrics WHERE count = :count"
  );

  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assertInvalidParam(registry, "count", value);
  }
});

test("int alias rejects the same invalid values as integer", async () => {
  const registry = registryWithParam(
    "count",
    "integer",
    "SELECT * FROM metrics WHERE count = :count"
  );

  assertInvalidParam(registry, "count", 1.5);
});

test("boolean params reject numeric and string booleans", async () => {
  const registry = registryWithParam(
    "active",
    "boolean",
    "SELECT * FROM users WHERE active = :active"
  );

  for (const value of [0, 1, "true"]) {
    assertInvalidParam(registry, "active", value);
  }
});

test("bool alias rejects the same invalid values as boolean", async () => {
  const registry = registryWithParam(
    "active",
    "boolean",
    "SELECT * FROM users WHERE active = :active"
  );

  assertInvalidParam(registry, "active", 1);
});

test("SqlRegistry validates typed params on bind", async () => {
  const registry = registryWithParam(
    "id",
    "integer",
    "SELECT * FROM users WHERE id = :id"
  );

  assertInvalidParam(registry, "id", "1");
});

test("SqlBuilder validates typed params from builder fragments", async () => {
  const registry = new SqlRegistry({ strict: false });
  registry.queries["users.searchTyped"] = {
    meta: {
      params: [
        {
          name: "limit",
          type: "integer",
          description: "Limit"
        }
      ],
      builder: "append('paging', 'LIMIT :limit', { limit: params.limit });"
    },
    sql: {
      default: "SELECT * FROM users /*#paging*/"
    }
  };

  assert.throws(
    () => registry.builder("users.searchTyped", {
      params: {
        limit: "10"
      }
    }),
    /invalid type for param: limit/
  );
});

test("SqlBuilder append validates typed params", async () => {
  const builder = new SqlBuilder(
    null,
    "users.searchTyped",
    "SELECT * FROM users /*#where*/",
    {
      paramTypes: {
        active: "boolean"
      }
    }
  );

  assert.throws(
    () => builder.append("where", "WHERE active = :active", { active: 1 }),
    /invalid type for param: active/
  );
});

test("SqlBuilder appendQuery validates typed params from query metadata", async () => {
  const registry = new SqlRegistry({ strict: false });
  registry.queries["users.searchTyped"] = {
    meta: {
      params: [
        {
          name: "active",
          type: "boolean",
          description: "Active flag"
        }
      ]
    },
    sql: {
      default: "SELECT * FROM users WHERE 1 = 1 /*#where*/"
    }
  };
  registry.queries["fragments.active"] = {
    meta: {
      params: [
        {
          name: "active",
          type: "boolean",
          description: "Active flag"
        }
      ]
    },
    sql: {
      default: "AND active = :active"
    }
  };

  const builder = registry.builder("users.searchTyped");

  assert.throws(
    () => builder.appendQuery("where", "fragments.active", { active: 1 }),
    /invalid type for param: active/
  );
});

test("SqlBuilder validates meta types for params used only in appended fragments", async () => {
  const registry = new SqlRegistry({ strict: false });
  registry.queries["users.searchTyped"] = {
    meta: {
      params: [
        {
          name: "active",
          type: "boolean",
          description: "Active flag"
        }
      ],
      builder: "append('where', 'AND active = :active', { active: params.active });"
    },
    sql: {
      default: "SELECT * FROM users WHERE 1 = 1 /*#where*/"
    }
  };

  assert.throws(
    () => registry.builder("users.searchTyped", {
      params: {
        active: 1
      }
    }),
    /invalid type for param: active/
  );
});

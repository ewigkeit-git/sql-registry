const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SqlRegistry } = require("../index");
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

test("SqlRegistry parses typed params", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-typed-params.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.findTyped",
      "param: id:int - User ID",
      "param: active:bool - Active flag",
      "",
      "```sql",
      "SELECT * FROM users WHERE id = :id AND active = :active",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  assert.deepStrictEqual(registry.getMeta("users.findTyped").params, [
    {
      name: "id",
      description: "User ID",
      type: "integer"
    },
    {
      name: "active",
      description: "Active flag",
      type: "boolean"
    }
  ]);
});

test("param type aliases normalize datetime and timestamp to date", async () => {
  assert.strictEqual(normalizeParamType("datetime"), "date");
  assert.strictEqual(normalizeParamType("timestamp"), "date");
});

test("timestamp params accept database datetime strings", async () => {
  const registry = registryWithParam(
    "createdAt",
    "date",
    "SELECT * FROM events WHERE created_at >= :createdAt"
  );

  assert.deepStrictEqual(
    registry.bind("test", { createdAt: "2026-04-27 12:34:56.789" }),
    {
      sql: "SELECT * FROM events WHERE created_at >= ?",
      values: ["2026-04-27 12:34:56.789"]
    }
  );
});

test("date params accept empty and non-date strings as database values", async () => {
  const registry = registryWithParam(
    "createdAt",
    "date",
    "SELECT * FROM events WHERE created_at >= :createdAt"
  );

  assert.deepStrictEqual(registry.bind("test", { createdAt: "" }).values, [""]);
  assert.deepStrictEqual(registry.bind("test", { createdAt: "not-a-date" }).values, ["not-a-date"]);
});

test("json params accept string values", async () => {
  const registry = registryWithParam(
    "payload",
    "json",
    "SELECT * FROM events WHERE payload = :payload"
  );

  assert.deepStrictEqual(
    registry.bind("test", { payload: "{\"type\":\"created\"}" }),
    {
      sql: "SELECT * FROM events WHERE payload = ?",
      values: ["{\"type\":\"created\"}"]
    }
  );
});

test("json params accept invalid JSON strings as database values", async () => {
  const registry = registryWithParam(
    "payload",
    "json",
    "SELECT * FROM events WHERE payload = :payload"
  );

  assert.deepStrictEqual(registry.bind("test", { payload: "{" }).values, ["{"]);
});

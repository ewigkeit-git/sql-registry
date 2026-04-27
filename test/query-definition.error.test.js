const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SqlRegistry, SqlRegistryError } = require("../index");
const { test } = require("./harness");

function writeFixture(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

test("SqlRegistry rejects duplicate query names in a registry file", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-duplicate-query.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "```sql",
    "SELECT * FROM users WHERE id = :id",
    "```",
    "",
    "## users.find",
    "",
    "```sql",
    "SELECT * FROM users WHERE name = :name",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.message, /^structure error:/);
      assert.match(error.errors.join("\n"), /duplicate query name in file: users\.find/);
      return true;
    }
  );
});

test("SqlRegistry rejects duplicate query names introduced by imports", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-duplicate-import");
  const rootPath = path.join(fixtureDir, "root.md");
  const aPath = path.join(fixtureDir, "a.md");
  const bPath = path.join(fixtureDir, "b.md");

  writeFixture(rootPath, [
    '@import "./a.md"',
    '@import "./b.md"',
    ""
  ]);
  writeFixture(aPath, [
    "## users.find",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);
  writeFixture(bPath, [
    "## users.find",
    "",
    "```sql",
    "SELECT 2",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(rootPath),
    error => {
      assert.match(error.errors.join("\n"), /duplicate query name in file: users\.find/);
      return true;
    }
  );
});

test("SqlRegistry rejects circular imports", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-circular-import");
  const aPath = path.join(fixtureDir, "a.md");
  const bPath = path.join(fixtureDir, "b.md");

  writeFixture(aPath, [
    '@import "./b.md"',
    "",
    "## a.query",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);
  writeFixture(bPath, [
    '@import "./a.md"',
    "",
    "## b.query",
    "",
    "```sql",
    "SELECT 2",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(aPath),
    error => {
      assert.ok(error instanceof SqlRegistryError);
      assert.match(error.message, /^structure error: circular import detected:/);
      assert.match(error.message, /a\.md/);
      assert.match(error.message, /b\.md/);
      return true;
    }
  );
});

test("SqlRegistry rejects missing appendQuery references on loadFile", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-missing-query-reference.md");
  writeFixture(fixturePath, [
    "## users.search",
    "",
    "param: active:boolean - Active flag",
    "",
    "```sql",
    "SELECT * FROM users /*#where*/",
    "```",
    "",
    "```js builder",
    "appendQuery('where', 'fragments.missing');",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.message, /^structure error:/);
      assert.match(error.errors.join("\n"), /structure error: appendQuery references unknown query: fragments\.missing/);
      return true;
    }
  );
});

test("SqlRegistry accepts appendQuery references declared later in the same file", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-forward-query-reference.md");
  writeFixture(fixturePath, [
    "## users.search",
    "",
    "param: active:boolean - Active flag",
    "",
    "```sql",
    "SELECT * FROM users /*#where*/",
    "```",
    "",
    "```js builder",
    "appendQuery('where', 'fragments.active', { active: true });",
    "```",
    "",
    "## fragments.active",
    "",
    "param: active:boolean - Active flag",
    "",
    "```sql",
    "AND active = :active",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.ok(registry.has("users.search"));
  assert.ok(registry.has("fragments.active"));
});

test("SqlRegistry accepts appendQuery references imported with a namespace", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-import-reference");
  const rootPath = path.join(fixtureDir, "root.md");
  const fragmentPath = path.join(fixtureDir, "fragments.md");

  writeFixture(rootPath, [
    '@import "./fragments.md" as fragments',
    "",
    "## users.search",
    "",
    "param: active:boolean - Active flag",
    "",
    "```sql",
    "SELECT * FROM users /*#where*/",
    "```",
    "",
    "```js builder",
    "appendQuery('where', 'fragments.active', { active: true });",
    "```",
    ""
  ]);
  writeFixture(fragmentPath, [
    "## active",
    "",
    "param: active:boolean - Active flag",
    "",
    "```sql",
    "AND active = :active",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("users.search"));
  assert.ok(registry.has("fragments.active"));
});

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

test("SqlRegistry rejects invalid query ids", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-invalid-query-id.md");
  writeFixture(fixturePath, [
    "## users search",
    "",
    "```sql",
    "SELECT 1",
    "```",
    "",
    "## users/drop",
    "",
    "```sql",
    "SELECT 2",
    "```",
    "",
    "## users:find",
    "",
    "```sql",
    "SELECT 3",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      const messages = error.errors.join("\n");
      assert.match(messages, /invalid query id: users search/);
      assert.match(messages, /invalid query id: users\/drop/);
      assert.match(messages, /invalid query id: users:find/);
      return true;
    }
  );
});

test("SqlRegistry validation errors include file line query and dialect context", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-error-context.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "param: missing:string - Missing param",
    "",
    "```sql pg",
    "SELECT * FROM users WHERE id = :id",
    "```",
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
      const messages = error.errors.join("\n");
      assert.match(messages, /registry-error-context\.md:5: \[users\.find\]\[pg\]/);
      assert.match(messages, /registry-error-context\.md:9: \[users\.find\]\[default\]/);
      assert.match(messages, /params declared in meta but not used in SQL: missing/);
      assert.match(messages, /params used in SQL but not declared in meta: id/);
      assert.match(messages, /params used in SQL but not declared in meta: name/);
      return true;
    }
  );
});

test("SqlRegistry rejects fenced blocks outside query definitions", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-fence-outside-query.md");
  writeFixture(fixturePath, [
    "```sql",
    "SELECT 1",
    "```",
    "",
    "## users.find",
    "",
    "```sql",
    "SELECT 2",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-fence-outside-query\.md:1: fenced block outside query/);
      return true;
    }
  );
});

test("SqlRegistry rejects unclosed fenced blocks outside query definitions", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-unclosed-fence-outside-query.md");
  writeFixture(fixturePath, [
    "```sql",
    "SELECT 1",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      const messages = error.errors.join("\n");
      assert.match(messages, /registry-unclosed-fence-outside-query\.md:1: fenced block outside query/);
      assert.match(messages, /registry-unclosed-fence-outside-query\.md:1: unclosed fenced block outside query/);
      return true;
    }
  );
});

test("SqlRegistry rejects unsupported fenced block languages", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-unsupported-fence-language.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "```md",
    "not registry content",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-unsupported-fence-language\.md:3: \[users\.find\] unsupported fenced block info: md/);
      return true;
    }
  );
});

test("SqlRegistry rejects empty fenced block info inside query definitions", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-empty-fence-info.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "```",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-empty-fence-info\.md:3: \[users\.find\] unsupported fenced block info: \(empty\)/);
      return true;
    }
  );
});

test("SqlRegistry rejects malformed SQL fenced block info", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-malformed-sql-fence-info.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "```sql pg extra",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-malformed-sql-fence-info\.md:3: \[users\.find\] invalid sql fenced block info: sql pg extra/);
      return true;
    }
  );
});

test("SqlRegistry reports unsupported SQL fenced block dialects as validation errors", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-unsupported-sql-fence-dialect.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "```sql oracle",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-unsupported-sql-fence-dialect\.md:3: \[users\.find\] unsupported dialect: oracle/);
      return true;
    }
  );
});

test("SqlRegistry accepts query ids made from letters digits underscore dot and hyphen", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-valid-query-id.md");
  writeFixture(fixturePath, [
    "## Users_2.search-active.v1",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.ok(registry.has("Users_2.search-active.v1"));
});

test("SqlRegistry parses query description from heading", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-heading-description.md");
  writeFixture(fixturePath, [
    "## users.find-by-id - Find user by ID",
    "",
    "param: id:integer - User ID",
    "",
    "```sql",
    "SELECT * FROM users WHERE id = :id",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.ok(registry.has("users.find-by-id"));
  assert.strictEqual(registry.getMeta("users.find-by-id").description, "Find user by ID");
});

test("SqlRegistry lets explicit description metadata override heading description", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-heading-description-override.md");
  writeFixture(fixturePath, [
    "## users.find - Heading description",
    "",
    "description: Explicit description",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.strictEqual(registry.getMeta("users.find").description, "Explicit description");
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

test("SqlRegistry rejects deep circular imports", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-deep-circular-import");
  const paths = {
    a: path.join(fixtureDir, "a.md"),
    b: path.join(fixtureDir, "b.md"),
    c: path.join(fixtureDir, "c.md"),
    d: path.join(fixtureDir, "d.md"),
    e: path.join(fixtureDir, "e.md")
  };

  writeFixture(paths.a, [
    '@import "./b.md"',
    "",
    "## a.query",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);
  writeFixture(paths.b, [
    '@import "./c.md"',
    "",
    "## b.query",
    "",
    "```sql",
    "SELECT 2",
    "```",
    ""
  ]);
  writeFixture(paths.c, [
    '@import "./d.md"',
    "",
    "## c.query",
    "",
    "```sql",
    "SELECT 3",
    "```",
    ""
  ]);
  writeFixture(paths.d, [
    '@import "./e.md"',
    "",
    "## d.query",
    "",
    "```sql",
    "SELECT 4",
    "```",
    ""
  ]);
  writeFixture(paths.e, [
    '@import "./b.md"',
    "",
    "## e.query",
    "",
    "```sql",
    "SELECT 5",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(paths.a),
    error => {
      assert.ok(error instanceof SqlRegistryError);
      assert.match(error.message, /^structure error: circular import detected:/);
      assert.match(error.message, /b\.md/);
      assert.match(error.message, /c\.md/);
      assert.match(error.message, /d\.md/);
      assert.match(error.message, /e\.md/);
      return true;
    }
  );
});

test("SqlRegistry rejects circular imports after a branching import path", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-branch-circular-import");
  const rootPath = path.join(fixtureDir, "root.md");
  const sharedPath = path.join(fixtureDir, "shared.md");
  const featurePath = path.join(fixtureDir, "feature.md");
  const leafPath = path.join(fixtureDir, "leaf.md");

  writeFixture(rootPath, [
    '@import "./shared.md"',
    '@import "./feature.md"',
    "",
    "## root.query",
    "",
    "```sql",
    "SELECT 0",
    "```",
    ""
  ]);
  writeFixture(sharedPath, [
    "## shared.query",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);
  writeFixture(featurePath, [
    '@import "./leaf.md"',
    "",
    "## feature.query",
    "",
    "```sql",
    "SELECT 2",
    "```",
    ""
  ]);
  writeFixture(leafPath, [
    '@import "./feature.md"',
    "",
    "## leaf.query",
    "",
    "```sql",
    "SELECT 3",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(rootPath),
    error => {
      assert.ok(error instanceof SqlRegistryError);
      assert.match(error.message, /^structure error: circular import detected:/);
      assert.match(error.message, /feature\.md/);
      assert.match(error.message, /leaf\.md/);
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

test("SqlRegistry accepts dotted and hyphenated import namespaces", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-import-dotted-namespace");
  const rootPath = path.join(fixtureDir, "root.md");
  const childPath = path.join(fixtureDir, "child.md");

  writeFixture(rootPath, [
    '@import "./child.md" as fragments.user-v1',
    ""
  ]);
  writeFixture(childPath, [
    "## active",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("fragments.user-v1.active"));
});

test("SqlRegistry accepts adjacent namespaced imports", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-adjacent-namespaced-imports");
  const rootPath = path.join(fixtureDir, "root.md");
  const imagesPath = path.join(fixtureDir, "images.md");
  const subjectsPath = path.join(fixtureDir, "subjects.md");

  writeFixture(rootPath, [
    '@import "./images.md" as images',
    '@import "./subjects.md" as subjects',
    ""
  ]);
  writeFixture(imagesPath, [
    "## find",
    "",
    "```sql",
    "SELECT * FROM images",
    "```",
    ""
  ]);
  writeFixture(subjectsPath, [
    "## find",
    "",
    "```sql",
    "SELECT * FROM subjects",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("images.find"));
  assert.ok(registry.has("subjects.find"));
});

test("SqlRegistry accepts adjacent imports with descriptions", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-adjacent-described-imports");
  const rootPath = path.join(fixtureDir, "root.md");
  const imagesPath = path.join(fixtureDir, "images.md");
  const subjectsPath = path.join(fixtureDir, "subjects.md");

  writeFixture(rootPath, [
    '@import "./images.md" - Image queries',
    '@import "./subjects.md" - Subject queries',
    ""
  ]);
  writeFixture(imagesPath, [
    "## images.find",
    "",
    "```sql",
    "SELECT * FROM images",
    "```",
    ""
  ]);
  writeFixture(subjectsPath, [
    "## subjects.find",
    "",
    "```sql",
    "SELECT * FROM subjects",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("images.find"));
  assert.ok(registry.has("subjects.find"));
});

test("SqlRegistry accepts adjacent namespaced imports in nested imports", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-nested-adjacent-namespaced-imports");
  const rootPath = path.join(fixtureDir, "root.md");
  const featurePath = path.join(fixtureDir, "feature.md");
  const imagesPath = path.join(fixtureDir, "images.md");
  const subjectsPath = path.join(fixtureDir, "subjects.md");

  writeFixture(rootPath, [
    '@import "./feature.md" as app',
    ""
  ]);
  writeFixture(featurePath, [
    '@import "./images.md" as images',
    '@import "./subjects.md" as subjects',
    ""
  ]);
  writeFixture(imagesPath, [
    "## find",
    "",
    "```sql",
    "SELECT * FROM images",
    "```",
    ""
  ]);
  writeFixture(subjectsPath, [
    "## find",
    "",
    "```sql",
    "SELECT * FROM subjects",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("app.images.find"));
  assert.ok(registry.has("app.subjects.find"));
});

test("SqlRegistry does not expand import directives inside fenced SQL blocks", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-import-in-fenced-sql");
  const rootPath = path.join(fixtureDir, "root.md");
  const childPath = path.join(fixtureDir, "child.md");

  writeFixture(rootPath, [
    '@import "./child.md" as child',
    ""
  ]);
  writeFixture(childPath, [
    "## literal",
    "",
    "```sql",
    '@import "./missing.md" as missing',
    "## not.a.query",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("child.literal"));
  assert.strictEqual(registry.getSql("child.literal"), [
    '@import "./missing.md" as missing',
    "## not.a.query",
    "SELECT 1"
  ].join("\n"));
});

test("SqlRegistry ignores multiline HTML comments in query metadata", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-multiline-html-comment.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "<!--",
    "note: this is a markdown comment",
    "-->",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.ok(registry.has("users.find"));
});

test("SqlRegistry rejects unclosed multiline HTML comments in query metadata", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-unclosed-html-comment.md");
  writeFixture(fixturePath, [
    "## users.find",
    "",
    "<!--",
    "note: this is a markdown comment",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /registry-unclosed-html-comment\.md:3: \[users\.find\] unclosed HTML comment/);
      return true;
    }
  );
});

test("SqlRegistry preserves heading descriptions while applying import namespace", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-import-heading-description");
  const rootPath = path.join(fixtureDir, "root.md");
  const childPath = path.join(fixtureDir, "child.md");

  writeFixture(rootPath, [
    '@import "./child.md" as fragments.user',
    ""
  ]);
  writeFixture(childPath, [
    "## active - Active user fragment",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("fragments.user.active"));
  assert.strictEqual(registry.getMeta("fragments.user.active").description, "Active user fragment");
});

test("SqlRegistry preserves explicit descriptions while applying import namespace", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-import-explicit-description");
  const rootPath = path.join(fixtureDir, "root.md");
  const childPath = path.join(fixtureDir, "child.md");

  writeFixture(rootPath, [
    '@import "./child.md" as fragments.user',
    ""
  ]);
  writeFixture(childPath, [
    "## active",
    "",
    "description: Active user fragment",
    "",
    "```sql",
    "SELECT 1",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("fragments.user.active"));
  assert.strictEqual(registry.getMeta("fragments.user.active").description, "Active user fragment");
});

test("SqlRegistry rejects invalid appendQuery query ids on loadFile", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-invalid-query-reference-id.md");
  writeFixture(fixturePath, [
    "## users.search",
    "",
    "```sql",
    "SELECT * FROM users /*#where*/",
    "```",
    "",
    "```js builder",
    "appendQuery('where', 'fragments/drop');",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  assert.throws(
    () => registry.loadFile(fixturePath),
    error => {
      assert.match(error.errors.join("\n"), /appendQuery references invalid query id: fragments\/drop/);
      return true;
    }
  );
});

test("SqlRegistry accepts a BOM at the start of a markdown registry file", async () => {
  const fixturePath = path.join(__dirname, ".tmp", "registry-bom-root.md");
  writeFixture(fixturePath, [
    "\uFEFF## users.find",
    "",
    "param: id:integer - User ID",
    "",
    "```sql",
    "SELECT * FROM users WHERE id = :id",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(fixturePath);
  assert.ok(registry.has("users.find"));
});

test("SqlRegistry accepts a BOM at the start of an imported markdown file", async () => {
  const fixtureDir = path.join(__dirname, ".tmp", "registry-bom-import");
  const rootPath = path.join(fixtureDir, "root.md");
  const childPath = path.join(fixtureDir, "child.md");

  writeFixture(rootPath, [
    '@import "./child.md" as child',
    ""
  ]);
  writeFixture(childPath, [
    "\uFEFF## find",
    "",
    "param: id:integer - User ID",
    "",
    "```sql",
    "SELECT * FROM users WHERE id = :id",
    "```",
    ""
  ]);

  const registry = new SqlRegistry();

  registry.loadFile(rootPath);
  assert.ok(registry.has("child.find"));
});

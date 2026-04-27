const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { bindSql } = require("../dist/lib/binder");
const { validateBindParams } = require("../dist/lib/bind-validator");
const { compileSql } = require("../dist/lib/sql-compiler");
const { extractNamedParamTokens } = require("../dist/lib/param-parser");
const {
  SqlRegistry,
  SqlRegistryAdapter,
  BetterSqlite3Adapter,
  MariadbAdapter,
  NodeSqliteAdapter,
  SequelizeAdapter
} = require("../index");
const { SqlBuilder, SqlBuilderError } = require("../dist/lib/builder");
const { buildExplain } = require("../dist/lib/explain-builder");
const { normalizeParamType } = require("../dist/lib/param-types");
const { test, run } = require("./harness");
require("./param-parser.test");

function getNodeSqliteDatabaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
}

function plainRows(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row)));
}

test("bindSql replaces named params outside string literals", async () => {
  const stmt = bindSql(
    "select ':literal' as x, :id as id",
    { id: 1 }
  );

  assert.deepStrictEqual(stmt, {
    sql: "select ':literal' as x, ? as id",
    values: [1]
  });
});

test("bindSql ignores params inside comments", async () => {
  const stmt = bindSql(
    "select :id as id -- :ignored\nwhere id = :id",
    { id: 7 }
  );

  assert.deepStrictEqual(stmt, {
    sql: "select ? as id -- :ignored\nwhere id = ?",
    values: [7, 7]
  });
});

test("extractNamedParamTokens returns bind positions from the shared parser", async () => {
  const sql = "select ':literal' as x, :id as id -- :ignored\nwhere role = :role";

  assert.deepStrictEqual(extractNamedParamTokens(sql), [
    {
      name: "id",
      start: 24,
      end: 27
    },
    {
      name: "role",
      start: 59,
      end: 64
    }
  ]);
});

test("validateBindParams owns missing and unknown param checks", async () => {
  assert.throws(
    () => validateBindParams("select :id", ["id"], {}),
    /missing params: id/
  );

  assert.throws(
    () => validateBindParams("select :id", ["id"], { id: 1, extra: 2 }),
    /unknown params: extra/
  );

  assert.doesNotThrow(
    () => validateBindParams("select :id", ["id"], { id: 1, extra: 2 }, { strict: false })
  );
});

test("compileSql owns placeholder conversion and value ordering", async () => {
  const sql = "select :id as id, :role as role, :id as again";
  const tokens = extractNamedParamTokens(sql);

  assert.deepStrictEqual(compileSql(sql, tokens, { id: 7, role: "admin" }), {
    sql: "select ? as id, ? as role, ? as again",
    values: [7, "admin", 7]
  });
});

test("buildExplain accepts pg dialect", async () => {
  const stmt = buildExplain(
    { sql: "select 1", values: [] },
    { dialect: "pg" }
  );

  assert.deepStrictEqual(stmt, {
    sql: "EXPLAIN select 1",
    values: []
  });
});

test("buildExplain uses analyze for pg dialect", async () => {
  const stmt = buildExplain(
    { sql: "select 1", values: [1] },
    { dialect: "pg", analyze: true }
  );

  assert.deepStrictEqual(stmt, {
    sql: "EXPLAIN ANALYZE select 1",
    values: [1]
  });
});

test("buildExplain normalizes dialect aliases through dialect module", async () => {
  const stmt = buildExplain(
    { sql: "select 1", values: [] },
    { dialect: "postgresql" }
  );

  assert.deepStrictEqual(stmt, {
    sql: "EXPLAIN select 1",
    values: []
  });
});

test("runBuilderScript supports a whitelisted builder subset", async () => {
  const registry = {
    getSql(name) {
      if (name !== "fragments.active") {
        throw new Error(`unexpected query: ${name}`);
      }

      return "AND active = :active";
    }
  };

  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users /*#where*/ /*#order*/ /*#page*/",
    { orderable: { createdAt: "users.created_at" } }
  );

  builder.runBuilderScript(
    [
      "if (params.active) {",
      "  at('where').appendQuery('fragments.active', { active: params.active });",
      "}",
      "if (context.sort) {",
      "  orderBy('order', context.sort, false);",
      "}",
      "limit('page', params.limit);",
      "offset('page', params.offset);"
    ].join("\n"),
    {
      params: { active: true, limit: 10, offset: 20 },
      context: { sort: "createdAt" }
    }
  );

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users AND active = ? ORDER BY users.created_at DESC LIMIT ?\nOFFSET ?",
    values: [true, 10, 20]
  });
});

test("runBuilderScript rejects unsupported globals", async () => {
  const builder = new SqlBuilder(null, "users.search", "SELECT 1");

  assert.throws(
    () => builder.runBuilderScript("process.exit(1)"),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /unknown identifier: process/);
      return true;
    }
  );
});

test("runBuilderScript rejects forbidden property access", async () => {
  const builder = new SqlBuilder(null, "users.search", "SELECT 1");

  assert.throws(
    () => builder.runBuilderScript("params.constructor"),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /forbidden property access: constructor/);
      return true;
    }
  );
});

test("runBuilderScript rejects dynamic SQL fragments", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      "append('where', params.sql)",
      {
        params: {
          sql: "WHERE id = 1 OR 1 = 1"
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /append SQL must be a string literal/);
      return true;
    }
  );
});

test("runBuilderScript rejects template-built SQL fragments", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      "append('where', `WHERE name = '${params.name}'`)",
      {
        params: {
          name: "Alice' OR 1 = 1 --"
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /append SQL must be a string literal/);
      return true;
    }
  );
});

test("runBuilderScript rejects computed helper methods", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      "at('where')['append'](params.sql)",
      {
        params: {
          sql: "WHERE id = 1 OR 1 = 1"
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /computed helper methods are not allowed/);
      return true;
    }
  );
});

test("runBuilderScript rejects dynamic append params objects", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      "append('where', 'WHERE id = :id', params.binds)",
      {
        params: {
          binds: {
            id: 1
          }
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /append params must be an object literal/);
      return true;
    }
  );
});

test("runBuilderScript rejects aliased append helper calls", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      [
        "const add = append;",
        "add('where', params.sql);"
      ].join("\n"),
      {
        params: {
          sql: "WHERE id = 1 OR 1 = 1"
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /unsupported function: add/);
      return true;
    }
  );
});

test("runBuilderScript rejects aliased slot helper method calls", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      [
        "const add = at('where').append;",
        "add(params.sql);"
      ].join("\n"),
      {
        params: {
          sql: "WHERE id = 1 OR 1 = 1"
        }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /unsupported function: add/);
      return true;
    }
  );
});

test("runBuilderScript rejects empty appendQuery params objects", async () => {
  const registry = {
    getSql(name) {
      assert.strictEqual(name, "fragments.active");
      return "AND active = :active";
    }
  };
  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users WHERE 1 = 1 /*#where*/"
  );

  assert.throws(
    () => builder.runBuilderScript(
      "appendQuery('where', 'fragments.active', {})"
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /appendQuery params must not be empty/);
      return true;
    }
  );
});

test("SqlBuilder appendQuery accepts omitted params", async () => {
  const registry = {
    getSql(name) {
      assert.strictEqual(name, "fragments.notDeleted");
      return "AND deleted = 0";
    }
  };
  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users WHERE 1 = 1 /*#where*/"
  );

  builder.appendQuery("where", "fragments.notDeleted");

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users WHERE 1 = 1 AND deleted = 0",
    values: []
  });
});

test("SqlBuilder appendQuery rejects empty params", async () => {
  const registry = {
    getSql(name) {
      assert.strictEqual(name, "fragments.notDeleted");
      return "AND deleted = 0";
    }
  };
  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users WHERE 1 = 1 /*#where*/"
  );

  assert.throws(
    () => builder.appendQuery("where", "fragments.notDeleted", {}),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /appendQuery params must not be empty/);
      return true;
    }
  );
});

test("SqlBuilder appendQuery rejects params not used by fragment", async () => {
  const registry = {
    getSql(name) {
      assert.strictEqual(name, "fragments.active");
      return "AND active = :active";
    }
  };
  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users WHERE 1 = 1 /*#where*/"
  );

  assert.throws(
    () => builder.appendQuery("where", "fragments.active", {
      active: true,
      unused: 1
    }),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /appendQuery params not used in query: unused/);
      return true;
    }
  );
});

test("SqlBuilder appendQuery accepts params used by fragment", async () => {
  const registry = {
    getSql(name) {
      assert.strictEqual(name, "fragments.active");
      return "AND active = :active";
    }
  };
  const builder = new SqlBuilder(
    registry,
    "users.search",
    "SELECT * FROM users WHERE 1 = 1 /*#where*/"
  );

  builder.appendQuery("where", "fragments.active", {
    active: true
  });

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users WHERE 1 = 1 AND active = ?",
    values: [true]
  });
});

test("SqlBuilder rejects appends to undefined slots immediately", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  assert.throws(
    () => builder.append("missing", "WHERE id = :id", { id: 1 }),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /slot marker not found in sql: missing/);
      return true;
    }
  );
});

test("SqlBuilder validates and coerces limit and offset", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#paging*/",
    {
      maxLimit: 50,
      maxOffset: 100
    }
  );

  builder.limit("paging", "10").offset("paging", 20);

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users LIMIT ?\nOFFSET ?",
    values: [10, 20]
  });

  assert.throws(
    () => builder.limit("paging", 51),
    /limit exceeds maximum value: 50/
  );

  assert.throws(
    () => builder.offset("paging", "1.5"),
    /offset must be a non-negative integer/
  );
});

test("runBuilderScript allows one nested if", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/"
  );

  builder.runBuilderScript(
    [
      "if (params.enabled) {",
      "  if (params.active) {",
      "    append('where', 'WHERE active = :active', { active: params.active });",
      "  }",
      "}"
    ].join("\n"),
    {
      params: { enabled: true, active: true }
    }
  );

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users WHERE active = ?",
    values: [true]
  });
});

test("runBuilderScript rejects deeply nested if", async () => {
  const builder = new SqlBuilder(null, "users.search", "SELECT 1");

  assert.throws(
    () => builder.runBuilderScript(
      [
        "if (params.a) {",
        "  if (params.b) {",
        "    if (params.c) {",
        "      append('x', 'SELECT 1');",
        "    }",
        "  }",
        "}"
      ].join("\n"),
      {
        params: { a: true, b: true, c: true }
      }
    ),
    error => {
      assert.ok(error instanceof SqlBuilderError);
      assert.match(error.message, /if nesting exceeds the allowed depth/);
      return true;
    }
  );
});

test("SqlRegistry.builder creates a builder for the named query", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });

  registry.queries["users.search"] = {
    meta: { params: [] },
    sql: {
      default: "SELECT * FROM users /*#where*/ /*#order*/"
    }
  };

  registry.queries["fragments.active"] = {
    meta: { params: [] },
    sql: {
      default: "WHERE active = :active"
    }
  };

  const builder = registry.builder("users.search", {
    orderable: {
      createdAt: "users.created_at"
    }
  });

  builder
    .appendQuery("where", "fragments.active", { active: true })
    .orderBy("order", "createdAt", false);

  assert.deepStrictEqual(builder.build(), {
    sql: "SELECT * FROM users WHERE active = ? ORDER BY users.created_at DESC",
    values: [true]
  });
});

test("SqlBuilder.buildExplain explains the built SQL", async () => {
  const builder = new SqlBuilder(
    null,
    "users.search",
    "SELECT * FROM users /*#where*/",
    { dialect: "pg" }
  );

  builder.append("where", "WHERE id = :id", { id: 1 });

  assert.deepStrictEqual(builder.buildExplain({ analyze: true }), {
    sql: "EXPLAIN ANALYZE SELECT * FROM users WHERE id = ?",
    values: [1]
  });
});

test("SqlRegistry loads builder and orderable metadata from markdown", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-builder.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## common.subquery.latestOrder",
      "",
      "description: latest order subquery",
      "",
      "```sql",
      "SELECT user_id, amount",
      "FROM latest_orders",
      "```",
      "",
      "## user.searchWithLatestOrder",
      "",
      "description: User search",
      "param: name - User name",
      "param: status - Status",
      "param: tenantId - Tenant ID",
      "param: sort - Sort key",
      "param: limit - Limit",
      "param: offset - Offset",
      "param: asc - Asc flag",
      "",
      "orderable:",
      "  createdAt: u.created_at",
      "  name: u.name",
      "  id: u.id",
      "",
      "```sql",
      "SELECT",
      "  u.id,",
      "  u.name,",
      "  u.status,",
      "  lo.amount AS latest_order_amount",
      "FROM users u",
      "LEFT JOIN (",
      "/*#subquery.latestOrder*/",
      ") lo ON lo.user_id = u.id",
      "WHERE u.deleted = 0",
      "/*#where*/",
      "/*#orderBy*/",
      "/*#paging*/",
      "```",
      "",
      "```js builder",
      "appendQuery('subquery.latestOrder', 'common.subquery.latestOrder');",
      "",
      "if (params.name) {",
      "  append('where', 'AND u.name LIKE :name', {",
      "    name: `%${params.name}%`",
      "  });",
      "}",
      "",
      "if (params.status) {",
      "  append('where', 'AND u.status = :status', {",
      "    status: params.status",
      "  });",
      "}",
      "",
      "if (!context.isAdmin) {",
      "  append('where', 'AND u.tenant_id = :tenantId', {",
      "    tenantId: context.tenantId",
      "  });",
      "}",
      "",
      "orderBy('orderBy', params.sort || 'createdAt', params.asc !== false);",
      "",
      "limit('paging', params.limit);",
      "offset('paging', params.offset);",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  const stmt = registry.builder("user.searchWithLatestOrder", {
    params: {
      name: "Alice",
      status: "active",
      sort: "name",
      asc: true,
      limit: 20,
      offset: 40
    },
    context: {
      isAdmin: false,
      tenantId: 10
    }
  }).build();

  assert.deepStrictEqual(stmt, {
    sql: [
      "SELECT",
      "  u.id,",
      "  u.name,",
      "  u.status,",
      "  lo.amount AS latest_order_amount",
      "FROM users u",
      "LEFT JOIN (",
      "SELECT user_id, amount",
      "FROM latest_orders",
      ") lo ON lo.user_id = u.id",
      "WHERE u.deleted = 0",
      "AND u.name LIKE ?",
      "AND u.status = ?",
      "AND u.tenant_id = ?",
      "ORDER BY u.name ASC",
      "LIMIT ?",
      "OFFSET ?"
    ].join("\n"),
    values: ["%Alice%", "active", 10, 20, 40]
  });
});

test("SqlRegistry loads markdown list-style metadata", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-list-metadata.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## insertImage",
      "",
      "- description: <br>",
      "Register an image record.<br>",
      "Use it where appropriate.<br>",
      "",
      "- param: id - ID",
      "- param: file_name - File name",
      "- param: relative_path - Relative path",
      "- param: year - Year",
      "",
      "```sql",
      "INSERT OR IGNORE INTO images (",
      "  id,",
      "  file_name,",
      "  relative_path,",
      "  year",
      ") VALUES (",
      "  :id,",
      "  :file_name,",
      "  :relative_path,",
      "  :year",
      ");",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  assert.deepStrictEqual(registry.getMeta("insertImage"), {
    description: [
      "<br>",
      "Register an image record.<br>",
      "Use it where appropriate.<br>"
    ].join("\n"),
    params: [
      { name: "id", description: "ID" },
      { name: "file_name", description: "File name" },
      { name: "relative_path", description: "Relative path" },
      { name: "year", description: "Year" }
    ]
  });
});

test("SqlRegistry loads image query markdown used by another app", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-image-queries.md");
  fs.writeFileSync(
    fixturePath,
    [
      "# Image query definitions",
      "",
      "## listScreenshots",
      "",
      "- description: <br>",
      "Gets screenshot rows for the list screen.<br>",
      "",
      "- param: state - Processing state",
      "- param: subject - Subject name",
      "- param: shotAtFrom - Shot date lower bound",
      "- param: shotAtTo - Shot date upper bound",
      "- param: limitNum - Limit",
      "- param: offsetNum - Offset",
      "```sql",
      "SELECT",
      "  i.id,",
      "  i.file_name,",
      "  i.relative_path,",
      "  i.primary_subject,",
      "  sm.name AS primary_subject_name,",
      "  i.state,",
      "  i.created_at,",
      "  i.shot_at",
      "FROM images i",
      "LEFT JOIN subject_master sm",
      "  ON sm.id = i.primary_subject",
      "WHERE 1 = 1",
      "/*#where*/",
      "ORDER BY i.shot_at DESC",
      "LIMIT :limitNum",
      "OFFSET :offsetNum",
      "```",
      "",
      "```js builder",
      "if (params.state) {",
      "  append('where', 'AND i.state = :state', {",
      "    state: params.state",
      "  });",
      "}",
      "",
      "if (params.subject) {",
      "  append('where', 'AND EXISTS (');",
      "  appendQuery('where', 'images.subjectExists', {",
      "    subject: params.subject",
      "  });",
      "  append('where', ')');",
      "}",
      "",
      "if (params.shotAtFrom) {",
      "  append('where', 'AND date(i.shot_at) >= date(:shotAtFrom)', {",
      "    shotAtFrom: params.shotAtFrom",
      "  });",
      "}",
      "",
      "if (params.shotAtTo) {",
      "  append('where', 'AND date(i.shot_at) <= date(:shotAtTo)', {",
      "    shotAtTo: params.shotAtTo",
      "  });",
      "}",
      "```",
      "",
      "## updateScreenshot",
      "",
      "- description: <br>",
      "Updates only requested screenshot columns.<br>",
      "",
      "- param: id - Screenshot ID",
      "- param: state - New processing state",
      "- param: primarySubject - New primary subject ID",
      "```sql",
      "UPDATE images",
      "SET",
      "/*#set*/",
      "WHERE id = :id",
      "```",
      "",
      "```js builder",
      "if (params.hasState) {",
      "  append('set', 'state = :state', {",
      "    state: params.state",
      "  });",
      "}",
      "",
      "if (params.hasPrimarySubject) {",
      "  if (params.hasState) {",
      "    append('set', ', primary_subject = :primarySubject', {",
      "      primarySubject: params.primarySubject",
      "    });",
      "  } else {",
      "    append('set', 'primary_subject = :primarySubject', {",
      "      primarySubject: params.primarySubject",
      "    });",
      "  }",
      "}",
      "```",
      "",
      "## images.subjectExists",
      "",
      "- description: <br>",
      "Subquery for subject name filtering.<br>",
      "",
      "- param: subject - Subject name",
      "```sql",
      "SELECT 1",
      "FROM image_subjects ims",
      "JOIN subject_master s",
      "  ON s.id = ims.subject_id",
      "WHERE ims.image_id = i.id",
      "  AND s.name = :subject",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  assert.deepStrictEqual(registry.list(), [
    "images.subjectExists",
    "listScreenshots",
    "updateScreenshot"
  ]);

  assert.deepStrictEqual(
    registry.builder("listScreenshots", {
      params: {
        state: "ready",
        subject: "cat",
        shotAtFrom: "2026-04-01",
        shotAtTo: "2026-04-30",
        limitNum: 20,
        offsetNum: 40
      }
    }).build(),
    {
      sql: [
        "SELECT",
        "  i.id,",
        "  i.file_name,",
        "  i.relative_path,",
        "  i.primary_subject,",
        "  sm.name AS primary_subject_name,",
        "  i.state,",
        "  i.created_at,",
        "  i.shot_at",
        "FROM images i",
        "LEFT JOIN subject_master sm",
        "  ON sm.id = i.primary_subject",
        "WHERE 1 = 1",
        "AND i.state = ?",
        "AND EXISTS (",
        "SELECT 1",
        "FROM image_subjects ims",
        "JOIN subject_master s",
        "  ON s.id = ims.subject_id",
        "WHERE ims.image_id = i.id",
        "  AND s.name = ?",
        ")",
        "AND date(i.shot_at) >= date(?)",
        "AND date(i.shot_at) <= date(?)",
        "ORDER BY i.shot_at DESC",
        "LIMIT ?",
        "OFFSET ?"
      ].join("\n"),
      values: ["ready", "cat", "2026-04-01", "2026-04-30", 20, 40]
    }
  );

  assert.deepStrictEqual(
    registry.builder("updateScreenshot", {
      params: {
        id: "img-1",
        hasState: true,
        state: "done",
        hasPrimarySubject: true,
        primarySubject: null
      }
    }).build(),
    {
      sql: [
        "UPDATE images",
        "SET",
        "state = ?",
        ", primary_subject = ?",
        "WHERE id = ?"
      ].join("\n"),
      values: ["done", null, "img-1"]
    }
  );
});

test("SqlRegistry normalizes SQL fence dialect aliases", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-dialect-alias.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.pgOnly",
      "param: id",
      "",
      "```sql postgres",
      "SELECT * FROM users WHERE id = :id",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry({ strict: false, dialect: "postgresql" });
  registry.loadFile(fixturePath);

  assert.deepStrictEqual(registry.bind("users.pgOnly", { id: 1 }), {
    sql: "SELECT * FROM users WHERE id = ?",
    values: [1]
  });
});

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
  const registry = new SqlRegistry({ strict: false });
  registry.queries["events.findAfter"] = {
    meta: {
      params: [
        {
          name: "createdAt",
          type: "date",
          description: "Created timestamp"
        }
      ]
    },
    sql: {
      default: "SELECT * FROM events WHERE created_at >= :createdAt"
    }
  };

  assert.deepStrictEqual(
    registry.bind("events.findAfter", { createdAt: "2026-04-27 12:34:56.789" }),
    {
      sql: "SELECT * FROM events WHERE created_at >= ?",
      values: ["2026-04-27 12:34:56.789"]
    }
  );
});

test("SqlRegistry validates typed params on bind", async () => {
  const registry = new SqlRegistry({ strict: false });
  registry.queries["users.findTyped"] = {
    meta: {
      params: [
        {
          name: "id",
          type: "integer",
          description: "User ID"
        }
      ]
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  assert.throws(
    () => registry.bind("users.findTyped", { id: "1" }),
    /invalid type for param: id/
  );

  assert.deepStrictEqual(registry.bind("users.findTyped", { id: 1 }), {
    sql: "SELECT * FROM users WHERE id = ?",
    values: [1]
  });
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

  assert.deepStrictEqual(
    registry.builder("users.searchTyped", {
      params: {
        limit: 10
      }
    }).build(),
    {
      sql: "SELECT * FROM users LIMIT ?",
      values: [10]
    }
  );
});

test("SqlRegistry supports TypeScript builder blocks", async () => {
  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-typescript-builder.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.searchTsBuilder",
      "param: active:boolean - Active flag",
      "",
      "```sql",
      "SELECT * FROM users WHERE 1 = 1 /*#where*/",
      "```",
      "",
      "```ts builder",
      "const active: boolean = params.active;",
      "if (active) {",
      "  append('where', 'AND active = :active', { active });",
      "}",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  assert.deepStrictEqual(
    registry.builder("users.searchTsBuilder", {
      params: {
        active: true
      }
    }).build(),
    {
      sql: "SELECT * FROM users WHERE 1 = 1 AND active = ?",
      values: [true]
    }
  );
});

test("SqlRegistry executes markdown-built SQL against node:sqlite", async () => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return;

  const fixtureDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fixturePath = path.join(fixtureDir, "registry-sqlite-integration.md");
  fs.writeFileSync(
    fixturePath,
    [
      "## users.searchSqlite",
      "",
      "param: name:string - Partial user name",
      "param: active:int - Active flag",
      "param: sort:string - Sort key",
      "param: limit:int - Page size",
      "",
      "orderable:",
      "  name: name",
      "  createdAt: created_at",
      "",
      "```sql",
      "SELECT",
      "  id,",
      "  name,",
      "  active",
      "FROM users",
      "WHERE 1 = 1",
      "/*#where*/",
      "/*#order*/",
      "/*#paging*/",
      "```",
      "",
      "```ts builder",
      "if (params.name) {",
      "  append('where', 'AND name LIKE :name', {",
      "    name: `%${params.name}%`",
      "  });",
      "}",
      "",
      "if (params.active != null) {",
      "  append('where', 'AND active = :active', {",
      "    active: params.active",
      "  });",
      "}",
      "",
      "orderBy('order', params.sort || 'createdAt', true);",
      "limit('paging', params.limit);",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  const db = new DatabaseSync(":memory:");
  db.exec([
    "CREATE TABLE users (",
    "  id INTEGER PRIMARY KEY,",
    "  name TEXT NOT NULL,",
    "  active INTEGER NOT NULL,",
    "  created_at TEXT NOT NULL",
    ")"
  ].join("\n"));

  db.prepare("INSERT INTO users (id, name, active, created_at) VALUES (?, ?, ?, ?)")
    .run(1, "Alice", 1, "2026-01-01");
  db.prepare("INSERT INTO users (id, name, active, created_at) VALUES (?, ?, ?, ?)")
    .run(2, "Bob", 1, "2026-01-02");
  db.prepare("INSERT INTO users (id, name, active, created_at) VALUES (?, ?, ?, ?)")
    .run(3, "Alicia", 0, "2026-01-03");

  const registry = new SqlRegistry();
  registry.loadFile(fixturePath);

  const stmt = registry.builder("users.searchSqlite", {
    params: {
      name: "Ali",
      active: 1,
      sort: "name",
      limit: 10
    }
  }).build();

  assert.deepStrictEqual(plainRows(db.prepare(stmt.sql).all(...stmt.values)), [
    {
      id: 1,
      name: "Alice",
      active: 1
    }
  ]);

  db.close();
});

test("SqlRegistry builder can build explain from markdown-driven SQL", async () => {
  const registry = new SqlRegistry();
  registry.loadFile(path.join(__dirname, ".tmp", "registry-builder.md"));

  const stmt = registry.builder("user.searchWithLatestOrder", {
    params: {
      name: "Alice",
      status: "active",
      sort: "name",
      asc: true,
      limit: 20,
      offset: 40
    },
    context: {
      isAdmin: false,
      tenantId: 10
    }
  }).buildExplain();

  assert.deepStrictEqual(stmt, {
    sql: [
      "EXPLAIN SELECT",
      "  u.id,",
      "  u.name,",
      "  u.status,",
      "  lo.amount AS latest_order_amount",
      "FROM users u",
      "LEFT JOIN (",
      "SELECT user_id, amount",
      "FROM latest_orders",
      ") lo ON lo.user_id = u.id",
      "WHERE u.deleted = 0",
      "AND u.name LIKE ?",
      "AND u.status = ?",
      "AND u.tenant_id = ?",
      "ORDER BY u.name ASC",
      "LIMIT ?",
      "OFFSET ?"
    ].join("\n"),
    values: ["%Alice%", "active", 10, 20, 40]
  });
});

test("SqlRegistryAdapter queries by SQL ID", async () => {
  class MemoryAdapter extends SqlRegistryAdapter {
    async executeStatement(executor, stmt, options = {}) {
      executor.calls.push({
        stmt,
        options
      });

      return {
        sql: stmt.sql,
        values: stmt.values
      };
    }
  }

  const registry = new SqlRegistry({ strict: false });
  registry.queries["users.search"] = {
    meta: {
      params: [],
      orderable: {
        createdAt: "users.created_at"
      },
      builder: "orderBy('order', params.sort || 'createdAt', params.asc !== false);"
    },
    sql: {
      default: "SELECT * FROM users /*#order*/"
    }
  };

  const adapter = new MemoryAdapter(registry, {
    context: {
      tenantId: 10
    }
  });
  const executor = { calls: [] };

  const result = await adapter.query(executor, "users.search", {
    params: {
      sort: "createdAt",
      asc: false
    },
    queryOptions: {
      raw: true
    }
  });

  assert.deepStrictEqual(result, {
    sql: "SELECT * FROM users ORDER BY users.created_at DESC",
    values: []
  });

  assert.deepStrictEqual(executor.calls, [
    {
      stmt: {
        sql: "SELECT * FROM users ORDER BY users.created_at DESC",
        values: []
      },
      options: {
        params: {
          sort: "createdAt",
          asc: false
        },
        queryOptions: {
          raw: true
        }
      }
    }
  ]);
});

test("SqlRegistryAdapter can explain by SQL ID", async () => {
  class MemoryAdapter extends SqlRegistryAdapter {
    async executeStatement(executor, stmt) {
      executor.calls.push(stmt);
      return stmt;
    }
  }

  const registry = new SqlRegistry({ strict: false, dialect: "pg" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const adapter = new MemoryAdapter(registry);
  const executor = { calls: [] };

  const result = await adapter.explain(executor, "users.findById", {
    params: {
      id: 1
    },
    explainOptions: {
      analyze: true
    }
  });

  assert.deepStrictEqual(result, {
    sql: "EXPLAIN ANALYZE SELECT * FROM users WHERE id = ?",
    values: [1]
  });
});

test("BetterSqlite3Adapter queries by SQL ID", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findActive"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE active = :active"
    }
  };

  const calls = [];
  const db = {
    prepare(sql) {
      calls.push({ type: "prepare", sql });

      return {
        all(...values) {
          calls.push({ type: "all", values });
          return [{ id: 1, active: 1 }];
        }
      };
    }
  };

  const adapter = new BetterSqlite3Adapter(db, registry);
  const result = await adapter.query("users.findActive", {
    params: {
      active: 1
    }
  });

  assert.deepStrictEqual(result, [{ id: 1, active: 1 }]);
  assert.deepStrictEqual(calls, [
    {
      type: "prepare",
      sql: "SELECT * FROM users WHERE active = ?"
    },
    {
      type: "all",
      values: [1]
    }
  ]);
});

test("BetterSqlite3Adapter executes against node:sqlite compatible database", async () => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return;

  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findByActive"] = {
    meta: {
      params: [
        {
          name: "active",
          type: "integer",
          description: "Active flag"
        }
      ]
    },
    sql: {
      default: [
        "SELECT id, name",
        "FROM users",
        "WHERE active = :active",
        "ORDER BY id"
      ].join("\n")
    }
  };

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)");
  db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(1, "Alice", 1);
  db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(2, "Bob", 0);

  const adapter = new BetterSqlite3Adapter(db, registry);
  const rows = await adapter.query("users.findByActive", {
    params: {
      active: 1
    }
  });

  assert.deepStrictEqual(plainRows(rows), [
    {
      id: 1,
      name: "Alice"
    }
  ]);

  db.close();
});

test("BetterSqlite3Adapter supports statement methods and options", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT id, name FROM users WHERE id = :id"
    }
  };

  const calls = [];
  const statement = {
    raw() {
      calls.push({ type: "raw" });
      return this;
    },
    pluck() {
      calls.push({ type: "pluck" });
      return this;
    },
    get(...values) {
      calls.push({ type: "get", values });
      return "Alice";
    }
  };
  const db = {
    prepare(sql) {
      calls.push({ type: "prepare", sql });
      return statement;
    }
  };

  const adapter = new BetterSqlite3Adapter(db, registry);
  const result = await adapter.query("users.findById", {
    params: {
      id: 1
    },
    queryOptions: {
      method: "get",
      raw: true,
      pluck: true
    }
  });

  assert.strictEqual(result, "Alice");
  assert.deepStrictEqual(calls, [
    {
      type: "prepare",
      sql: "SELECT id, name FROM users WHERE id = ?"
    },
    {
      type: "raw"
    },
    {
      type: "pluck"
    },
    {
      type: "get",
      values: [1]
    }
  ]);
});

test("BetterSqlite3Adapter can run write statements", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.rename"] = {
    meta: {
      params: []
    },
    sql: {
      default: "UPDATE users SET name = :name WHERE id = :id"
    }
  };

  const db = {
    prepare(sql) {
      assert.strictEqual(sql, "UPDATE users SET name = ? WHERE id = ?");

      return {
        run(...values) {
          assert.deepStrictEqual(values, ["Alice", 1]);
          return {
            changes: 1,
            lastInsertRowid: 0
          };
        }
      };
    }
  };

  const adapter = new BetterSqlite3Adapter(registry);
  const result = await adapter.query(db, "users.rename", {
    params: {
      id: 1,
      name: "Alice"
    }
  });

  assert.deepStrictEqual(result, {
    changes: 1,
    lastInsertRowid: 0
  });
});

test("BetterSqlite3Adapter can explain with a bound database", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const db = {
    prepare(sql) {
      assert.strictEqual(sql, "EXPLAIN SELECT * FROM users WHERE id = ?");

      return {
        all(...values) {
          assert.deepStrictEqual(values, [1]);
          return [{ detail: "SEARCH users USING INTEGER PRIMARY KEY" }];
        }
      };
    }
  };

  const adapter = new BetterSqlite3Adapter(db, registry);
  const result = await adapter.explain("users.findById", {
    params: {
      id: 1
    }
  });

  assert.deepStrictEqual(result, [
    {
      detail: "SEARCH users USING INTEGER PRIMARY KEY"
    }
  ]);
});

test("NodeSqliteAdapter queries by SQL ID", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findActive"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE active = :active"
    }
  };

  const calls = [];
  const db = {
    prepare(sql) {
      calls.push({ type: "prepare", sql });

      return {
        all(...values) {
          calls.push({ type: "all", values });
          return [{ id: 1, active: 1 }];
        }
      };
    }
  };

  const adapter = new NodeSqliteAdapter(db, registry);
  const result = await adapter.query("users.findActive", {
    params: {
      active: 1
    }
  });

  assert.deepStrictEqual(result, [{ id: 1, active: 1 }]);
  assert.deepStrictEqual(calls, [
    {
      type: "prepare",
      sql: "SELECT * FROM users WHERE active = ?"
    },
    {
      type: "all",
      values: [1]
    }
  ]);
});

test("NodeSqliteAdapter executes against node:sqlite DatabaseSync", async () => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return;

  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findByActive"] = {
    meta: {
      params: [
        {
          name: "active",
          type: "integer",
          description: "Active flag"
        }
      ]
    },
    sql: {
      default: [
        "SELECT id, name",
        "FROM users",
        "WHERE active = :active",
        "ORDER BY id"
      ].join("\n")
    }
  };

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL)");
  db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(1, "Alice", 1);
  db.prepare("INSERT INTO users (id, name, active) VALUES (?, ?, ?)").run(2, "Bob", 0);

  const adapter = new NodeSqliteAdapter(db, registry);
  const rows = await adapter.query("users.findByActive", {
    params: {
      active: 1
    }
  });

  assert.deepStrictEqual(plainRows(rows), [
    {
      id: 1,
      name: "Alice"
    }
  ]);

  db.close();
});

test("NodeSqliteAdapter supports statement methods and options", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT id, name FROM users WHERE id = :id"
    }
  };

  const calls = [];
  const statement = {
    setReturnArrays(enabled) {
      calls.push({ type: "setReturnArrays", enabled });
    },
    setReadBigInts(enabled) {
      calls.push({ type: "setReadBigInts", enabled });
    },
    get(...values) {
      calls.push({ type: "get", values });
      return ["Alice"];
    }
  };
  const db = {
    prepare(sql) {
      calls.push({ type: "prepare", sql });
      return statement;
    }
  };

  const adapter = new NodeSqliteAdapter(db, registry);
  const result = await adapter.query("users.findById", {
    params: {
      id: 1
    },
    queryOptions: {
      method: "get",
      setReturnArrays: true,
      setReadBigInts: true
    }
  });

  assert.deepStrictEqual(result, ["Alice"]);
  assert.deepStrictEqual(calls, [
    {
      type: "prepare",
      sql: "SELECT id, name FROM users WHERE id = ?"
    },
    {
      type: "setReturnArrays",
      enabled: true
    },
    {
      type: "setReadBigInts",
      enabled: true
    },
    {
      type: "get",
      values: [1]
    }
  ]);
});

test("NodeSqliteAdapter can run write statements", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.rename"] = {
    meta: {
      params: []
    },
    sql: {
      default: "UPDATE users SET name = :name WHERE id = :id"
    }
  };

  const db = {
    prepare(sql) {
      assert.strictEqual(sql, "UPDATE users SET name = ? WHERE id = ?");

      return {
        run(...values) {
          assert.deepStrictEqual(values, ["Alice", 1]);
          return {
            changes: 1,
            lastInsertRowid: 0
          };
        }
      };
    }
  };

  const adapter = new NodeSqliteAdapter(registry);
  const result = await adapter.query(db, "users.rename", {
    params: {
      id: 1,
      name: "Alice"
    }
  });

  assert.deepStrictEqual(result, {
    changes: 1,
    lastInsertRowid: 0
  });
});

test("NodeSqliteAdapter can explain with a bound database", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const db = {
    prepare(sql) {
      assert.strictEqual(sql, "EXPLAIN SELECT * FROM users WHERE id = ?");

      return {
        all(...values) {
          assert.deepStrictEqual(values, [1]);
          return [{ detail: "SEARCH users USING INTEGER PRIMARY KEY" }];
        }
      };
    }
  };

  const adapter = new NodeSqliteAdapter(db, registry);
  const result = await adapter.explain("users.findById", {
    params: {
      id: 1
    }
  });

  assert.deepStrictEqual(result, [
    {
      detail: "SEARCH users USING INTEGER PRIMARY KEY"
    }
  ]);
});

test("MariadbAdapter queries by SQL ID", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "mysql" });
  registry.queries["users.findActive"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE active = :active"
    }
  };

  const calls = [];
  const connection = {
    query(sql, values) {
      calls.push({ sql, values });
      return Promise.resolve([{ id: 1, active: 1 }]);
    }
  };

  const adapter = new MariadbAdapter(connection, registry);
  const result = await adapter.query("users.findActive", {
    params: {
      active: 1
    }
  });

  assert.deepStrictEqual(result, [{ id: 1, active: 1 }]);
  assert.deepStrictEqual(calls, [
    {
      sql: "SELECT * FROM users WHERE active = ?",
      values: [1]
    }
  ]);
});

test("MariadbAdapter can use a per-call connection", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "mysql" });
  registry.queries["users.rename"] = {
    meta: {
      params: []
    },
    sql: {
      default: "UPDATE users SET name = :name WHERE id = :id"
    }
  };

  const connection = {
    query(sql, values) {
      assert.strictEqual(sql, "UPDATE users SET name = ? WHERE id = ?");
      assert.deepStrictEqual(values, ["Alice", 1]);
      return Promise.resolve({ affectedRows: 1 });
    }
  };

  const adapter = new MariadbAdapter(registry);
  const result = await adapter.query(connection, "users.rename", {
    params: {
      id: 1,
      name: "Alice"
    }
  });

  assert.deepStrictEqual(result, {
    affectedRows: 1
  });
});

test("MariadbAdapter passes queryOptions with managed sql and values", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "mysql" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const connection = {
    query(sqlOrOptions, values) {
      assert.deepStrictEqual(sqlOrOptions, {
        rowsAsArray: true,
        sql: "SELECT * FROM users WHERE id = ?"
      });
      assert.deepStrictEqual(values, [1]);
      return Promise.resolve([[1, "Alice"]]);
    }
  };

  const adapter = new MariadbAdapter(connection, registry);
  const result = await adapter.query("users.findById", {
    params: {
      id: 1
    },
    queryOptions: {
      rowsAsArray: true
    }
  });

  assert.deepStrictEqual(result, [[1, "Alice"]]);
});

test("MariadbAdapter owns sql and values query options", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "mysql" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const connection = {
    query() {
      throw new Error("unexpected query");
    }
  };

  const adapter = new MariadbAdapter(connection, registry);

  await assert.rejects(
    () => adapter.query("users.findById", {
      params: {
        id: 1
      },
      queryOptions: {
        sql: "SELECT 1"
      }
    }),
    /queryOptions\.sql and queryOptions\.values are managed by MariadbAdapter/
  );
});

test("SequelizeAdapter queries by SQL ID", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findActive"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE active = :active"
    }
  };

  const calls = [];
  const sequelize = {
    query(sql, options) {
      calls.push({ sql, options });
      return Promise.resolve([{ id: 1, active: 1 }]);
    }
  };

  const adapter = new SequelizeAdapter(sequelize, registry);
  const result = await adapter.query("users.findActive", {
    params: {
      active: 1
    },
    queryOptions: {
      type: "SELECT",
      raw: true
    }
  });

  assert.deepStrictEqual(result, [{ id: 1, active: 1 }]);
  assert.deepStrictEqual(calls, [
    {
      sql: "SELECT * FROM users WHERE active = ?",
      options: {
        type: "SELECT",
        raw: true,
        replacements: [1]
      }
    }
  ]);
});

test("SequelizeAdapter can use a per-call sequelize instance", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.rename"] = {
    meta: {
      params: []
    },
    sql: {
      default: "UPDATE users SET name = :name WHERE id = :id"
    }
  };

  const sequelize = {
    query(sql, options) {
      assert.strictEqual(sql, "UPDATE users SET name = ? WHERE id = ?");
      assert.deepStrictEqual(options, {
        type: "UPDATE",
        replacements: ["Alice", 1]
      });
      return Promise.resolve([[], { changes: 1 }]);
    }
  };

  const adapter = new SequelizeAdapter(registry);
  const result = await adapter.query(sequelize, "users.rename", {
    params: {
      id: 1,
      name: "Alice"
    },
    queryOptions: {
      type: "UPDATE"
    }
  });

  assert.deepStrictEqual(result, [[], { changes: 1 }]);
});

test("SequelizeAdapter can explain with a bound sequelize instance", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const sequelize = {
    query(sql, options) {
      assert.strictEqual(sql, "EXPLAIN SELECT * FROM users WHERE id = ?");
      assert.deepStrictEqual(options, {
        type: "SELECT",
        replacements: [1]
      });
      return Promise.resolve([{ detail: "SEARCH users USING INTEGER PRIMARY KEY" }]);
    }
  };

  const adapter = new SequelizeAdapter(sequelize, registry);
  const result = await adapter.explain("users.findById", {
    params: {
      id: 1
    },
    queryOptions: {
      type: "SELECT"
    }
  });

  assert.deepStrictEqual(result, [
    {
      detail: "SEARCH users USING INTEGER PRIMARY KEY"
    }
  ]);
});

test("SequelizeAdapter owns replacements", async () => {
  const registry = new SqlRegistry({ strict: false, dialect: "sqlite" });
  registry.queries["users.findById"] = {
    meta: {
      params: []
    },
    sql: {
      default: "SELECT * FROM users WHERE id = :id"
    }
  };

  const sequelize = {
    query() {
      throw new Error("unexpected query");
    }
  };

  const adapter = new SequelizeAdapter(sequelize, registry);

  await assert.rejects(
    () => adapter.query("users.findById", {
      params: {
        id: 1
      },
      queryOptions: {
        replacements: [2]
      }
    }),
    /queryOptions\.replacements is managed by SequelizeAdapter/
  );
});

run().catch(error => {
  throw error;
});

# sql-registry

> **Status:** sql-registry is pre-1.0. The public API, Markdown format, adapter behavior, and builder helpers may still change in breaking ways. It is usable today, but pin the package version and review release notes before upgrading.

Bring AI-written and handwritten SQL back into a form humans can review, name, type-check, and maintain.

sql-registry is a lightweight TypeScript/JavaScript library for storing SQL in structured Markdown, binding named parameters safely, and adding a small amount of controlled dynamic SQL when a query needs filters, sorting, paging, or reusable fragments.

## Why

In many codebases, SQL slowly becomes hard to maintain:

- SQL strings are spread across services and repositories.
- Parameter meaning and expected types are not documented near the query.
- Dynamic SQL grows from string concatenation.
- `ORDER BY ${sort}` and similar patterns become injection risks.
- Dialect-specific SQL is hidden inside application conditionals.
- SQL review is mixed with unrelated application logic.
- AI-assisted SQL lands as one-off strings without names, parameter metadata, or a clear review surface.
- ORM raw-query calls become the place where complex SQL, bind parameters, and dynamic fragments quietly pile up.

sql-registry keeps query text, parameter metadata, dialect variants, and limited builder logic in Markdown files that can be reviewed like any other source file.

## Philosophy

sql-registry treats SQL as a reviewable static asset, not generated code.

Application input is not allowed to become SQL syntax directly. Runtime values enter as bound values, allowlisted sort keys, and validated paging values. The shape of the SQL stays in the Markdown registry; the parts that change at runtime are explicit and constrained.

The library is responsible for named-parameter binding, parameter metadata validation, dialect-specific SQL selection, and limited SQL fragment insertion. Final SQL syntax, constraints, locks, timeouts, permission errors, and execution behavior remain the responsibility of the database and driver.

It is not meant to replace an ORM. Use Prisma, Sequelize, TypeORM, Drizzle, or your usual query layer for routine CRUD and simple relation loading. Use sql-registry for complex reports, tuned handwritten SQL, dialect-specific queries, ORM raw-query replacements, and SQL that benefits from being reviewed as its own artifact.

## What sql-registry Enforces

- Named parameters are bound as driver values, not interpolated into SQL.
- Each SQL ID, such as `users.search`, is a single-statement definition.
- Runtime sorting uses allowlisted keys, not raw column strings from input.
- `LIMIT` and `OFFSET` are validated as non-negative integers.
- Builder SQL fragments must be static literals in the registry.
- PostgreSQL casts, JSON operators, comments, strings, and dollar quotes are handled by the parameter parser.

## Install

```sh
npm install sql-registry
```

## Quick Example

Create a registry file, for example `sql/users.md`:

````md
## users.search - Search users with filters and paging

param: name:string - Partial user name
param: status:string - User status
param: sort:string - Sort key
param: limit:int - Page size
param: offset:int - Page offset

orderable:
  createdAt: u.created_at
  name: u.name
  status: u.status

```sql
SELECT
  u.id,
  u.name,
  u.status,
  u.created_at
FROM users u
WHERE u.deleted = 0
/*#where*/
/*#order*/
/*#paging*/
```

```ts builder
if (params.name) {
  append('where', 'AND u.name LIKE :name', {
    name: `%${params.name}%`
  });
}

if (params.status) {
  append('where', 'AND u.status = :status', {
    status: params.status
  });
}

orderBy('order', params.sort || 'createdAt', true);
limit('paging', params.limit);
offset('paging', params.offset);
```
````

Load and build it:

```js
const { SqlRegistry } = require("sql-registry");

const registry = new SqlRegistry({ dialect: "pg" });
registry.loadFile("./sql/users.md");

const stmt = registry.builder("users.search", {
  params: {
    name: "Alice",
    status: "active",
    sort: "name",
    limit: 20,
    offset: 0
  }
}).build();

console.log(stmt.sql);
console.log(stmt.values);
```

For PostgreSQL, the built statement uses numbered placeholders:

```js
{
  sql: [
    "SELECT",
    "  u.id,",
    "  u.name,",
    "  u.status,",
    "  u.created_at",
    "FROM users u",
    "WHERE u.deleted = 0",
    "AND u.name LIKE $1",
    "AND u.status = $2",
    "ORDER BY u.name ASC",
    "LIMIT $3",
    "OFFSET $4"
  ].join("\n"),
  values: ["%Alice%", "active", 20, 0]
}
```

## Static SQL

For a plain query without builder slots, use `bind()`:

````md
## users.findById

param: id:int - User id

```sql
SELECT * FROM users WHERE id = :id
```
````

```js
const stmt = registry.bind("users.findById", { id: 123 });
```

## Markdown Format

A query is defined by a second-level heading:

```md
## query.name - Optional description
```

Supported metadata:

- `description: ...`
- `tags: reporting, users`
- `param: name:type - Description`
- `orderable:` mappings for safe `ORDER BY`
- fenced `sql` blocks
- fenced `ts builder` or `js builder` blocks

Supported param types are `any`, `string`/`text`, `number`/`float`, `integer`/`int`, `bigint`, `boolean`/`bool`, `date`/`datetime`/`timestamp`, and `json`.
`integer` validates JavaScript safe integers. `bigint` accepts JavaScript `bigint`, integer strings, and safe integer numbers so database `BIGINT` values can be passed without precision loss.

Dialect-specific SQL can be declared with a dialect name:

````md
```sql pg
SELECT * FROM users WHERE id = :id
```

```sql mysql
SELECT * FROM users WHERE id = :id
```
````

Supported dialect aliases include `sqlite`, `sqlite3`, `mysql`, `mysql2`, `mariadb`, `pg`, `postgres`, and `postgresql`.

## Builder Slots

Slot markers define the only places where builder logic may insert SQL:

```sql
SELECT * FROM users
/*#where*/
/*#order*/
/*#paging*/
```

The builder supports helper functions such as:

- `append(slotName, sql, params)`
- `appendIf(slotName, condition, sql, params)`
- `appendQuery(slotName, queryName, params)`
- `appendQueryIf(slotName, condition, queryName, params)`
- `at(slotName).append(...)`
- `set(sql, params)` and `setIf(...)`
- `orderBy(slotName, key, asc)`
- `limit(slotName, value)`
- `offset(slotName, value)`

`where` slots may start with `AND ...` fragments. If there is no top-level `WHERE` before the slot, sql-registry renders the first fragment as `WHERE ...`.

## Safety Model

sql-registry does not concatenate user input into SQL syntax.

Runtime input is limited to:

- bound values
- declared and type-checked parameters
- allowlisted `ORDER BY` keys
- validated `LIMIT` and `OFFSET` values
- SQL fragments written as static string literals in the registry

Each SQL ID is treated as one statement. Semicolons outside SQL strings and comments are rejected in registry SQL and builder SQL literals. Semicolons inside SQL strings, SQL comments, and PostgreSQL dollar-quoted strings are ignored for this check.

This boundary is intentionally about safe binding and controlled SQL assembly. sql-registry is not a SQL linter. It does not try to judge whether a query is fast, idiomatic, normalized, indexed correctly, logically correct, permission-safe, or style-compliant. Review those concerns with your database, driver, schema design, migrations, tests, EXPLAIN plans, and your team's SQL review process.

LIKE patterns are ordinary bound values. sql-registry prevents SQL injection by keeping the value in `values`; it does not define your search semantics or block wildcard characters such as `%` and `_`.

The builder script is intentionally restricted. It is not general JavaScript execution.

Allowed:

- `if` statements
- simple expressions
- local `const` / `let` values
- access to `params` and `context`
- sql-registry builder helpers

Rejected:

- loops
- arbitrary function calls
- dynamic helper names
- computed helper methods
- dynamic SQL fragment strings
- access to globals such as `process`
- deeply nested control flow

## Validation CLI

Validate registry files before runtime:

```sh
npx sql-registry validate ./sql
npx sql-registry validate --dialect pg ./sql
npx sql-registry validate --json ./sql
npx sql-registry doc --out sql-registry-docs.html ./sql
npx sql-registry doc --lang ja --out sql-registry-docs.html ./sql
npx sql-registry doc --theme dark --out sql-registry-docs.html ./sql
```

The validator reports structure errors such as duplicate query names, missing SQL blocks, undeclared parameters, invalid builder scripts, and unknown `appendQuery()` references.

The `doc` command writes a static HTML registry document with a SQL ID index, file list, query definitions, SQL blocks, params, builder scripts, `appendQuery()` links, and EXPLAIN snippets. It also writes `style.css` and `app.js` next to the output HTML.
Generated docs follow the viewer's system dark theme by default and include an in-page theme selector. Use `--theme auto`, `--theme light`, or `--theme dark` to set the initial rendered theme.
Supported doc UI languages are `en`, `ja`, `ko`, `zh-CN`, `zh-TW`, `es`, `fr`, `de`, and `ru`.

## Imports

Registry files can import other Markdown files:

```md
@import "./fragments/user.md" as fragments.user
@import "./users/search.md" as users
@import "./reports/monthly-sales.md" as reports
```

Imported headings are namespaced, so `## search` in `./users/search.md` becomes `users.search`.

## Adapters

Adapters build statements and pass them to the underlying driver or ORM. They do not start, commit, or roll back transactions; use your driver or ORM transaction API and pass the transaction-bound executor when needed.

| Target | Adapter |
| --- | --- |
| better-sqlite3 | `BetterSqlite3Adapter` |
| node:sqlite | `NodeSqliteAdapter` |
| node-postgres | `PgAdapter` |
| mysql2 | `Mysql2Adapter` |
| MariaDB | `MariadbAdapter` |
| Sequelize | `SequelizeAdapter` |
| TypeORM | `TypeOrmAdapter` |

Example with node-postgres:

```js
const { SqlRegistry, PgAdapter } = require("sql-registry");

const registry = new SqlRegistry({ dialect: "pg" });
registry.loadFile("./sql/users.md");

const adapter = new PgAdapter(pool, registry);
const result = await adapter.query("users.search", {
  params: {
    name: "Alice",
    status: "active",
    sort: "createdAt",
    limit: 20,
    offset: 0
  }
});
```

For an explicit transaction client:

```js
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const adapter = new PgAdapter(registry);
  const result = await adapter.query(client, "users.search", {
    params: {
      name: "Alice",
      sort: "createdAt",
      limit: 20,
      offset: 0
    }
  });

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
```

## EXPLAIN

Build an explain statement without executing it:

```js
const stmt = registry.builder("users.search", {
  params: {
    sort: "createdAt",
    limit: 20
  }
}).buildExplain({ analyze: false });
```

Adapters also expose `explain(...)` for supported executors.

## What This Is Not

sql-registry is not:

- an ORM
- a full query builder
- a SQL parser
- a SQL linter
- a migration tool
- a database security boundary by itself

It is meant to sit beside existing drivers, ORMs, and query builders for SQL that benefits from being explicit, reviewable, and centrally registered.

## Project Status

This project is early and intentionally small.

- Current package version: `0.4.1`
- Runtime: CommonJS package with TypeScript declarations
- License: MIT
- API stability: pre-1.0, breaking changes may occur

See also: [Japanese README](https://github.com/ewigkeit-git/sql-registry/blob/main/README.ja.md)

# sql-registry

Repository: <https://github.com/ewigkeit-git/sql-registry>

> **Status:** sql-registry is pre-1.0. The public API, Markdown format, adapter behavior, and builder helpers may still change in breaking ways. It is usable today, but pin the package version and review release notes before upgrading.

Keep SQL as a readable, reviewable asset instead of scattering it through application code.

sql-registry is a lightweight TypeScript/JavaScript library for storing SQL in structured Markdown, binding named parameters safely, and adding a small amount of controlled dynamic SQL when a query needs filters, sorting, paging, or reusable fragments.

## Why

In many codebases, SQL slowly becomes hard to maintain:

- SQL strings are spread across services and repositories.
- Parameter meaning and expected types are not documented near the query.
- Dynamic SQL grows from string concatenation.
- `ORDER BY ${sort}` and similar patterns become injection risks.
- Dialect-specific SQL is hidden inside application conditionals.
- SQL review is mixed with unrelated application logic.

sql-registry keeps query text, parameter metadata, dialect variants, and limited builder logic in Markdown files that can be reviewed like any other source file.

## Philosophy

sql-registry treats SQL as a reviewable static asset, not generated code.

Application input is not allowed to become SQL syntax directly. Runtime values enter as bound values, allowlisted sort keys, and validated paging values. The shape of the SQL stays in the Markdown registry; the parts that change at runtime are explicit and constrained.

The library is responsible for named-parameter binding, parameter metadata validation, dialect-specific SQL selection, and limited SQL fragment insertion. Final SQL syntax, constraints, locks, timeouts, permission errors, and execution behavior remain the responsibility of the database and driver.

It is not meant to replace an ORM. Use Prisma, Sequelize, TypeORM, Drizzle, or your usual query layer for routine CRUD and simple relation loading. Use sql-registry for complex reports, tuned handwritten SQL, dialect-specific queries, and SQL that benefits from being reviewed as its own artifact.

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

Dialect-specific SQL can be declared with a dialect name:

````md
```sql pg
SELECT * FROM users WHERE id = :id
```

```sql mysql
SELECT * FROM users WHERE id = :id
```
````

Supported dialect aliases include `sqlite`, `sqlite3`, `mysql`, `mysql2`, `pg`, `postgres`, and `postgresql`.

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
```

The validator reports structure errors such as duplicate query names, missing SQL blocks, undeclared parameters, invalid builder scripts, and unknown `appendQuery()` references.

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
- a migration tool
- a database security boundary by itself

It is meant to sit beside existing drivers, ORMs, and query builders for SQL that benefits from being explicit, reviewable, and centrally registered.

## Project Status

This project is early and intentionally small.

- Current package version: `0.3.0`
- Runtime: CommonJS package with TypeScript declarations
- License: MIT
- API stability: pre-1.0, breaking changes may occur

See also: [Japanese README](https://github.com/ewigkeit-git/sql-registry/blob/main/README.ja.md)

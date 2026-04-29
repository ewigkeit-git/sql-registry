# sql-registry

Write SQL in Markdown. Treat it as a first-class asset.

👉 Turn existing SQL into structured Markdown with AI, then keep it maintainable as your system evolves.

sql-registry is a lightweight library for managing SQL in structured Markdown, with safe parameter binding and minimal, controlled dynamic SQL.

Define SQL, parameters, types, descriptions, and conditional logic in one place — and keep it readable and reviewable.

---

## Why?

In real projects, SQL often ends up scattered in application code:

- Hard to see all queries in one place
- Parameter meaning and types are unclear
- Unsafe dynamic SQL (e.g. `ORDER BY ${sort}`)
- Dialect differences hidden in conditionals
- SQL review mixed with application logic

sql-registry moves SQL into Markdown and keeps it readable, structured, and safe.

---

## Example

````md
## users.search

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

Usage:

```js
const stmt = registry.builder("users.search", {
  params: {
    name: "Alice",
    status: "active",
    sort: "name",
    limit: 20,
    offset: 0
  }
}).build();
```

---

## What this is (and is not)

sql-registry is **not**:

- ❌ an ORM
- ❌ a query builder
- ❌ a full SQL parser

Instead, it is:

- ✅ SQL-first
- ✅ Markdown-based SQL registry
- ✅ Safe named parameter binding
- ✅ Minimal, restricted dynamic SQL

---

## Design philosophy

SQL is treated as a **static asset**, not generated code.

- SQL stays readable
- Dynamic behavior is strictly limited
- Runtime input never touches SQL syntax directly

---

## Safety model

Runtime input is constrained to:

- bind values
- allowlisted `ORDER BY`
- validated params
- controlled SQL fragments

No string concatenation of user input into SQL.

---

## Builder constraints (important)

The builder is **not general JavaScript execution**.

Allowed:

- `if` conditions
- helper functions (`append`, `appendQuery`, `orderBy`, `limit`, etc.)

Not allowed:

- loops (`for`, `while`)
- arbitrary function calls
- dynamic SQL string construction
- access to global objects (`process`, etc.)

👉 This keeps SQL predictable and safe.

---

## Works with ORMs

sql-registry is designed to coexist with ORMs like Prisma or Sequelize.

Use ORM for simple CRUD, and sql-registry for:

- complex queries
- reports
- performance-critical SQL
- dialect-specific queries

---

## Supported features

- Markdown-based SQL registry
- Parameter metadata (`param:` with type + description)
- Runtime type validation
- SQLite / PostgreSQL / MySQL dialect support
- Safe named parameter binding (`:id`)
- Controlled dynamic SQL via builder
- `where` slots can start from `AND ...` fragments without `WHERE 1 = 1`
- Optional slot marker descriptions (`/*#where - optional filters*/`)
- `ORDER BY` allowlist
- limit / offset validation
- SQL fragment reuse via `appendQuery`
- Adapter support (better-sqlite3, node-postgres, MariaDB, Sequelize, TypeORM, etc.)
- `EXPLAIN` query generation

---

## Status

This project is **pre-1.0**.

- APIs may change
- Breaking changes may occur
- Maintenance is best-effort

---

## Documentation

- 🇯🇵 Japanese (full docs): ./README.ja.md

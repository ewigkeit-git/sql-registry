# sql-registry Design Standard

This document is a lightweight review standard for SQL written with or around `sql-registry`.

It is meant to help humans and AI review SQL as a design artifact before it becomes scattered implementation detail.

## Scope

Use this standard when:

- defining a new SQL ID
- changing a query's filtering, sorting, paging, or join structure
- reviewing handwritten SQL added beside ORM code
- discussing whether a query should stay static or move to a builder

This standard does not define table modeling rules, migration policy, or DBMS-specific primitive type standards.

## Design Principles

1. Give each SQL ID one clear responsibility.
2. Keep runtime input out of SQL syntax.
3. Prefer reviewable static SQL over generated SQL.
4. Use builder logic only for controlled structural variation.
5. Make parameter intent explicit near the SQL.
6. Keep dialect-specific behavior visible and local.

## Checklist

Review each SQL definition with these questions:

### Responsibility

- Does this SQL ID do one thing well?
- Should this query be split into separate SQL IDs instead of using many optional branches?
- Is the query name precise enough to explain its purpose?

### Inputs

- Are all runtime values bound as parameters?
- Are parameter names understandable without reading application code?
- Are parameter types documented and narrow enough?
- Are optional parameters truly optional, or should they be required?

### Dynamic Behavior

- Is dynamic SQL limited to filters, allowlisted ordering, paging, and reusable fragments?
- Would a separate static query be simpler than more builder branches?
- Is any identifier-like value being passed from input into SQL syntax? If so, stop and redesign it.

### Query Shape

- Are joins necessary and easy to explain?
- Are filtering conditions placed where a reviewer would expect them?
- Does the query expose accidental duplication, fan-out, or hidden aggregation behavior?
- Is the selected column set intentional rather than `SELECT *` by default?

### Sorting And Paging

- Does runtime sorting use an allowlist?
- Are default sort behavior and tie-breakers clear?
- If paging is used, is the query still deterministic?

### Reviewability

- Can another engineer explain the query by reading only the Markdown definition?
- Are important assumptions or caveats written in the description or nearby documentation?
- If the SQL was suggested by AI, has it been simplified into a human-reviewed final form?

## Builder Guidance

Prefer builder logic when:

- optional filters would otherwise duplicate large static queries
- allowlisted sort keys are needed
- paging clauses are added in a controlled way
- shared query fragments are reused intentionally

Avoid builder logic when:

- the query's main responsibility changes by branch
- table names, column names, or operators would come from input
- the builder becomes harder to review than two or three explicit SQL IDs

### What Builder Is Meant To Express

In `sql-registry`, builder logic is not a mechanism for free-form SQL generation.
Treat it as a way to express reviewable structural variation while keeping static SQL as the baseline.

In actual definitions, the base SQL places slot markers such as `/*#where*/` or `/*#page*/`,
and a
````md
```js builder
...
```
````
block applies changes into those slots.

Builder is mainly intended to express changes such as:

- adding `where` conditions for optional filters
- switching `order by` through an allowlist
- adding paging clauses such as `limit` and `offset`
- inserting explicitly managed shared fragments

### Recommended Boundary For Builder Operations

As a public design standard, prefer builder usage for:

- adding conditions or support clauses through `append(slot, sql, params)`
- conditional additions through `appendIf(...)`
- inserting fragment queries through `appendQuery(slot, queryName, params)`
- switching ordering through `orderBy(slot, columnKey, asc)` with an allowlist
- adding paging clauses through `limit(slot, value)` and `offset(slot, value)`
- declaring internally generated params through `param({...})`
- composing `SET` clauses through `set(sql, params)` / `setIf(...)`

Even with builder logic, these properties should remain true:

- the responsibility of the overall SQL can still be explained
- it is traceable which inputs trigger which structural changes
- the rendered result stays reviewable by a human

### What Builder Should Not Express

As a public design standard, do not encourage builder usage for:

- freely switching table names or column names
- free operator injection
- arbitrary SQL string concatenation
- large responsibility changes that make each branch a materially different query
- designs that assemble SQL syntax directly from input

When these needs appear, prefer splitting into separate static SQL IDs rather than extending builder scope.

### Information To Keep In Markdown For Builder-Based Definitions

For SQL definitions that use builder logic, keep at least the following information in Markdown:

- where the slot markers exist in the base SQL
- which parameters enable which branches
- the range of conditions, sorting, and paging that may be added
- default ordering and when it applies
- the role of any referenced fragments
- how far the dynamic scope is intentionally constrained

In other words, do not hide builder behavior only in code.
Make it traceable from the definition document.

### Builder Block Constraints

The current builder block implementation is not a general JavaScript runtime.
Write against these constraints in the design standard:

- use fenced blocks as ```` ```js builder ```` or ```` ```ts builder ````
- do not use loops
- keep `if` nesting shallow
- pass SQL literals, query names, and slot names as static literals to helper calls
- restrict `appendQuery` to existing registry queries that can be resolved
- use only keys declared in `orderable:` with `orderBy`
- keep SQL literals passed to `append` or `set` as single statements

### Builder Example

```md
## query.users.search

description: Search users with controlled optional filters
param: tenantId:string - Tenant ID
param: status:string - User status
param: limitNum:integer - Page size
param: offsetNum:integer - Page offset
orderable:
  createdAt: u.created_at
  displayName: u.display_name

```sql
SELECT
  u.id,
  u.display_name,
  u.status,
  u.created_at
FROM users u
WHERE u.tenant_id = :tenantId
/*#where*/
ORDER BY u.created_at DESC, u.id DESC
/*#page*/
```

```js builder
if (params.status) {
  append('where', 'AND u.status = :status', {
    status: params.status
  });
}

limit('page', params.limitNum);
offset('page', params.offsetNum);
```
```

### Review Points For Builder Usage

- is builder being used only for minimal structural variation rather than as a replacement for static SQL
- is the mapping between branch conditions and SQL changes explicit in Markdown
- are allowlist and slot boundaries still clear
- has builder usage made responsibility or reviewability worse rather than better

## Definition Format Standard

Markdown SQL definitions should use the same skeleton for both static and dynamic SQL.
Prefer this section order at minimum:

- SQL ID heading
- `description:`
- `param:`
- `tags:` or `orderable:` when needed
- SQL

The current implementation interprets `description:` and `param:` as structured metadata.
Keep assumptions, dialect notes, NULL handling, and operating caveats either in descriptive text or in nearby documentation.

### When To Choose Static SQL

Choose static SQL first when:

- one clear responsibility fits without branching
- optional conditions are few and do not justify builder logic
- sorting and paging are fixed
- the query is valuable precisely because it is directly readable

### When To Choose Dynamic SQL

Use controlled dynamic SQL only when:

- optional filters would otherwise cause large duplicated static queries
- sort keys must switch through an allowlist
- paging clauses or shared fragments need limited structural variation
- the SQL ID still keeps one main responsibility

### Static SQL Template

Write static SQL as a definition whose SQL syntax does not change at runtime.

```md
## query.users.find_by_id

description: Fetch one user by user ID
param: userId:bigint - User ID

```sql
select
  u.id,
  u.email,
  u.display_name,
  u.created_at
from users u
where u.id = :userId
```
```

For static SQL, keep these rules:

- if sorting or paging is fixed, write it directly in the SQL body
- do not introduce dynamic slot markers or builder blocks unless they are actually needed
- if branching starts to grow, consider splitting SQL IDs before introducing dynamic logic
- keep `param:` declarations aligned with named parameters in SQL

### Dynamic SQL Template

Write dynamic SQL so the relationship between the base SQL and the builder block is visible in Markdown.

```md
## query.users.search

description: Search users with controlled optional filters
param: tenantId:string - Tenant ID
param: nameKeyword:string - Partial display-name keyword
param: status:string - User status
param: limitNum:integer - Page size
param: offsetNum:integer - Page offset
orderable:
  createdAt: u.created_at
  displayName: u.display_name

```sql
select
  u.id,
  u.email,
  u.display_name,
  u.status,
  u.created_at
from users u
where u.tenant_id = :tenantId
/*#where*/
order by u.created_at desc, u.id desc
/*#page*/
```

```js builder
if (params.nameKeyword) {
  append('where', 'AND u.display_name LIKE :nameKeyword', {
    nameKeyword: params.nameKeyword
  });
}

if (params.status) {
  append('where', 'AND u.status = :status', {
    status: params.status
  });
}

limit('page', params.limitNum);
offset('page', params.offsetNum);
```
```

For dynamic SQL, keep these rules:

- keep slot marker names aligned between the base SQL and the builder block
- make dynamic behavior traceable across `param:`, `orderable:`, and the builder block
- limit changeable parts to values, approved sorting, and constrained clause insertion
- never allow free input for table names, column names, operators, or arbitrary fragments
- if branching blurs the main responsibility, split SQL IDs instead of growing dynamic logic

### Review Points When Using Templates

Even with templates, a human reviewer must still check:

- whether the SQL ID name explains the responsibility
- whether `param:` declarations match actual SQL and builder usage
- whether slot marker locations and builder operations still correspond
- whether dynamic scope is quietly expanding behind the template

## File Structure And Import Guidance

Do not keep growing SQL Markdown into one oversized file.
Split definitions into reviewable units so added SQL does not make responsibility boundaries and diffs harder to follow.

### Default Structure

- use `index.md` as the root entrypoint
- split into subfolders by feature or table when needed
- if a subfolder exists, place an `index.md` inside it as well
- import child `index.md` files from the parent `index.md`, then import leaf `md` files from each child `index.md`

Example structure:

```text
index.md
captures/
  index.md
  search.md
  update.md
users/
  index.md
  find.md
  search.md
fragments/
  index.md
  capture.md
```

### Role Of The Root Index

The root `index.md` should act as the registry entrypoint, not as the place where large amounts of SQL text accumulate.

- express only the top-level grouping
- `@import` child `index.md` files
- keep global explanation or operating notes short

Example:

```md
# Application SQL registry

@import "./captures/index.md" as captures - Capture queries
@import "./users/index.md" as users - User queries
@import "./fragments/index.md" as fragments - Shared SQL fragments
```

### Role Of A Subfolder Index

A subfolder `index.md` should be a thin table of contents for one responsibility area.

- group only SQL definitions from the same responsibility area
- `@import` leaf `md` files from the same folder
- add a short area-specific explanation only when it helps review

Example:

```md
# Capture queries

@import "./search.md" as captures - Capture list and filtering queries
@import "./update.md" as captures - Capture review mutation queries
@import "./summary.md" as captures - Capture dashboard queries
```

### When To Split Files

Split Markdown and use `@import` when:

- one file has grown large enough that manual review becomes hard
- natural responsibility groupings exist, such as search, mutation, or summary queries
- review ownership differs by feature or table area
- shared fragments should be maintained independently

Do not split aggressively when:

- there are still only a few SQL definitions and one file is easier to understand
- folder names would exist without clear responsibility boundaries
- more imports would hide the overall shape rather than clarify it

### Rules For Using Imports

- use `@import` to preserve review units, not to create deep nesting
- choose stable, responsibility-revealing names for `as`
- place shared fragments in an obviously named area such as `fragments`
- align the import structure with feature or table responsibility boundaries
- structure files so it is obvious where to review a given class of SQL

### Structures To Avoid

- placing many direct SQL definitions in the root `index.md`
- continuing to append unrelated SQL into one flat area
- creating import chains so deep that the path from entrypoint to definition becomes hard to follow
- splitting folders by name only, without a meaningful review boundary
- mixing shared fragments and normal queries without distinction

### Review Points For Import Structure

- can a reviewer move naturally from the root `index.md` to the main responsibility areas
- do folder-level groupings match SQL ID responsibilities
- is the location of shared fragments obvious
- does the split reduce file bloat without hiding the system shape

## Suggested Review Output

When reviewing a SQL definition, capture:

- purpose
- key parameters
- dynamic branches
- sorting/paging behavior
- assumptions
- open questions

## AI Review Prompt

Use or adapt the following prompt when asking an AI assistant to review a SQL definition:

```md
Review this SQL definition as a design artifact.

Focus on:
- responsibility and naming
- parameter clarity
- unsafe dynamic SQL risks
- whether builder usage is justified
- sorting/paging correctness
- readability and reviewability

Do not rewrite everything by default.
Point out concrete risks, unnecessary complexity, and missing assumptions.
List open questions separately from confirmed issues.
```

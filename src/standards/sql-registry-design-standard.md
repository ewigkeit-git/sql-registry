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

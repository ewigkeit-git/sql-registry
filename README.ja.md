# sql-registry

SQL を Markdown で資産化して管理するための軽量ライブラリです。

SQL をアプリケーションコードから分離しつつ、パラメータ定義、型、説明、DB 方言ごとの SQL、条件付き SQL 組み立てを 1 つの Markdown registry として扱えます。

## 何が嬉しいのか

アプリケーションコードの中に SQL 文字列が散らばると、次のような問題が起きがちです。

- SQL の一覧性が低い
- パラメータの意味や型がコードを追わないと分からない
- `ORDER BY ${sort}` のような危ない動的 SQL が生まれやすい
- SQLite / PostgreSQL / MySQL の差分が if 文に埋もれる
- SQL のレビューがアプリケーションロジックの差分に混ざる

sql-registry では、SQL を Markdown に寄せます。

````md
## users.search

description: Search users with filters, sorting, and paging.

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

アプリケーション側は SQL ID と params を渡すだけです。

```ts
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

生成される statement:

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
    "AND u.name LIKE ?",
    "AND u.status = ?",
    "ORDER BY u.name ASC",
    "LIMIT ?",
    "OFFSET ?"
  ].join("\n"),
  values: ["%Alice%", "active", 20, 0]
}
```

## 責務の範囲

sql-registry は SQL パーサではありません。

- 構造エラーは `loadFile()` 時点で検出します
- 入力エラーは DB 実行前に検出します
- DB エラーは adapter / driver に任せます
- SQL 構文の正しさは DB / driver に任せます
- `SELECT` が 1 行返すか複数行返すかは SQL の作りに任せます
- adapter は driver の結果を薄く返します
- 1 行だけ欲しい場合は、SQL 側で条件や `LIMIT 1` を設計し、呼び出し側で結果配列の先頭を扱ってください

sql-registry が扱うのは、named parameter の bind、param metadata の検証、builder による安全な SQL 断片追加、dialect 別 SQL の選択です。

構造エラーとは、Markdown registry として成立しないものです。たとえば query 名の重複、import 循環、未定義 query への `appendQuery()`、builder script の parse error、param metadata と SQL / builder の不整合などです。

入力エラーとは、実行時に渡された `params` / `context` / builder helper 引数の問題です。たとえば型不一致、必須 bind param の不足、未知 param、未許可の `orderBy` key、`limit()` / `offset()` の範囲外値などです。

DB エラーとは、SQL 構文エラー、制約違反、接続エラー、ロック、タイムアウト、権限エラーなど DB / driver が判断するものです。sql-registry はこれらを SQL パースで事前判定せず、adapter が driver のエラーをそのまま扱います。

SQL は読みやすい Markdown に残り、実行時入力は bind values と allowlist に閉じ込められます。

## ORM と共存できる

sql-registry は ORM を置き換えるためのライブラリではありません。

普段の CRUD や単純な関連取得は、Prisma、Sequelize、TypeORM、Drizzle など既存の ORM / query builder に任せたままで構いません。

一方で、実務では次のような SQL が出てきます。

- レポート用の複雑な集計 SQL
- パフォーマンス調整された手書き SQL
- CTE や window function を使う検索
- DB 方言ごとに最適化した SQL
- SQL 単体でレビュー・管理したい業務クエリ
- ORM の抽象化に乗せるとかえって読みにくくなるクエリ

sql-registry は、そのような SQL を Markdown registry として管理し、既存の ORM と並べて使うための道具です。

```js
// 普段の単純な取得は ORM
const user = await prisma.user.findUnique({
  where: {
    id: userId
  }
});

// 複雑な検索やレポートは sql-registry
const stmt = registry.builder("reports.monthlySales", {
  params: {
    from,
    to,
    region
  }
}).build();

const rows = await prisma.$queryRawUnsafe(stmt.sql, ...stmt.values);
```

この例では、sql-registry が生成した SQL と bind values を渡すために `$queryRawUnsafe` を使っています。ユーザー入力を SQL 文字列へ連結する用途では使わないでください。

Sequelize を使っている場合は adapter 経由で実行できます。

```js
const adapter = new SequelizeAdapter(sequelize, registry);

const rows = await adapter.query("reports.monthlySales", {
  params: {
    from,
    to,
    region
  }
});
```

既存の ORM を活かしながら、手書き SQL だけを見通しよく管理できます。

## フォルダ分けと import で SQL 資産を管理する

SQL が増えてきたら、1 つの巨大な Markdown にまとめるのではなく、ドメインや用途ごとに分けて管理できます。

例:

```txt
sql/
  registry.md
  fragments/
    user.md
    tenant.md
  users/
    search.md
    mutation.md
  reports/
    monthly-sales.md
    active-users.md
```

エントリポイントになる `registry.md` で各ファイルを import します。

```md
@import "./fragments/user.md" as fragments.user
@import "./fragments/tenant.md" as fragments.tenant
@import "./users/search.md" as users
@import "./users/mutation.md" as users
@import "./reports/monthly-sales.md" as reports
@import "./reports/active-users.md" as reports
```

読み込み側:

```js
const registry = new SqlRegistry({
  dialect: "postgres"
});

registry.loadFile("./sql/registry.md");

const stmt = registry.builder("users.search", {
  params: {
    name: "Alice",
    status: "active"
  },
  context: {
    tenantId: 10
  }
}).build();
```

`users/search.md`:

````md
## search

description: Search users in a tenant.

param: name:string - Partial user name
param: status:string - User status
param: tenantId:int - Tenant ID
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
/*#tenant*/
/*#where*/
/*#order*/
/*#paging*/
```

```ts builder
appendQuery('tenant', 'fragments.tenant.required', {
  tenantId: context.tenantId
});

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

`fragments/tenant.md`:

````md
## required

description: Restrict rows to one tenant.

param: tenantId:int - Tenant ID

```sql
AND tenant_id = :tenantId
```
````

`registry.md` で `@import "./users/search.md" as users` としているので、`users/search.md` 内の `## search` は `users.search` として登録されます。

同じように `@import "./fragments/tenant.md" as fragments.tenant` としているため、`fragments/tenant.md` 内の `## required` は `fragments.tenant.required` として参照できます。

この形にしておくと、SQL を次のように整理できます。

- `fragments/`: 再利用する WHERE 句や JOIN 断片
- `users/`: ユーザー機能の検索・更新 SQL
- `reports/`: レポートや集計 SQL
- `registry.md`: import の入口

SQL の量が増えても、アプリケーションコード側は `registry.loadFile("./sql/registry.md")` のままです。

## `appendQuery` で SQL fragment を再利用する

`appendQuery()` を使うと、別の SQL ID として定義した fragment を slot に追加できます。

tenant 条件、権限制御、共通 JOIN、よく使う WHERE 句、サブクエリなどを再利用したいときに便利です。

`fragments/user.md`:

````md
## active

description: Restrict to active users.

param: active:bool - Active flag

```sql
AND u.active = :active
```

## notDeleted

description: Exclude deleted users.

```sql
AND u.deleted = 0
```
````

`users/search.md`:

````md
## searchActive

param: active:bool - Active flag
param: name:string - Partial user name

```sql
SELECT
  u.id,
  u.name,
  u.active
FROM users u
WHERE 1 = 1
/*#where*/
```

```js builder
appendQuery('where', 'fragments.user.notDeleted');

// 第3引数に object literal を渡すと、fragment 側の named parameter に bind できます。
if (params.active != null) {
  appendQuery('where', 'fragments.user.active', {
    active: params.active
  });
}

if (params.name) {
  append('where', 'AND u.name LIKE :name', {
    name: `%${params.name}%`
  });
}
```
````

`registry.md`:

```md
@import "./fragments/user.md" as fragments.user
@import "./users/search.md" as users
```

実行:

```js
const stmt = registry.builder("users.searchActive", {
  params: {
    active: true,
    name: "Alice"
  }
}).build();
```

生成される SQL:

```sql
SELECT
  u.id,
  u.name,
  u.active
FROM users u
WHERE 1 = 1
AND u.deleted = 0
AND u.active = ?
AND u.name LIKE ?
```

```js
stmt.values;
// [true, "%Alice%"]
```

`appendQuery()` で追加される fragment も通常の SQL と同じく named parameter を持てます。bind values は呼び出し側で渡した object literal から生成されます。

### サブクエリを部品化する

`appendQuery()` は WHERE 句だけでなく、サブクエリの差し込みにも使えます。

`fragments/orders.md`:

````md
## latestByUser

description: Latest order per user.

```sql
LEFT JOIN (
  SELECT
    user_id,
    MAX(created_at) AS latest_order_at
  FROM orders
  GROUP BY user_id
) latest_order ON latest_order.user_id = u.id
```
````

`users/search-with-order.md`:

````md
## searchWithLatestOrder

param: status:string - User status

```sql
SELECT
  u.id,
  u.name,
  latest_order.latest_order_at
FROM users u
/*#join*/
WHERE u.deleted = 0
/*#where*/
```

```js builder
appendQuery('join', 'fragments.orders.latestByUser');

if (params.status) {
  append('where', 'AND u.status = :status', {
    status: params.status
  });
}
```
````

`registry.md`:

```md
@import "./fragments/orders.md" as fragments.orders
@import "./users/search-with-order.md" as users
```

このように、複雑な JOIN やサブクエリを部品として分け、必要な query から再利用できます。

## 特徴

- Markdown で SQL registry を管理
- `param:` に説明と型を記述
- 実行時 params の型検証
- SQLite / PostgreSQL / MySQL 向けの dialect 別 SQL
- `js builder` / `ts builder` による条件付き SQL 組み立て
- named parameter `:id` を dialect に応じた positional bind (`?` / `$1`) に変換
- `ORDER BY` を `orderable` allowlist で制御
- `limit` / `offset` の数値化と上限チェック
- 未定義 param / 未定義 slot を検出
- `EXPLAIN` statement の生成
- better-sqlite3 / node:sqlite / MariaDB / Sequelize adapter
- 既存 ORM / query builder と併用しやすい
- TypeScript 対応

## Before / After

よくある危ない書き方:

```js
const sql = `
  SELECT *
  FROM users
  WHERE deleted = 0
  ${name ? `AND name LIKE '%${name}%'` : ""}
  ORDER BY ${sort}
  LIMIT ${limit}
`;
```

sql-registry での書き方:

````md
```sql
SELECT *
FROM users
WHERE deleted = 0
/*#where*/
/*#order*/
/*#paging*/
```

```js builder
if (params.name) {
  append('where', 'AND name LIKE :name', {
    name: `%${params.name}%`
  });
}

orderBy('order', params.sort || 'createdAt');
limit('paging', params.limit);
```
````

違いは、ユーザー入力が SQL 構文へ直接混ざらないことです。

- `name` は bind value
- `sort` は `orderable` にある key のみ
- `limit` は非負整数に変換され、上限チェックされる
- SQL 断片は builder 内の静的文字列のみ

## インストール

```sh
npm install sql-registry
```

## クイックスタート

```js
const { SqlRegistry } = require("sql-registry");

const registry = new SqlRegistry({
  dialect: "sqlite"
});

registry.loadFile("./sql/users.md");

const stmt = registry.bind("users.findById", {
  id: 1
});

console.log(stmt);
// {
//   sql: "SELECT * FROM users WHERE id = ?",
//   values: [1]
// }
```

## Markdown registry

SQL は Markdown の `##` 見出しごとに定義します。

````md
## users.findById - Find one user by ID.

param: id:int - User ID

```sql
SELECT
  id,
  name,
  status,
  created_at
FROM users
WHERE id = :id
```
````

`param:` は次の形式で書けます。

```md
param: name:type - description
```

型は省略できます。

```md
param: id - User ID
param: active:bool - Active flag
param: limit:int - Page size
```

## Param types

対応している型は次の通りです。

- `string` / `text`
- `number` / `float`
- `integer` / `int`
- `boolean` / `bool`
- `date` / `datetime` / `timestamp`
- `json`
- `any`

型が指定されている param は、`bind()` や `builder()` 実行時に検証されます。

```md
param: id:int - User ID
```

```js
registry.bind("users.findById", {
  id: "1"
});
// throws: invalid type for param: id
```

## Dialect 別 SQL

SQL fence に dialect を指定できます。

````md
## users.findById

param: id:int - User ID

```sql
SELECT * FROM users WHERE id = :id
```

```sql postgres
SELECT * FROM app_users WHERE id = :id
```
````

`postgres` / `postgresql` は内部的に `pg` として扱われます。

```js
const registry = new SqlRegistry({
  dialect: "postgresql"
});
```

## Builder

条件付き SQL は `builder` ブロックで組み立てられます。

SQL 側には slot marker を置きます。

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

```js builder
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

実行例:

```js
const stmt = registry.builder("users.search", {
  params: {
    name: "Alice",
    status: "active",
    sort: "name",
    limit: 20,
    offset: 40
  }
}).build();
```

## TypeScript builder

builder ブロックは JavaScript だけでなく TypeScript でも書けます。

````md
```ts builder
const active: boolean = params.active;

if (active) {
  append('where', 'AND active = :active', {
    active
  });
}
```
````

`ts builder` は実行前に JavaScript へ変換され、その後は通常の builder と同じ限定インタプリタで実行されます。

## Builder の安全制約

builder は任意の JavaScript を `eval` する仕組みではありません。

利用できる構文と helper は制限されています。

- `append()` の SQL 断片は文字列リテラルのみ
- `append()` / `appendQuery()` / `set()` の bind params は object literal のみ
- `set()` の SQL 断片は文字列リテラルのみ
- `appendQuery()` の第3引数は省略可能。ただし指定する場合は空 object 不可
- `appendQuery()` の bind params は、参照先 fragment の named parameter に存在する key のみ
- `append()` できる slot は SQL 内に存在する `/*#slot*/` のみ
- `orderBy()` は `orderable` に定義された key のみ
- `limit()` / `offset()` は非負整数のみ
- `limit()` / `offset()` は上限チェックあり
- `limit()` / `offset()` の bind param は slot ごとに内部名を分けるため、複数 slot で衝突しません
- builder 内で読む `params.xxx` は、`param: xxx:type - description` の宣言が必須
- builder 内で生成する値は `param({ generatedValue })` で bind でき、この場合は外部入力ではないため `param:` 宣言は不要
- `for` / `while` / `do while` などの反復処理は不可
- `params.sql` や template literal で SQL 断片を動的生成することは不可
- `process` などの外部 global にはアクセス不可

## Security model

sql-registry では、Markdown registry を信頼済みのソース資産として扱います。

つまり `.md` ファイルはユーザー投稿コンテンツではなく、ソースコードや設計書と同じく、開発者が管理する成果物です。

一方で、実行時に渡される `params` や `context` は外部入力を含みうるものとして扱います。

このライブラリの主な防御対象は、実行時入力が SQL 構文へ混入することです。

そのため、実行時入力は次の経路に制限されます。

- bind values
- slot によって制御された SQL 断片
- `orderable` によって許可された ORDER BY key
- 型検証済み params

Markdown registry が漏れるリスクは SQL injection ではなく、ソースコードや設計書、DB 構造が漏れるリスクとして扱ってください。

## Adapter

### better-sqlite3

```js
const { SqlRegistry, BetterSqlite3Adapter } = require("sql-registry");

const registry = new SqlRegistry();
registry.loadFile("./sql/users.md");

const adapter = new BetterSqlite3Adapter(db, registry);

const rows = await adapter.query("users.search", {
  params: {
    status: "active"
  }
});
```

### node:sqlite

```js
const { DatabaseSync } = require("node:sqlite");
const { SqlRegistry, NodeSqliteAdapter } = require("sql-registry");

const db = new DatabaseSync(":memory:");
const registry = new SqlRegistry();
registry.loadFile("./sql/users.md");

const adapter = new NodeSqliteAdapter(db, registry);

const rows = await adapter.query("users.search", {
  params: {
    status: "active"
  }
});
```

### MariaDB

```js
const mariadb = require("mariadb");
const { SqlRegistry, MariadbAdapter } = require("sql-registry");

const pool = mariadb.createPool({
  host: "localhost",
  user: "app",
  password: "secret",
  database: "app"
});

const registry = new SqlRegistry({
  dialect: "mysql"
});
registry.loadFile("./sql/users.md");

const adapter = new MariadbAdapter(pool, registry);

const rows = await adapter.query("users.search", {
  params: {
    status: "active"
  }
});
```

### Sequelize

```js
const { SqlRegistry, SequelizeAdapter } = require("sql-registry");

const registry = new SqlRegistry({
  dialect: "postgres"
});
registry.loadFile("./sql/users.md");

const adapter = new SequelizeAdapter(sequelize, registry);

const rows = await adapter.query("users.findById", {
  params: {
    id: 1
  }
});
```

`SequelizeAdapter` では `queryOptions.replacements` はライブラリ側が管理します。

## EXPLAIN

組み立てた SQL から `EXPLAIN` 用 statement を生成できます。

```js
const stmt = registry.builder("users.search", {
  params: {
    name: "Alice",
    status: "active",
    sort: "name",
    limit: 20,
    offset: 0
  }
}).buildExplain();
```

PostgreSQL では `analyze: true` を指定できます。

```js
const stmt = registry.builder("users.search", {
  params: {
    name: "Alice"
  }
}).buildExplain({
  analyze: true
});
```

生成例:

```js
{
  sql: "EXPLAIN ANALYZE SELECT ... WHERE u.name LIKE ?",
  values: ["%Alice%"]
}
```

adapter 経由でも実行できます。

```js
const result = await adapter.explain("users.search", {
  params: {
    name: "Alice"
  },
  explainOptions: {
    analyze: true
  }
});
```

SQL registry に登録した query をそのまま `EXPLAIN` できるため、複雑な検索やレポート SQL の実行計画を確認しやすくなります。

## API 概要

### `new SqlRegistry(options)`

```js
const registry = new SqlRegistry({
  strict: true,
  dialect: "sqlite"
});
```

### `registry.loadFile(filePath)`

Markdown registry を読み込みます。

```js
registry.loadFile("./sql/users.md");
```

### `registry.bind(name, params, options)`

SQL ID を指定して bind 済み statement を作ります。

```js
const stmt = registry.bind("users.findById", {
  id: 1
});
```

### `registry.builder(name, options)`

builder script を実行し、動的 SQL を組み立てます。

```js
const builder = registry.builder("users.search", {
  params: {
    name: "Alice"
  },
  context: {
    isAdmin: false
  }
});

const stmt = builder.build();
```

### `builder.buildExplain(options)`

`EXPLAIN` 用 statement を作ります。

```js
const stmt = registry.builder("users.search", {
  params: {
    name: "Alice"
  }
}).buildExplain({
  analyze: true
});
```

## Import

Markdown 内で別ファイルを import できます。

```md
@import "./common.md"
@import "./user.md" as user
```

namespace を指定すると、読み込まれる query 名に prefix が付きます。

```md
@import "./user.md" as user
```

`user.md` 側:

```md
## findById
```

読み込み後:

```txt
user.findById
```

## TypeScript

TypeScript 利用者向けに型定義を同梱しています。

```ts
import { SqlRegistry } from "sql-registry";

const registry = new SqlRegistry({
  dialect: "sqlite"
});
```

## License

MIT

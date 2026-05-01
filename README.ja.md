# sql-registry

Repository: <https://github.com/ewigkeit-git/sql-registry>

> **ステータス:** sql-registry は pre-1.0 です。公開 API、Markdown 形式、アダプターの挙動、ビルダーのヘルパーは今後破壊的に変更される可能性があります。現段階でも利用できますが、導入時はバージョンを固定し、更新時はリリース内容を確認してください。

SQL をアプリケーションコードのあちこちに散らさず、読みやすくレビューしやすい Markdown の資産として管理するための軽量ライブラリです。

sql-registry は、構造化された Markdown に SQL、パラメータ定義、型、説明、データベースごとの方言差分、最小限の動的 SQL をまとめます。

## 利用する理由

実際のアプリケーションでは、SQL が次のような状態になりがちです。

- SQL 文字列がサービスやリポジトリ層に散らばる。
- パラメータの意味や型が SQL から離れてしまう。
- 動的 SQL が文字列連結で増えていく。
- `ORDER BY ${sort}` のような危険な実装が入りやすい。
- SQLite / PostgreSQL / MySQL の違いがアプリケーション側の分岐に埋もれる。
- SQL レビューがアプリケーションロジックのレビューと混ざる。

sql-registry は、SQL を Markdown レジストリにまとめ、クエリ本文、メタデータ、限定的なビルダー処理を同じ場所で扱えるようにします。

## 設計方針

sql-registry は、SQL を生成コードではなく、レビュー可能な静的資産として扱います。

アプリケーション側の入力は、SQL 構文そのものではなく、バインド値、許可リスト済みの並び替えキー、検証されたページング値として渡されます。SQL の構造は Markdown レジストリに残し、実行時に変わる部分は明示的に制限します。

このライブラリが担当するのは、named parameter の bind、パラメータ定義の検証、方言別 SQL の選択、限定された SQL 断片の追加です。SQL 構文の最終的な正しさ、制約違反、ロック、タイムアウト、権限エラーなどはデータベースとドライバーの責務として扱います。

ORM を置き換えるものではありません。通常の CRUD や単純な関連取得は Prisma、Sequelize、TypeORM、Drizzle などに任せ、複雑な集計、レポート、性能調整された手書き SQL、方言ごとに最適化した SQL を sql-registry で管理する、という使い分けを想定しています。

## インストール

```sh
npm install sql-registry
```

## 基本例

`sql/users.md` のようなレジストリファイルを作成します。

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

アプリケーション側では SQL ID とパラメータを渡します。

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

PostgreSQL 方言では、次のように番号付きプレースホルダーが生成されます。

```js
{
  sql: "SELECT ... WHERE u.deleted = 0\nAND u.name LIKE $1\nAND u.status = $2\nORDER BY u.name ASC\nLIMIT $3\nOFFSET $4",
  values: ["%Alice%", "active", 20, 0]
}
```

## 静的 SQL

builder が不要なクエリは `bind()` で組み立てられます。

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

## Markdown 形式

クエリは `##` 見出しで定義します。

```md
## query.name - Optional description
```

主なメタデータ:

- `description: ...`
- `tags: reporting, users`
- `param: name:type - Description`
- `orderable:` による `ORDER BY` の許可リスト
- `sql` のフェンス付きコードブロック
- `ts builder` / `js builder` のフェンス付きコードブロック

方言別 SQL も書けます。

````md
```sql pg
SELECT * FROM users WHERE id = :id
```

```sql mysql
SELECT * FROM users WHERE id = :id
```
````

対応する方言エイリアスは `sqlite`, `sqlite3`, `mysql`, `mysql2`, `pg`, `postgres`, `postgresql` です。

## ビルダーとスロット

スロットマーカーは、ビルダーが SQL 断片を差し込める場所を表します。

```sql
SELECT * FROM users
/*#where*/
/*#order*/
/*#paging*/
```

主なヘルパー:

- `append(slotName, sql, params)`
- `appendIf(slotName, condition, sql, params)`
- `appendQuery(slotName, queryName, params)`
- `appendQueryIf(slotName, condition, queryName, params)`
- `at(slotName).append(...)`
- `set(sql, params)` / `setIf(...)`
- `orderBy(slotName, key, asc)`
- `limit(slotName, value)`
- `offset(slotName, value)`

`where` スロットは `AND ...` から始まる断片を扱えます。スロットより前にトップレベルの `WHERE` がない場合、最初の断片は `WHERE ...` として生成されます。

## 安全性の考え方

sql-registry は、ユーザー入力を SQL 構文に直接連結しない設計です。

実行時入力が影響できる範囲:

- バインド値
- 宣言済みかつ型検証されたパラメータ
- 許可リストに含まれる `ORDER BY` key
- 検証された `LIMIT` / `OFFSET`
- レジストリに静的文字列として書かれた SQL 断片

builder script は、汎用的な JavaScript 実行環境ではありません。

許可されるもの:

- `if` 文
- 単純な式
- `const` / `let`
- `params` / `context` の参照
- sql-registry の builder helper

拒否されるもの:

- ループ
- 任意の関数呼び出し
- 動的な helper 名
- computed helper method
- 動的に組み立てた SQL 断片
- `process` などのグローバル参照
- 深い制御構造

## CLI

レジストリファイルは CLI で検証できます。

```sh
npx sql-registry validate ./sql
npx sql-registry validate --dialect pg ./sql
npx sql-registry validate --json ./sql
```

重複したクエリ名、未宣言パラメータ、不正な builder script、未知の `appendQuery()` 参照などを検出します。

## import

Markdown レジストリから別ファイルを import できます。

```md
@import "./fragments/user.md" as fragments.user
@import "./users/search.md" as users
@import "./reports/monthly-sales.md" as reports
```

import されたファイル内の見出しには namespace が付きます。たとえば `./users/search.md` の `## search` は `users.search` になります。

## アダプター

アダプターは実行用の SQL 文を組み立て、ドライバーや ORM に渡します。トランザクションの開始、commit、rollback は行いません。必要な場合はドライバー / ORM 側でトランザクションを管理し、そのトランザクションに紐づいた executor をアダプターに渡してください。

| 対象 | アダプター |
| --- | --- |
| better-sqlite3 | `BetterSqlite3Adapter` |
| node:sqlite | `NodeSqliteAdapter` |
| node-postgres | `PgAdapter` |
| mysql2 | `Mysql2Adapter` |
| MariaDB | `MariadbAdapter` |
| Sequelize | `SequelizeAdapter` |
| TypeORM | `TypeOrmAdapter` |

node-postgres の例:

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

トランザクション用の client を明示的に渡すこともできます。

```js
const adapter = new PgAdapter(registry);
const result = await adapter.query(client, "users.search", {
  params: {
    name: "Alice",
    sort: "createdAt",
    limit: 20,
    offset: 0
  }
});
```

## EXPLAIN

`buildExplain()` で EXPLAIN 用の statement を生成できます。

```js
const stmt = registry.builder("users.search", {
  params: {
    sort: "createdAt",
    limit: 20
  }
}).buildExplain({ analyze: false });
```

アダプターからも、対応している executor に対して `explain(...)` を呼べます。

## 対象外のこと

sql-registry は、次の役割を担うためのものではありません。

- ORM
- 汎用クエリビルダー
- SQL パーサー
- マイグレーションツール
- それ単体でデータベースアクセスを保護する境界

既存のドライバー、ORM、query builder と併用しながら、明示的に管理したい SQL をレジストリとして扱うための小さなライブラリです。

## プロジェクト状態

- 現在の package version: `0.3.0`
- 実行形式: TypeScript 型定義付きの CommonJS package
- License: MIT
- API 安定性: pre-1.0 のため、破壊的変更が入る可能性があります

English: [README.md](https://github.com/ewigkeit-git/sql-registry/blob/main/README.md)

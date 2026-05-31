# sql-registry設計標準

この文書は、`sql-registry` で書く SQL や、その周辺で扱う SQL をレビューするための軽量な標準です。

SQL を実装の断片ではなく、設計意図を読み取れる成果物として人と AI が一緒に見直せるようにすることを目的としています。

## 対象範囲

次のような場面で使います。

- 新しい SQL ID を定義するとき
- フィルタ、ソート、ページング、JOIN 構成を変更するとき
- ORM の外に手書き SQL を追加するとき
- 静的 SQL のままにするか builder に寄せるかを検討するとき

この標準は、テーブル設計、マイグレーション方針、DBMS 固有の型標準までは定義しません。

## 設計原則

1. 1つの SQL ID には 1つの明確な責務を持たせる
2. 実行時入力を SQL 構文に直接入れない
3. 生成された SQL より、レビューしやすい静的 SQL を優先する
4. builder は制御された構造変化のためにだけ使う
5. パラメータの意図を SQL の近くに明示する
6. 方言差分は見える場所に閉じ込める

## チェックリスト

各 SQL 定義は次の観点で見直します。

### 責務

- この SQL ID は 1つの役割に集中しているか
- 多数の分岐を増やすより、別の SQL ID に分けたほうが自然ではないか
- SQL 名だけで目的がある程度伝わるか

### 入力

- 実行時の値はすべて bind パラメータとして渡されているか
- パラメータ名はアプリ側コードを見なくても意味が分かるか
- パラメータ型は十分に明示され、広すぎないか
- optional なパラメータは本当に optional か

### 動的SQL

- 動的 SQL はフィルタ、許可済みソート、ページング、再利用断片に限定されているか
- builder の分岐を増やすより、静的 SQL を分けたほうが簡単ではないか
- テーブル名、カラム名、演算子のような識別子に近い値が入力から SQL 構文へ入っていないか

### クエリ構造

- JOIN は必要で、説明しやすい形か
- フィルタ条件はレビュー時に追いやすい場所に置かれているか
- 意図しない重複、fan-out、隠れた集計が起きる形になっていないか
- `SELECT *` に流れず、取得列が意図的に選ばれているか

### ソートとページング

- 実行時ソートは allowlist で制御されているか
- デフォルトソートと tie-breaker は明確か
- ページングを使う場合でも結果順は決定的か

### レビューしやすさ

- Markdown 定義だけ読んで別の開発者が意図を説明できるか
- 重要な前提や注意点が description や周辺文書に残っているか
- AI が提案した SQL なら、人が読んで整理した最終形に落ちているか

## Builder 利用指針

次のような場合は builder が向いています。

- optional フィルタのために大きな静的 SQL が重複してしまう
- allowlist 付きソートが必要
- ページング句を制御された形で追加したい
- 共通断片を意図的に再利用したい

次のような場合は builder を避けます。

- 分岐ごとにクエリの主責務が変わる
- テーブル名、カラム名、演算子を入力から決めたくなる
- builder のほうが、2〜3個の明示的な SQL ID より読みにくくなる

### Builder が表現するもの

`sql-registry` における builder は、SQL を自由生成するための仕組みではなく、
静的 SQL を基準にしながら、レビュー可能な範囲で構造変化を表現するための仕組みとして扱います。

実際の定義では、ベース SQL に `/*#where*/` や `/*#page*/` のような slot marker を置き、
````md
```js builder
...
```
````
の builder block から、その slot へ句を追加します。

builder が主に表現するのは次のような変化です。

- optional フィルタによる `where` 条件の追加
- allowlist に基づく `order by` の切り替え
- `limit` `offset` などページング句の追加
- 明示的に管理された共有 fragment の差し込み

### Builder で推奨する操作の境界

公開標準としては、builder は次のような用途で使うことを推奨します。

- `append(slot, sql, params)` による条件句や補助句の追加
- `appendIf(...)` による条件付き追加
- `appendQuery(slot, queryName, params)` による fragment クエリの差し込み
- `orderBy(slot, columnKey, asc)` による allowlist ベースの並び替え
- `limit(slot, value)` と `offset(slot, value)` によるページング句追加
- `param({...})` による内部利用パラメータの明示
- `set(sql, params)` / `setIf(...)` による `SET` 句の組み立て

builder を使っても、次の性質は保たれている必要があります。

- SQL 全体の責務が説明できる
- どの入力がどの構造変化を起こすか追跡できる
- 生成結果を人間がレビュー可能な形に保てる

### Builder で表現すべきでないもの

公開標準として、builder で次を表現することは推奨しません。

- テーブル名やカラム名の自由な切り替え
- 演算子の自由注入
- 任意 SQL 断片の文字列連結
- 分岐ごとに別物のクエリになる大きな責務変化
- 入力から直接 SQL 構文を組み立てる設計

この種の要求が出た場合は、builder を拡張するより、別の静的 SQL ID へ分割することを優先します。

### Builder を使う定義で Markdown に残す情報

builder を使う SQL 定義では、少なくとも次の情報を Markdown に残します。

- ベース SQL のどこに slot marker があるか
- どのパラメータがどの分岐を有効化するか
- 追加される条件、ソート、ページングの範囲
- デフォルトの並び順や適用条件
- 利用する fragment の役割
- 可変部分がどこまでに制限されているか

つまり、builder のロジックはコードだけに閉じ込めず、定義文書から追えるようにします。

### Builder block の制約

現行実装の builder block は、自由な JavaScript 実行環境ではありません。
設計標準としては、次の前提で書きます。

- fenced block は ```` ```js builder ```` または ```` ```ts builder ```` を使う
- ループは使わない
- `if` のネストは浅く保つ
- helper 呼び出しの引数に使う SQL や query 名、slot 名は静的リテラルで書く
- `appendQuery` で参照する query は、レジストリ内で解決可能な既存 query に限る
- `orderBy` は `orderable:` で宣言したキーだけを使う
- `append` / `set` に渡す SQL は単一文に限る

### Builder 記述例

```md
## query.users.search

description: 条件付きでユーザー一覧を検索する
param: tenantId:string - テナント ID
param: status:string - ステータス
param: limitNum:integer - 取得件数
param: offsetNum:integer - 取得開始位置
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

### Builder 利用時のレビュー観点

- builder は静的 SQL の代替ではなく、必要最小限の構造変化に留まっているか
- 分岐条件と SQL 変化の対応が Markdown 上で明示されているか
- allowlist や slot の境界が曖昧になっていないか
- builder の導入で、かえって責務やレビュー性が悪化していないか

## 定義フォーマット標準

SQL 定義の Markdown は、静的 SQL と動的 SQL のどちらでも同じ骨格を持たせます。
少なくとも次の要素を同じ順序で書くことを推奨します。

- SQL ID 見出し
- `description:`
- `param:`
- `tags:` や `orderable:` があれば続ける
- SQL

現行実装は `description:` と `param:` を構造化メタデータとして解釈します。
前提、方言差分、NULL の扱い、運用上の注意点などは、`description:` の補足文として残すか、周辺文書で明示します。

### 静的SQLを選ぶ基準

次の条件に当てはまる場合は、まず静的 SQL を選びます。

- 条件分岐なしで 1 つの明確な責務を表現できる
- optional 条件が少なく、無理に builder にする必要がない
- 並び順やページングが固定である
- SQL をそのまま読めること自体に価値がある

### 動的SQLを選ぶ基準

次の条件に当てはまる場合だけ、制御された動的 SQL を使います。

- optional フィルタにより静的 SQL の重複が大きくなる
- ソートキーを allowlist で切り替える必要がある
- ページング句や共通断片を限定的に組み替えたい
- それでも SQL ID の主責務は 1 つに保てる

### 静的SQLテンプレート

静的 SQL は、実行時に SQL 構文を変えない定義として書きます。

```md
## query.users.find_by_id

description: ユーザー ID で 1 件取得する
param: userId:bigint - ユーザー ID

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

静的 SQL では次を守ります。

- ソートやページングが固定なら SQL 本文にそのまま書く
- 動的 slot marker や builder block を不要に持ち込まない
- 同じ責務で分岐が増えそうなら、先に SQL ID 分割を検討する
- `param:` 宣言と SQL 中の named parameter を一致させる

### 動的SQLテンプレート

動的 SQL は、ベース SQL と builder block の対応が Markdown 上で見えるように書きます。

```md
## query.users.search

description: 条件付きでユーザー一覧を検索する
param: tenantId:string - テナント ID
param: nameKeyword:string - 表示名の部分一致キーワード
param: status:string - ステータス
param: limitNum:integer - 取得件数
param: offsetNum:integer - 取得開始位置
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

動的 SQL では次を守ります。

- slot marker 名はベース SQL と builder の両方で一致させる
- 動的要素は `param:`、`orderable:`、builder block の三箇所で追えるようにする
- 変更可能なのは値、許可済みソート、限定された句追加にとどめる
- テーブル名、カラム名、演算子、任意断片の自由入力は許可しない
- 分岐が増えて主責務が揺れるなら、動的 SQL ではなく SQL ID を分割する

### テンプレート利用時のレビュー観点

テンプレートを使っていても、次の点は必ず人間が確認します。

- SQL ID 名だけで責務が伝わるか
- `param:` と SQL / builder の参照が矛盾していないか
- slot marker の位置と builder の操作が対応しているか
- 動的 SQL の可変範囲がテンプレートを口実に広がっていないか

## ファイル構成と import 指針

SQL 定義の Markdown は、1 ファイルに集約しすぎず、レビューしやすい単位で分割します。
目的は、SQL 定義の追加に伴って 1 つの Markdown が肥大化し、責務や変更差分が追いにくくなることを防ぐことです。

### 基本構成

- ルート入口は `index.md` とする
- 機能単位またはテーブル単位で、必要に応じてサブフォルダへ分ける
- サブフォルダを作る場合、その配下にも `index.md` を置く
- 親の `index.md` から子の `index.md` を `@import` し、子の `index.md` から同階層の個別 `md` を `@import` する

構成イメージ:

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

### ルート index の役割

ルートの `index.md` は、SQL 本文を大量に持つ場所ではなく、レジストリ全体の入口として使います。

- 上位のグルーピングだけを表現する
- 子フォルダの `index.md` を `@import` する
- 全体説明や運用メモが必要なら短く保つ

例:

```md
# Application SQL registry

@import "./captures/index.md" as captures - Capture queries
@import "./users/index.md" as users - User queries
@import "./fragments/index.md" as fragments - Shared SQL fragments
```

### サブフォルダ index の役割

サブフォルダの `index.md` は、その単位の SQL 群を束ねる薄い目次として使います。

- 同じ責務領域の SQL 定義だけを束ねる
- 同フォルダ内の個別 `md` を `@import` する
- 必要なら、その領域だけの短い説明を書く

例:

```md
# Capture queries

@import "./search.md" as captures - Capture list and filtering queries
@import "./update.md" as captures - Capture review mutation queries
@import "./summary.md" as captures - Capture dashboard queries
```

### 分割基準

次のような場合は、Markdown を分割して `@import` を使います。

- 1 ファイルの SQL 定義数が増え、目視レビューで追いにくくなった
- 検索系、更新系、集計系などで責務のまとまりが見えている
- テーブル単位や機能単位で変更担当やレビュー観点が分かれる
- 共有断片を独立して管理したい

逆に、次のような場合は無理に分割しません。

- SQL 定義がまだ少なく、1 ファイルのほうが文脈を追いやすい
- 分割しても名前空間や責務の境界が曖昧なまま
- import を増やすことで、かえって全体像が見えにくくなる

### import 利用時のルール

- `@import` はレビュー単位を保つために使い、深すぎるネストを作らない
- `as` には責務が分かる安定した名前を使う
- 共有断片は `fragments` のように用途が分かる場所へ寄せる
- import 構造は、機能やテーブルの責務境界と一致させる
- 単なるファイル分割ではなく、「どこを見ればその責務の SQL がまとまっているか」が伝わる構成にする

### 避ける構成

- ルート `index.md` に大量の SQL 定義を直接並べる
- サブフォルダを切らずに責務の異なる SQL を雑多に追加し続ける
- `@import` の階層を深くしすぎて、入口から定義までの経路が長くなる
- 名前だけのフォルダ分割で、責務やレビュー観点のまとまりがない
- 共有断片と通常クエリを区別せず同列に増やす

### import 構成のレビュー観点

- ルート `index.md` から主要な責務単位へ自然に辿れるか
- サブフォルダ単位のまとまりが SQL ID の責務と一致しているか
- 共有断片の置き場が分かりやすいか
- 分割によって肥大化を抑えつつ、全体像も見失っていないか

## 推奨レビュー出力

SQL 定義をレビューするときは、少なくとも次を残します。

- 目的
- 主要パラメータ
- 動的分岐
- ソート/ページングの挙動
- 前提
- 未解決の確認事項

## AIレビュー用プロンプト

AI に SQL 定義をレビューさせるときは、次のプロンプトをそのまま使うか調整して使います。

```md
この SQL 定義を、実装断片ではなく設計成果物としてレビューしてください。

次の観点を重視してください。
- 責務と命名
- パラメータの明確さ
- 危険な動的 SQL の有無
- builder 利用の妥当性
- ソート/ページングの正しさ
- 読みやすさとレビューしやすさ

原則として全面書き換えはしないでください。
具体的なリスク、不要な複雑さ、欠けている前提を指摘してください。
未確定事項は、確定した問題点とは分けて列挙してください。
```

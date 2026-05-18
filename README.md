# LesaPay (レサペイ)

家庭内報酬管理アプリ。子どもが日々の目標を達成 → スマホから完了報告 → 親が承認 → ポイントが貯まる → 親がポイントを使う（お小遣い化など）一連の流れを、Cloudflare Workers + Google スプレッドシートで運用します。

**1端末1人運用**: 1つのスプレッドシートを家族で共用し、子ごとにシートを分けます。各端末は自分のシート名だけを覚えていて、その分のデータしか触れません。GitHubに置くコードには個人情報は一切含まれません。

## 構成

```
lesa-pay/
├── server/                # Cloudflare Worker (TypeScript, API)
│   ├── index.ts           # ルーティング (/api 以外は静的アセットへ)
│   ├── actions.ts         # アクションテーブル + ハンドラ
│   ├── api.ts             # Sheets API v4 + Google OAuth (JWT)
│   ├── config.ts          # 環境変数 (wrangler secret) → Config
│   ├── schema.ts          # 課題/履歴シートのスキーマ
│   ├── messages.ts        # サーバから返す文言
│   ├── notify.ts          # LINE Messaging API
│   ├── env.ts             # Worker bindings
│   └── util.ts
├── client/                # フロント一式 (Worker が同オリジンで配信)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── config.js      # localStorage キー定義のみ (個人情報なし)
│       ├── strings.js     # 画面文言 (i18n)
│       └── app.js         # アプリ本体
└── wrangler.jsonc         # Worker 設定 (静的アセットバインディング含む)
```

API と SPA を同じ Worker (同一オリジン) で配信するため、フロントは `/api` を相対パスで叩くだけ。サーバURLの初期セットアップ画面はありません。

設定値はすべて `wrangler secret` で管理します。スプレッドシートはユーザデータ (課題と履歴) 専用で、設定シートはありません。

## セットアップ

### 0. Cloudflare アカウントと wrangler

[Cloudflare](https://dash.cloudflare.com/sign-up) で無料アカウントを作成し、ローカルから wrangler でログインします。

```bash
npx wrangler login   # ブラウザが開いて Cloudflare 認証
```

以降の `wrangler secret put` / `wrangler deploy` はこの認証情報を使います。

### 1. スプレッドシート作成（家族で1つ）

1. 新しい Google スプレッドシートを作成（例: `LesaPay`）
2. シートID（URL の `/d/` と `/edit` の間）を控える
3. 子ごとに `Tasks_<子の名前>` と `History_<子の名前>` の2シート(タブ)を作る — タブ名の大文字小文字は完全一致が必要です (例: `Tasks_Light`, `History_Light`)

#### 課題シート (`Tasks_<子の名前>`)

A列から順に **ID / ステータス / 分類 / タスク名 / 提出報酬 / 完了報酬 / 時間(分) / 期限** の8列。1行目のヘッダ文字列は自由 (コードは1行目を読まずに2行目以降をデータとして扱います)。日本語のままでも英語でも構いません。

| 列 | 内容 | 空欄でOK? |
|----|----|----|
| A | ID | ✅ (初回読み込みで `T<unix>_<rand>` 自動採番) |
| B | ステータス (`Pending` / `Applied` / `Rejected` / `Approved`) | ✅ (空 = `Pending`) |
| C | 分類 — 同じ値を持つ課題どうしを画面上でグループ化する見出し (例: `お手伝い`, `運動`) | ✅ (空 = `その他` 扱い) |
| D | タスク名 | ❌ 必須 |
| E | 提出報酬 (申請時に1回だけ加算) | ✅ (0扱い) |
| F | 完了報酬 (親の承認時に加算) | ✅ (0扱い) |
| G | 時間(分) — 表示のみ | ✅ |
| H | 期限 `YYYY/MM/DD` | ✅ (空 = 無期限) |

#### 履歴シート (`History_<子の名前>`)

A列から順に **日時 / 内容 / ポイント** の3列。1行目のヘッダ文字列は自由。アプリ側が自動で書き込みます。手書きで足したい場合は同じ列構成に揃えてください。

### 2. Google Cloud Service Account を発行

Worker は Sheets API v4 を Service Account で叩きます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成 (既存でも可)
2. **APIとサービス → ライブラリ** で「Google Sheets API」を有効化
3. **IAMと管理 → サービスアカウント** で新規作成 → キーを追加 → JSON をダウンロード
4. JSON 内の `client_email` をコピーして、対象スプレッドシートを **その Service Account メールアドレスに「編集者」で共有**

### 3. Cloudflare Worker をデプロイ

`wrangler.jsonc` の `"name"` を自分が使いたい Worker 名に変更します (デフォルトは `lesapay`)。これがそのままデプロイURLのサブドメインになります (例: `"happy-coins"` → `https://happy-coins.<account>.workers.dev/`)。

```bash
npm install

# シークレット登録 (一度だけ)
npx wrangler secret put GOOGLE_CLIENT_EMAIL   # Service Account の client_email
npx wrangler secret put GOOGLE_PRIVATE_KEY    # Service Account JSON の private_key (-----BEGIN/END PRIVATE KEY----- 含む)
npx wrangler secret put SHEET_ID              # 対象スプレッドシートID
npx wrangler secret put ACCESS_TOKEN          # 招待トークン (例: `openssl rand -hex 16` の32文字hex)
npx wrangler secret put PARENT_PASSWORD       # 保護者モードのパスワード
npx wrangler secret put USERS                 # 子の一覧 (JSON, 下記参照)

# デプロイ
npm run deploy
```

`npm run deploy` の出力末尾に `Deployed lesapay triggers (...) https://<name>.<account>.workers.dev` のようにURLが表示されます。これがアプリのトップURLです。後から確認するときは Cloudflare ダッシュボード → Workers & Pages からも見られます。

#### `USERS` の形式

`USERS` は子の `key` (シート名サフィックス) と `label` (表示名) の配列を JSON 文字列で渡します。例:

```json
[{"key":"Light","label":"ライト"},{"key":"Tiara","label":"ティアラ"}]
```

`key` に `Light` を指定すると、対応するシート名は `課題_Light` / `履歴_Light` です。`label` を省略するとキーがそのまま表示されます。`wrangler secret put USERS` のプロンプトには上記JSONを1行で貼り付けてください。

子の追加・改名は `wrangler secret put USERS` で値を更新 → `npm run deploy` → 子用シートを準備、で反映されます。

#### `ACCESS_TOKEN` (招待トークン)

`ACCESS_TOKEN` はリンクを知っている人だけがアプリを使えるようにする「合言葉」です。`/api` への全リクエストはこのトークンで認証されます。生成例:

```bash
openssl rand -hex 16   # 出力をそのまま `wrangler secret put ACCESS_TOKEN` に貼る
```

デプロイ後、家族には次の **招待URL** を1度だけ送ります (例: `https://lesapay.<account>.workers.dev/?k=<token>`)。ブラウザで開くとアプリがトークンを `localStorage` に保存し、URLから `?k=` を自動的に取り除きます。以降は `https://lesapay.<account>.workers.dev/` をブックマークしておけばOK。

トークンを変更したい (家族以外に漏れた疑いがあるなど) ときは、`wrangler secret put ACCESS_TOKEN` で新しい値を入れて再デプロイ → 古いリンクは自動的に無効になり、家族に新しい招待URLを配り直します。

ヘッダーの **ユーザ名チップ** をタップすると `USERS` に登録した子の一覧がドロップダウンで開き、ワンタッチで切り替えられます。

### 4. (任意) LINE 通知の有効化

家族の LINE グループにではなく、専用の **LINE 公式アカウント** を作って家族で友だち登録するスタイルです。

1. [LINE Developers コンソール](https://developers.line.biz/console/) にログイン → プロバイダーを作成
2. **「Messaging API」** の新しいチャネルを作成
3. チャネル詳細の「Messaging API設定」タブで **チャネルアクセストークン (長期)** を発行
4. 同じタブの QR コード で家族全員に公式アカウントを友だち追加してもらう
5. `npx wrangler secret put LINE_TOKEN` でトークンを登録 → `npm run deploy`

通知は `broadcast` で送るので、友だち登録した全員に届きます。シークレット未設定なら通知はスキップされ、アプリは通常通り動きます。

## 運用フロー

1. **課題の追加** (親) — スプレッドシートの「課題_◯◯」シートに行を追加。A列(ID)とB列(状態)は **空欄でOK**
2. **完了報告** (子) — アプリの「完了報告」ボタン → 状態が `申請中` に。`LINE_TOKEN` 設定時は LINE 公式アカウントを友達追加した家族全員に通知
3. **承認 / 訂正依頼** (親) — アプリ右上🔑 → パスワード入力 → 申請中の課題に「✓承認」「✏️訂正依頼」ボタン。承認すると履歴に自動記録。訂正依頼は状態を `差し戻し` に戻して子にやり直してもらう
4. **ポイント消費** (親) — 保護者モードで「ポイントを使う」 → 履歴に `-XXX` で記録 + LINE 通知

> 親が両方の子を見たい場合: ヘッダーのユーザ名チップをタップすると `USERS` に登録した子の一覧が出るので、そこからワンタッチで切り替えられます。LINE通知のリンクは自動で対象の子に切り替わってから開きます。

## セキュリティ

- **`ACCESS_TOKEN` ガード**: `/api` への全リクエストで `Authorization: Bearer <token>` が必須。トークンを知らない人は Worker URL を直接開いても、アプリ画面のかわりに「アクセスできません」だけが表示され、子供の名前・履歴・課題は一切取得できない
- 招待URL `?k=<token>` は1度クリックすると `localStorage` に保存され、`history.replaceState` でアドレスバーから自動的に削除される (スクショ・ブラウザ履歴経由のリーク対策)
- 保護者パスワードは Worker 側のみで検証 (フロントは入力値を `localStorage` に持つだけ)
- スプレッドシートの共有は **自分 + Service Account のみ**
- 設定値 (パスワード・トークン・ユーザ一覧) はすべて `wrangler secret` で管理。スプレッドシートに認証情報を書かない
- リポジトリには個人情報・URL・トークンを含めない

## 開発者向け

設計原則・アーキテクチャ・拡張方法は [`ARCHITECTURE.md`](./ARCHITECTURE.md) を参照してください（英語）。

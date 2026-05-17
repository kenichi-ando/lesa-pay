# LesaPay (レサペイ)

家庭内報酬管理アプリ。子どもが日々の目標を達成 → スマホから完了報告 → 親が承認 → ポイントが貯まる → 親がポイントを使う（お小遣い化など）一連の流れを、Cloudflare Workers + Google スプレッドシートで運用します。

**1端末1人運用**: 1つのスプレッドシートを家族で共用し、子ごとにシートを分けます。各端末は自分のシート名だけを覚えていて、その分のデータしか触れません。GitHubに置くコードには個人情報は一切含まれません。

## 構成

```
lesa-pay/
└── worker/                 # Cloudflare Worker (API + 静的配信を兼ねる)
    ├── src/                # TypeScript ソース (API)
    │   ├── index.ts        # ルーティング (/api 以外は静的アセットへ)
    │   ├── actions.ts      # アクションテーブル + ハンドラ
    │   ├── api.ts          # Sheets API v4 + Google OAuth (JWT)
    │   ├── config.ts       # 設定シートの読み込み
    │   ├── schema.ts       # 課題/履歴シートのスキーマ
    │   ├── messages.ts     # サーバから返す文言
    │   ├── notify.ts       # LINE Messaging API
    │   ├── env.ts          # Worker bindings
    │   └── util.ts
    ├── public/             # フロント一式 (Worker が同オリジンで配信)
    │   ├── index.html
    │   ├── css/style.css
    │   └── js/
    │       ├── config.js   # localStorage キー定義のみ (個人情報なし)
    │       ├── strings.js  # 画面文言 (i18n)
    │       └── app.js      # アプリ本体
    └── wrangler.jsonc      # Worker 設定 (静的アセットバインディング含む)
```

API と SPA を同じ Worker (同一オリジン) で配信するため、フロントは `/api` を相対パスで叩くだけ。サーバURLの初期セットアップ画面はありません。

## セットアップ

### 1. スプレッドシート作成（家族で1つ）

1. 新しい Google スプレッドシートを作成（例: `LesaPay`）
2. シートID（URL の `/d/` と `/edit` の間）を控える
3. 子ごとに「課題_◯◯」「履歴_◯◯」の2シート、加えて家族で1枚の `設定` シートを作る

#### 課題シート (`課題_<子の名前>`)

| A | B | C | D | E | F | G | H | I |
| - | - | - | - | - | - | - | - | - |
| ID | 状態 | 科目 | 分類 | 項目 | 提出報酬 | 完了報酬 | 時間 | 期限 |

A列(ID)とB列(状態)は **空欄でOK**(初回読み込みで自動採番されます)。

#### 履歴シート (`履歴_<子の名前>`)

| A | B | C |
| - | - | - |
| 日時 | 内容 | ポイント |

#### 設定シート (`設定`)

A列にキー、B列以降に値を書きます。`USERS` と `USER_LABELS` は2人目以降も B, C, D, ... と横に並べていきます。

| A (key)           | B以降 (value) の例     | 用途 |
| ----------------- | ---------------------- | ---- |
| `PARENT_PASSWORD` | `myStrongPassword`     | 必須。承認・差し戻し・ポイント消費の認証に使う |
| `USERS`           | `Light` `Tiara` ...    | 必須。シート名のサフィックス (`課題_Light` の `Light` 部分)。表示順 |
| `USER_LABELS`     | `ライト` `ティアラ` ... | `USERS` と同じ順序の表示名。省略時はキーがそのまま表示される |
| `LINE_TOKEN`      | (アクセストークン文字列) | (任意) LINE Messaging API のチャネルアクセストークン (長期)。未設定なら通知をスキップ |

### 2. Google Cloud Service Account を発行

Worker は Sheets API v4 を Service Account で叩きます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成 (既存でも可)
2. **APIとサービス → ライブラリ** で「Google Sheets API」を有効化
3. **IAMと管理 → サービスアカウント** で新規作成 → キーを追加 → JSON をダウンロード
4. JSON 内の `client_email` をコピーして、対象スプレッドシートを **その Service Account メールアドレスに「編集者」で共有**

### 3. Cloudflare Worker をデプロイ

```bash
cd worker
npm install

# シークレット登録 (一度だけ)
npx wrangler secret put GOOGLE_CLIENT_EMAIL   # Service Account の client_email
npx wrangler secret put GOOGLE_PRIVATE_KEY    # Service Account JSON の private_key (-----BEGIN/END PRIVATE KEY----- 含む)
npx wrangler secret put SHEET_ID              # 対象スプレッドシートID

# デプロイ
npm run deploy
```

デプロイ後の URL (例: `https://lesapay.<account>.workers.dev/`) をブラウザで開けばすぐ動きます。`USERS` で登録した子の一覧が自動でヘッダーに反映されます。

ヘッダーの **ユーザ名チップ** をタップすると登録済みの子の一覧がドロップダウンで開き、ワンタッチで切り替えられます。

子の追加・名前変更・削除は `設定` シートの `USERS` / `USER_LABELS` 行を編集するだけで反映されます(再デプロイ不要、ページ再読込でOK)。

### 4. (任意) LINE 通知の有効化

家族の LINE グループにではなく、専用の **LINE 公式アカウント** を作って家族で友だち登録するスタイルです。

1. [LINE Developers コンソール](https://developers.line.biz/console/) にログイン → プロバイダーを作成
2. **「Messaging API」** の新しいチャネルを作成
3. チャネル詳細の「Messaging API設定」タブで **チャネルアクセストークン (長期)** を発行
4. 同じタブの QR コード で家族全員に公式アカウントを友だち追加してもらう
5. 設定シートの `LINE_TOKEN` 行に発行したトークンを貼る

通知は `broadcast` で送るので、友だち登録した全員に届きます。トークン未設定なら通知はスキップされ、アプリは通常通り動きます。

## 運用フロー

1. **課題の追加** (親) — スプレッドシートの「課題_◯◯」シートに行を追加。A列(ID)とB列(状態)は **空欄でOK**
2. **完了報告** (子) — アプリの「完了報告」ボタン → 状態が `申請中` に。`LINE_TOKEN` 設定時は LINE 公式アカウントを友達追加した家族全員に通知
3. **承認 / 訂正依頼** (親) — アプリ右上🔑 → パスワード入力 → 申請中の課題に「✓承認」「✏️訂正依頼」ボタン。承認すると履歴に自動記録。訂正依頼は状態を `差し戻し` に戻して子にやり直してもらう
4. **ポイント消費** (親) — 保護者モードで「ポイントを使う」 → 履歴に `-XXX` で記録 + LINE 通知

> 親が両方の子を見たい場合: ヘッダーのユーザ名チップをタップすると `USERS` に登録した子の一覧が出るので、そこからワンタッチで切り替えられます。LINE通知のリンクは自動で対象の子に切り替わってから開きます。

## セキュリティ

- 保護者パスワードは Worker 側のみで検証 (フロントは入力値を `localStorage` に持つだけ)
- スプレッドシートの共有は **自分 + Service Account のみ**
- リポジトリには個人情報・URLを含めない
- Worker のシークレット (`GOOGLE_PRIVATE_KEY` 等) は `wrangler secret` で管理し、コードには含めない

## 開発者向け

設計原則・アーキテクチャ・拡張方法は [`CONTRIBUTING.md`](./CONTRIBUTING.md) を参照してください（英語）。

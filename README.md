# LesserPay (レサペイ)

家庭内報酬管理アプリ。子どもが日々の目標を達成 → スマホから完了報告 → 親が承認 → **レッサーポイント (単位 `pt`)** が貯まる → 親がレッサーポイントを使う（お小遣い化など）一連の流れを、Cloudflare Workers + Google スプレッドシートで運用します。

**1端末1人運用**: 1つのスプレッドシートを家族で共用し、子ごとにシートを分けます。各端末は自分のシート名だけを覚えていて、その分のデータしか触れません。GitHubに置くコードには個人情報は一切含まれません。

## 構成

```
lesser-pay/
├── server/                # Cloudflare Worker (TypeScript, API)
│   ├── index.ts           # ルーティング (/api 以外は静的アセットへ)
│   ├── actions.ts         # アクションテーブル + ハンドラ
│   ├── api.ts             # Sheets API v4 + Google OAuth (JWT)
│   ├── config.ts          # 環境変数 (wrangler secret) → Config
│   ├── schema.ts          # 課題/履歴シートのスキーマ
│   ├── messages.ts        # サーバから返す文言
│   ├── notify.ts          # 通知ファンアウト (Web Push)
│   ├── push.ts            # Web Push (VAPID + RFC 8291 aes128gcm)
│   ├── env.ts             # Worker bindings
│   └── util.ts
├── client/                # フロント一式 (Worker が同オリジンで配信)
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js                          # Service Worker (Web Push + バッジ管理)
│   ├── icons/                         # PWA / favicon アイコン
│   ├── css/style.css
│   └── js/
│       ├── config.js                  # localStorage キー定義のみ (個人情報なし)
│       ├── strings.js                 # 画面文言 (i18n)
│       ├── app-i18n.js                # tr/applyI18n
│       ├── app-store.js               # localStorage ラッパ
│       ├── app-utils.js               # 日付/表示ユーティリティ
│       ├── app-render.js              # 描画専用レイヤ
│       ├── app-controller-data.js     # API通信/boot/loadData
│       ├── app-controller-actions.js  # タスク操作/キャッシュアウト/toast
│       ├── app-controller.js          # ユーザー切替/親モードUIの制御
│       └── app.js                     # 依存注入とイベント配線（オーケストレーター）
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

1. 新しい Google スプレッドシートを作成（例: `LesserPay`）
2. シートID（URL の `/d/` と `/edit` の間）を控える
3. 子ごとに `Tasks_<子の名前>` と `History_<子の名前>` の2シート(タブ)を作る — タブ名の大文字小文字は完全一致が必要です (例: `Tasks_Light`, `History_Light`)

#### 課題シート (`Tasks_<子の名前>`)

A列から順に **ID / ステータス / 分類 / タスク名 / 提出報酬 / 完了報酬 / 時間(分) / 期限** の8列。1行目のヘッダ文字列は自由 (コードは1行目を読まずに2行目以降をデータとして扱います)。日本語のままでも英語でも構いません。

| 列 | 内容 | 空欄でOK? |
|----|----|----|
| A | ID | ✅ (初回読み込みで `T<unix>_<rand>` 自動採番) |
| B | ステータス (`Pending` / `Submitted` / `Returned` / `Approved`) | ✅ (空 = `Pending`) |
| C | 分類 — 同じ値を持つ課題どうしを画面上でグループ化する見出し (例: `お手伝い`, `運動`) | ✅ (空 = `その他` 扱い) |
| D | タスク名 | ❌ 必須 |
| E | 提出報酬 (申請時に1回だけ加算) | ✅ (0扱い) |
| F | 完了報酬 (親の承認時に加算) | ✅ (0扱い) |
| G | 時間(分) — 表示のみ | ✅ |
| H | 期限 `YYYY/MM/DD` | ✅ (空 = 無期限) |

#### 履歴シート (`History_<子の名前>`)

A列から順に **日時 / 内容 / レッサーポイント (pt)** の3列。1行目のヘッダ文字列は自由。アプリ側が自動で書き込みます。手書きで足したい場合は同じ列構成に揃えてください。

### 2. Google Cloud Service Account を発行

Worker は Sheets API v4 を Service Account で叩きます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成 (既存でも可)
2. **APIとサービス → ライブラリ** で「Google Sheets API」を有効化
3. **IAMと管理 → サービスアカウント** で新規作成 → キーを追加 → JSON をダウンロード
4. JSON 内の `client_email` をコピーして、対象スプレッドシートを **その Service Account メールアドレスに「編集者」で共有**

### 3. Cloudflare Worker をデプロイ

`wrangler.jsonc` の `"name"` を自分が使いたい Worker 名に変更します (デフォルトは `lesser-pay`)。これがそのままデプロイURLのサブドメインになります (例: `"happy-coins"` → `https://happy-coins.<account>.workers.dev/`)。

```bash
npm install

# シークレット登録 (一度だけ)
npx wrangler secret put GOOGLE_CLIENT_EMAIL   # Service Account の client_email
npx wrangler secret put GOOGLE_PRIVATE_KEY    # Service Account JSON の private_key (-----BEGIN/END PRIVATE KEY----- 含む)
npx wrangler secret put GOOGLE_SHEET_ID              # 対象スプレッドシートID
npx wrangler secret put INVITE_CODE           # 招待コード (6文字 / A-Z, 0-9。下の「`INVITE_CODE` / `API_TOKEN`」セクション参照)
npx wrangler secret put API_TOKEN             # /api 認証用の長いトークン (43文字目安。下の同セクション参照)
npx wrangler secret put PARENT_PIN            # 保護者モードの暗証番号
npx wrangler secret put USERS                 # 子の一覧 (JSON, 下記参照)

# デプロイ
npm run deploy
```

`npm run deploy` の出力末尾に `Deployed <worker-name> triggers (...) https://<worker-name>.<account>.workers.dev` のようにURLが表示されます。これがアプリのトップURLです。後から確認するときは Cloudflare ダッシュボード → Workers & Pages からも見られます。

#### `USERS` の形式

`USERS` は `key:label` の組をカンマ区切りで並べた文字列です。例:

```
Light:ライト, Tiara:ティアラ
```

`key` に `Light` を指定すると、対応するシート(タブ)名は `Tasks_Light` / `History_Light` です。`label` を省略するとキーがそのまま表示されます (例: `Light, Tiara` だけでもOK)。`:` の前後・カンマの前後の空白は自動で trim されます。

子の追加・改名は `wrangler secret put USERS` で値を更新 → 子用シートを準備、で反映されます (secret 更新だけならデプロイ不要)。

#### `INVITE_CODE` / `API_TOKEN`

認証は **2段構え** にしています:

- **`INVITE_CODE`** — 家族にだけ伝える短い合言葉 (**6文字 / A-Z + 0-9**)。アプリ初回起動時のロック画面で1回だけ手入力します。サーバが照合 OK なら `API_TOKEN` をクライアントに返します。
- **`API_TOKEN`** — `/api` への全リクエストで `Authorization: Bearer <token>` として送られる長い乱数 (**43文字目安、~256bit**)。クライアントは `localStorage` に保存し以降の API 呼び出しで使います。**家族に直接伝える値ではありません。**

短い招待コードを直接 API 認証に使わないのは、6文字 (≈21億通り) では `/api` への総当たり攻撃に対して長期的には不十分だからです。`API_TOKEN` を別 secret にすることで、API 認証は事実上ブルートフォース不可能 (~256bit) にしつつ、家族に渡す合言葉は 6文字に短縮しています。

生成例:

```bash
# INVITE_CODE (6文字 [A-Z0-9])
LC_ALL=C tr -dc 'A-Z0-9' </dev/urandom | head -c 6 ; echo
# → 例: K7QXZ4

# API_TOKEN (43文字、~256bit)
LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 43 ; echo
# → 例: a8Kx9_QmZ-tR4vNpBhCsLuEwJfY2DgHjT6VnXkM3PqA
```

デプロイ後、家族にはアプリ URL とこの **6文字の招待コードだけ** を別々に伝えます (`API_TOKEN` は家族に渡しません)。家族は URL を開くと「招待コードを入力」画面が出るので、そこに 6文字を入力するとアプリが使えるようになります。入力は小文字で打ってもアプリ側で自動で大文字に変換されます。

招待コード/トークンを更新したいとき:

- **招待コードのみ更新** (家族以外に漏れた疑い): `wrangler secret put INVITE_CODE` で新値 → 再デプロイ。既存の家族端末は `API_TOKEN` を持っているので影響なし。新規追加端末は新しい招待コードで入る
- **API_TOKEN も更新** (より強い無効化): `wrangler secret put API_TOKEN` で新値 → 再デプロイ。**全端末で `localStorage` がリセットされ、家族全員が招待コードを再入力する必要があります**

ヘッダーの **ユーザ名チップ** をタップすると `USERS` に登録した子の一覧がドロップダウンで開き、ワンタッチで切り替えられます。

### 4. プッシュ通知の有効化 (管理者作業)

通知は VAPID 鍵をサーバに登録すると有効になります。**未設定でもアプリは動きますが、通知ボタン自体が表示されません**。家族のホーム画面追加 (次ステップ) より先に済ませてください。

1. VAPID キーペアを生成

```bash
npx web-push generate-vapid-keys
```

2. 以下を `wrangler secret` に登録して再デプロイ

```bash
npx wrangler secret put PUSH_VAPID_PUBLIC_KEY
npx wrangler secret put PUSH_VAPID_PRIVATE_KEY
npx wrangler secret put PUSH_SUBJECT    # 例: mailto:you@example.com (実在のメアド推奨。Apple は example.com 等の架空ドメインを拒否)
npm run deploy
```

VAPID 鍵を後から差し替えた場合、過去の鍵で購読していた端末への送信は失敗し続けます。スプレッドシートの `PushSubscriptions` シートのデータ行を全削除し、各端末で通知ボタンをオフ→オンして購読し直してください。

サーバ側は RFC 8291 (aes128gcm) で `{title, body}` を暗号化したペイロードを送ります。Service Worker (`client/sw.js`) は通知受信ごとにバッジ件数を IndexedDB にインクリメント保持し、アプリをフォアグラウンドにすると自動でクリアされます。

## 家族向け：PWA としてホーム画面に追加 (必須)

LesserPay は **PWA としてホーム画面から起動することを前提に作っています**。とくに iOS は PWA としてインストールしないとプッシュ通知が一切届きません。Android も PWA で起動したほうがブラウザのアドレスバー等が消えてアプリらしい見た目になります。

家族には **アプリ URL と 6文字の招待コード** を伝え、必ず以下のいずれかの手順で **ホーム画面に追加 → ホーム画面アイコンから起動 → 招待コードを入力** してください。

### iPhone / iPad (iOS 16.4 以降)

1. **Safari** でアプリ URL を開く (Chrome / Firefox iOS版では PWA インストール不可)
2. 画面下の共有ボタン (□↑) → 「ホーム画面に追加」 → 「追加」
3. **ホーム画面のアプリアイコンから起動** (Safari のタブから開くと通知が動きません)
4. 「アクセスできません」画面で **招待コード (6文字)** を入力
5. ヘッダー右上のユーザー名チップ → 「⚙️ 設定」 → 「🔔 通知」をオン → 通知許可ダイアログで「許可」

### Android (Chrome)

1. **Chrome** でアプリ URL を開く
2. アドレスバー右の「︙」メニュー → 「アプリをインストール」または「ホーム画面に追加」
3. ホーム画面のアプリアイコンから起動
4. 「アクセスできません」画面で **招待コード (6文字)** を入力
5. ヘッダー右上のユーザー名チップ → 「⚙️ 設定」 → 「🔔 通知」をオン → 通知許可ダイアログで「許可」

### PC (Chrome / Edge)

1. アプリ URL を開く
2. アドレスバー右端のインストールアイコン (⊕ 状) をクリック → 「インストール」
3. デスクトップ / スタートメニューから起動
4. 「アクセスできません」画面で **招待コード (6文字)** を入力
5. ヘッダー右上のユーザー名チップ → 「⚙️ 設定」 → 「🔔 通知」をオン → ブラウザの通知許可ダイアログで「許可」

> PC は PWA インストールしなくてもブラウザ通知が動きますが、タブを閉じていると届かないので、家族で揃えるためにもインストール推奨です。

### 通知が来ない時のチェックリスト

- ホーム画面のアイコンから起動している (ブラウザのタブからではない)
- 「⚙️ 設定」モーダルの「🔔 通知」がオンになっている
- iOS 設定 → 通知 → LesserPay が「通知を許可」になっている
- iOS の集中モード／おやすみモードが OFF
- iOS の場合、バージョンが 16.4 以上である

それでもダメなら、PWA をホーム画面から削除 → 再インストール → 通知をオン、で購読をやり直してください。それでも直らないときは管理者が `npx wrangler tail` で送信ログを確認します ([ARCHITECTURE.md](./ARCHITECTURE.md) の Web Push セクション参照)。

## 運用フロー

1. **課題の追加** (親) — スプレッドシートの `Tasks_◯◯` シートに行を追加。A列(ID)とB列(状態)は **空欄でOK**。
2. **利用者の選択** (起動時/切替時) — 初回は「誰が使う？」画面で子ども or 保護者を選択。保護者を選ぶとパスワード入力（保存済みなら自動ログイン）。
3. **完了報告** (子) — タスクの「完了報告」ボタンで状態が `申請中` に。通知が有効な保護者端末にプッシュ通知が届く。
4. **承認 / 訂正依頼** (親) — ヘッダー右上の**ユーザ名チップ**をタップ → 必要に応じて「ログインユーザーを切り替え」から保護者でログイン → `申請中` の課題に「✓承認」「✏️訂正依頼」。承認で履歴に自動記録、訂正依頼で `差し戻し` に戻る。訂正依頼時は対象の子ども端末に通知。
5. **表示ユーザーの切替** (親) — 保護者モード中は同じメニューから子どもの表示先をワンタッチ切替（保護者モードは維持）。
6. **レッサーポイント消費** (親) — 保護者モードで「レッサーポイントを使う」→ 履歴に `-XXX` で記録。保護者端末に通知。

## セキュリティ

- **`API_TOKEN` ガード**: `/api` への全リクエスト (招待コード交換以外) は `Authorization: Bearer <API_TOKEN>` が必須。トークンを持たない人は Worker URL を直接開いても、アプリ画面のかわりに「アクセスできません」だけが表示され、子供の名前・履歴・課題は一切取得できない
- 招待コードは 6文字 (大文字+数字)。家族には URL と別ルート (口頭/メッセージ) で渡す。1度入力すると交換された `API_TOKEN` だけが `localStorage` に保存され、招待コード自体は端末に残らない。URL にも含めないので画面共有・スクショ・ブラウザ履歴経由でも漏れない
- **`/api` への総当たり耐性は `API_TOKEN` (~256bit) で確保**。短い招待コードはサーバが照合し API_TOKEN を発行する1段目だけに使われる
- 保護者パスワードは Worker 側のみで検証 (フロントは入力値を `localStorage` に持つだけ)
- スプレッドシートの共有は **自分 + Service Account のみ**
- 設定値 (パスワード・トークン・ユーザ一覧) はすべて `wrangler secret` で管理。スプレッドシートに認証情報を書かない
- リポジトリには個人情報・URL・トークンを含めない

## 開発者向け

設計原則・アーキテクチャ・拡張方法は [`ARCHITECTURE.md`](./ARCHITECTURE.md) を参照してください（英語）。

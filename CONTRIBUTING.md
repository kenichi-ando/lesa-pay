# Contributing to LesaPay

This is the developer/contributor companion to `README.md`. The README covers
"how to set up and run LesaPay for your family" (in Japanese, since the
audience is the parent operating it). This file covers "how the code is
structured and how to extend it safely" — in English, alongside the source.

## Architecture

```
┌────────────────────┐    HTTPS POST     ┌──────────────────────┐
│  Browser (Vanilla) │ ────────────────▶ │  GAS Web App         │
│  public/*.html|js  │   {action, ...}   │  gas/Code.gs         │
│                    │ ◀──────────────── │                      │
│  - Render only     │   {ok, ...}       │  - Auth + Validation │
│  - State in        │                   │  - All business logic│
│    localStorage    │                   │  - Sheet I/O         │
└────────────────────┘                   │  - LINE notifications│
                                         └──────────────────────┘
                                                   │
                                                   ▼
                                         ┌──────────────────────┐
                                         │  Google Spreadsheet  │
                                         │  per-child sheets    │
                                         └──────────────────────┘
```

- The browser is **untrusted**. A child can open DevTools and replay any HTTP request.
- Therefore *all* state-transition checks (only APPLIED can be approved, only
  PENDING/REJECTED can submit, balance must be sufficient, etc.) live in GAS.
- The frontend's only job is to render and to forward user intents.

## Repository layout

```
lesa-pay/
├── public/                  # Firebase Hosting deploys this directory
│   ├── index.html
│   ├── css/style.css
│   ├── icons/*.svg
│   ├── manifest.webmanifest
│   └── js/
│       ├── config.js        # localStorage keys (no personal data)
│       ├── strings.js       # All user-facing UI strings (i18n)
│       └── app.js           # Application code
├── gas/
│   ├── Code.gs              # Apps Script backend
│   └── appsscript.json      # OAuth scopes etc.
├── firebase.json
├── .firebaserc
├── README.md                # End-user (parent) documentation, in Japanese
└── DEVELOPMENT.md           # This file
```

## Design principles

These are non-negotiable rules. Breaking them tends to introduce hard-to-spot bugs.

### 1. Logic lives in GAS. The browser only renders and triggers.

- State transitions, password checks, balance checks, expiry checks: GAS only.
- The frontend can mirror logic for display (e.g. computing the running balance
  for the badge in `renderBalance`), but the *authoritative* check happens
  server-side. Cashout is the canonical example: the browser warns about
  insufficient balance, but GAS rejects the request independently.
- Reason: the client is on a child's device. We assume curious children. If a
  rule is only enforced in JS it is trivially bypassed via DevTools.

### 2. New actions go through the `ACTIONS` table.

`gas/Code.gs`:
```js
const ACTIONS = {
  myNewAction: { requireUser: true, handler: (req) => handleMyNewAction(req.user, req.foo) },
  // ...
};
```
Then implement `handleMyNewAction(user, foo)`. Auth and validation are handled
by the dispatcher and the handler — there is no other entry point.

Frontend:
```js
await api('myNewAction', { foo: 42 });
```

### 3. The frontend owns no durable state beyond identity and config.

`localStorage` carries only:

| Key                  | Purpose |
| -------------------- | ------- |
| `lesapay_gas_url`    | The Web App URL the user typed during setup |
| `lesapay_user`       | Sheet name suffix (which child this device represents) |
| `lesapay_label`      | Display nickname (defaults to `user`) |
| `lesapay_parent_pw`  | Last successful parent password — used for `?parent=1` auto-login |

Tasks and history are *not* cached across reloads. Locks live in
`LockService.getScriptLock()` on the server; the client never tries to reproduce them.

### 4. Side effects (notifications, etc.) belong on the server.

LINE Broadcast is sent from GAS via `notify()`. The frontend must never call
external APIs directly. If a future feature needs a webhook, add an action and
let GAS make the outbound request.

## Schema

### Task sheet (`課題_<user>`)

Defined by `TASK_SCHEMA` in `gas/Code.gs`. Source of truth — `TASK_COL`,
`TASK_HEADERS`, `TASK_COL_COUNT` are derived from it.

| Index | Key                | Header | Notes |
| ----: | ------------------ | ------ | ----- |
| 0     | `ID`               | ID     | Auto-generated on read if blank (`T<unix>_<rand>`) |
| 1     | `STATUS`           | 状態    | `STATUS.PENDING` / `APPLIED` / `REJECTED` / `APPROVED` |
| 2     | `SUBJECT`          | 科目    | Used for grouping in the UI |
| 3     | `CATEGORY`         | 分類    | |
| 4     | `TITLE`            | 項目    | Required |
| 5     | `SUBMIT_REWARD`    | 提出報酬 | Granted on the *first* submit only |
| 6     | `COMPLETE_REWARD`  | 完了報酬 | Granted when the parent approves |
| 7     | `MINUTES`          | 時間    | Estimated minutes; display only |
| 8     | `EXPIRY`           | 期限    | YYYY/MM/DD; tasks past expiry can't be applied |

To add a column: insert a row into `TASK_SCHEMA`. Everything else updates
automatically. Existing sheets need a manual header insert (or re-run
`setupSheets("<user>")` on a fresh sheet).

### History sheet (`履歴_<user>`)

| Index | Key       | Header  | Notes |
| ----: | --------- | ------- | ----- |
| 0     | `DATE`    | 日時    | `yyyy/MM/dd HH:mm` |
| 1     | `CONTENT` | 内容    | Free-form. e.g. `"英語 単語50個"`, `"ポイント消費"` |
| 2     | `POINTS`  | ポイント | Positive (reward) or negative (cashout) |

### Status values

```js
STATUS = { PENDING: '未完了', APPLIED: '申請中', REJECTED: '差し戻し', APPROVED: '承認済み' }
```

Authoritative copy is in `gas/Code.gs`. The frontend has a fallback copy in
`app.js` and overwrites it at startup via the `getConfig` action so renaming a
status in one place propagates after deploy.

State transitions:

```
PENDING ─[applyTask, +submitReward]─▶ APPLIED ─[approveTask, +completeReward]─▶ APPROVED
                                         │
                                         └─[rejectTask]─▶ REJECTED
                                                            │
                                                            └─[applyTask, no submit reward]─▶ APPLIED
```

Approved is terminal. Rejecting an already-approved task is forbidden (avoids
double payout).

## i18n

`public/js/strings.js` is the single place for user-facing copy. Two channels:

1. **Static HTML** uses `data-i18n="key"` (text content) or
   `data-i18n-attr-<attr>="key"` (any attribute, e.g. `aria-label`,
   `placeholder`). `applyI18n()` runs once at startup and substitutes them.
2. **Dynamic JS strings** call `tr('key', { vars })`, where `{vars}` interpolates
   `{name}`-style placeholders.

To support a second language: keep `strings.js` as a default and add e.g.
`strings.en.js`; pick one based on `localStorage` or `navigator.language`.

Sheet column headers and status values are intentionally left in Japanese in
the schema, because the spreadsheet is the parent-facing source of truth.

## Code map (`public/js/app.js`)

- `STATUS` / `STRINGS` — bootstrapped fallbacks. Real values come from server.
- `tr()` / `applyI18n()` — translation helpers.
- `store.*` — `localStorage` accessors.
- `state` — in-memory state for the running session.
- `api(action, payload)` — single entry point for all GAS calls. Uses
  `Content-Type: text/plain` to avoid the CORS preflight that GAS rejects.
- `render*` — pure view layer; no network or mutation.
- `taskItemHtml(t)` — task row template; XSS-escapes via `escapeHtml`.
- `bootstrap()` — startup. Reads localStorage, opens setup if needed, otherwise
  loads data and handles `?parent=1` (auto-login from a LINE link).
- `refreshServerConfig()` — pulls `STATUS` from GAS in the background.

## Adding a new action — checklist

1. **GAS** — add to `ACTIONS`:
   ```js
   const ACTIONS = {
     // ...
     newAction: { requireUser: true, handler: (req) => handleNewAction(req.user, req.foo) }
   };
   ```
2. **GAS** — implement `handleNewAction(user, foo)`. Always go through `withLock(() => ...)` if you mutate the spreadsheet, and through `findTaskRow(...)` for per-task operations. Throw on bad input — `doPost` packages errors as `{ ok: false, error: '...' }`.
3. **Frontend** — call `await api('newAction', { foo })`.
4. **Strings** — add any new UI strings to `strings.js`.
5. **Redeploy GAS** (Manage Deployments → ✏️ → New version).

## Local development

```bash
# Run a tiny static server. Keeps URLs identical to production hosting.
python3 -m http.server 8080 -d public

# Then open
http://localhost:8080/

# Or alternatively use the Firebase emulator
firebase emulators:start --only hosting
```

The frontend hits the *real* GAS endpoint regardless of where it is served
from. There is no GAS emulator — write to a separate "dev" spreadsheet if you
need to test destructive flows.

## Deploy

### Frontend

```bash
firebase deploy --only hosting
# → published to https://lesa-pay-v1.web.app/
```

### GAS

Editing `gas/Code.gs` does not affect the live deployment. After saving:

1. Deploy → Manage deployments
2. Pencil ✏️ on the active deployment
3. Version: **New version**
4. Deploy

The Web App URL stays the same when you edit an existing deployment. Selecting
"New deployment" creates a *new* URL that the existing client doesn't know
about — avoid this in normal flow.

### Required script properties

| Property          | Required | Notes |
| ----------------- | :------: | ----- |
| `SHEET_ID`        | ✅      | Spreadsheet ID |
| `PARENT_PASSWORD` | ✅      | Parent password |
| `LINE_TOKEN`      | ⬜      | LINE Messaging API channel access token. Skip notifications if blank. |
| `APP_URL`         | ⬜      | App URL (e.g. `https://lesa-pay-v1.web.app/`). If set, LINE notifications append a `?parent=1` deep-link. |

### OAuth scopes

`gas/appsscript.json` declares the required scopes upfront so the consent screen lists them all on first run:

- `script.external_request` — LINE API outbound HTTP
- `spreadsheets` — read/write the data sheet

Mail (`script.send_mail`) was used briefly for email notifications and has been removed.

## Security model (and its limits)

- The GAS Web App is published as **"Anyone, anonymous"**. Anyone who learns
  the URL can call `getData` / `applyTask` for any user.
- `approveTask` / `rejectTask` / `cashout` require `PARENT_PASSWORD` verified by GAS.
- The frontend stores the verified password in `localStorage` after a
  successful login. This effectively turns the device into a "parent device"
  for `?parent=1` auto-login from LINE notifications.
- We accept the residual risks (siblings inspecting `localStorage`, an
  attacker discovering the URL) for a small family-internal app. If wider
  exposure becomes a concern, add a server-side family token gate to every
  action.

## Things that intentionally aren't here

- No Service Worker / offline caching. Adding one would conflict with the
  "always show the latest deploy" behaviour we want during active development.
- No build step. The site loads the source files directly. Adding bundling
  trades simplicity for marginal performance — avoid until needed.
- No automated tests. The behaviour surface is small enough to verify manually
  per change.

## Reviewer notes

When reviewing a PR, the things most likely to be wrong:

1. A new sheet column was added but read code still uses the old width
   (`TASK_COL_COUNT` should propagate; double-check `getRange(..., width)`).
2. A new state was added but only some of the comparison sites were updated.
   Search for `STATUS.` in both `gas/Code.gs` and `public/js/app.js`.
3. A new UI string was added but only added to `strings.js`, not actually
   referenced via `tr(...)` (or vice versa).
4. A new action was added but `requireUser` was set wrong (most actions need
   `true`; `getConfig` and `verifyPassword` are the exceptions).
5. New side effects added on the frontend instead of in GAS. Move them.

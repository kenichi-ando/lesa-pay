# LesaPay architecture

This is the developer-facing companion to `README.md`. The README covers
"how to set up and run LesaPay for your family" (in Japanese, since the
audience is the parent operating it). This file covers "how the code is
structured and how to extend it safely" — in English, alongside the source.

## Overview

```
┌────────────────────┐    HTTPS POST     ┌──────────────────────┐
│  Browser (Vanilla) │ ────────────────▶ │  Cloudflare Worker   │
│  client/*          │   {action, ...}   │  server/*.ts         │
│                    │ ◀──────────────── │                      │
│  - Render only     │   {ok, ...}       │  - Auth + Validation │
│  - State in        │                   │  - All business logic│
│    localStorage    │                   │  - Sheets API I/O    │
└────────────────────┘                   │  - LINE notifications│
        ▲                                └──────────────────────┘
        │  Worker also serves              │          │
        │  static assets from client/      ▼          ▼
        │                          ┌─────────────┐  ┌──────────────┐
        │                          │  Google     │  │  LINE        │
        │                          │  Spreadsheet│  │  Messaging   │
        │                          │  per-child  │  │  API         │
        │                          │  (data only)│  │  (broadcast) │
        │                          └─────────────┘  └──────────────┘
        │                                                  │
        │            tap notification deep link            │
        └──────────────────────────────────────────────────┘
```

- The browser is **untrusted**. A child can open DevTools and replay any HTTP request.
- Therefore *all* state-transition checks (only APPLIED can be approved, only
  PENDING/REJECTED can submit, balance must be sufficient, etc.) live in the
  Worker.
- The frontend's only job is to render and to forward user intents.
- API and SPA share the same origin: the Worker matches `/api` first, and falls
  through to the static-assets binding (`client/`) for everything else.
  This is set up in `wrangler.jsonc` via `assets.run_worker_first`.

## Repository layout

```
lesa-pay/
├── server/                # Cloudflare Worker (TypeScript)
│   ├── index.ts           # Top-level fetch handler + dispatch
│   ├── actions.ts         # ACTIONS table + handlers
│   ├── api.ts             # Sheets API v4 + Service Account JWT
│   ├── config.ts          # wrangler secrets → Config object
│   ├── schema.ts          # Sheet schema (TASK_SCHEMA, STATUS, etc.)
│   ├── messages.ts        # MSG catalog + fmt() template helper
│   ├── notify.ts          # LINE Messaging API
│   ├── env.ts             # Env bindings interface
│   └── util.ts            # HttpError, encoding, date helpers
├── client/                # Served by the same Worker via assets binding
│   ├── index.html
│   ├── css/style.css
│   ├── icons/*.svg
│   ├── manifest.webmanifest
│   └── js/
│       ├── config.js      # localStorage keys (no personal data)
│       ├── strings.js     # All user-facing UI strings (i18n)
│       └── app.js         # Application code
├── wrangler.jsonc         # Worker config (incl. ASSETS binding)
├── tsconfig.json
└── package.json
```

## Design principles

These are non-negotiable rules. Breaking them tends to introduce hard-to-spot bugs.

### 1. Logic lives in the Worker. The browser only renders and triggers.

- State transitions, password checks, balance checks, expiry checks: Worker only.
- The frontend can mirror logic for display (e.g. computing the running balance
  for the badge in `renderBalance`), but the *authoritative* check happens
  server-side. Cashout is the canonical example: the browser warns about
  insufficient balance, but the Worker rejects the request independently.
- Reason: the client is on a child's device. We assume curious children. If a
  rule is only enforced in JS it is trivially bypassed via DevTools.

### 2. New actions go through the `ACTIONS` table.

`server/actions.ts`:
```ts
export const ACTIONS: Record<string, ActionDef> = {
  myNewAction: {
    requireUser: true,
    handler: async (req, env, origin) =>
      handleMyNewAction(env, req.user as string, req.foo),
  },
  // ...
};
```
Then implement `handleMyNewAction(env, user, foo)`. Auth and validation are
handled by the dispatcher in `index.ts` and the handler — there is no other
entry point.

Frontend:
```js
await api('myNewAction', { foo: 42 });
```

### 3. The frontend owns no durable state beyond identity and config.

`localStorage` carries only:

| Key                     | Purpose |
| ----------------------- | ------- |
| `lesapay_user`          | Currently selected sheet-name suffix (a key into the `USERS` roster) |
| `lesapay_parent_pw`     | Last successful parent password — used for parent-mode deep-link auto-login |
| `lesapay_access_token`  | Shared invitation token, captured once from `?k=<token>` and sent on every `/api` call as `Authorization: Bearer …`. Cleared on 401 (token rotated server-side). |

Tasks and history are *not* cached across reloads. The user roster itself is
*not* persisted in the browser — it is fetched from the Worker via `getConfig`
on every boot. Roster changes therefore require a `wrangler secret put USERS`
+ `npm run deploy`; client-side changes alone are not enough. There is no API
URL stored either: the SPA and `/api` are co-hosted, so the frontend just
calls a relative `/api`.

### 4. Side effects (notifications, etc.) belong on the server.

LINE Broadcast is sent from `server/notify.ts`. The frontend must never
call external APIs directly. If a future feature needs a webhook, add an
action and let the Worker make the outbound request.

### 5. Concurrency is handled with optimistic CAS, not a lock.

There is no cross-request lock primitive. `casTaskStatus` in `api.ts` re-reads
the `STATUS` cell immediately before the write and aborts with `409` if it
changed since the handler last saw it. Any new write that depends on a prior
read should follow the same pattern.

History writes use plain `values:append` — the cashout balance check has a
read/append race, but for family-scale traffic we accept that.

### 6. Same-origin frontend ↔ API.

The Worker serves both the SPA (`client/`) and the API (`/api`) on a single
origin. This is a deliberate choice that buys us several niceties:

- No CORS preflight, so we POST plain `application/json` directly.
- No API URL to configure or persist on the client — `fetch('/api', ...)`.
- One `wrangler deploy` ships frontend and backend atomically (no risk of
  mismatched versions across origins).

## Schema

Source of truth is `server/schema.ts`. Runtime config (passwords, roster,
LINE token) lives in `wrangler secret`-managed env vars and is read by
`server/config.ts`.

### Task sheet (`課題_<user>`)

Defined by `TASK_SCHEMA`. `TASK_COL`, `TASK_COL_COUNT`, `TASK_LAST_COL_LETTER`
are derived from it.

| Index | Key                | Header | Notes |
| ----: | ------------------ | ------ | ----- |
| 0     | `ID`               | ID     | Auto-generated on read if blank (`T<unix>_<rand>`) |
| 1     | `STATUS`           | 状態    | `STATUS.PENDING` / `APPLIED` / `REJECTED` / `APPROVED` |
| 2     | `CATEGORY`         | 分類    | Used as the group heading in the UI. Empty rows fall under `tasks.otherGroup`. |
| 3     | `TITLE`            | 項目    | Required |
| 4     | `SUBMIT_REWARD`    | 提出報酬 | Granted on the *first* submit only |
| 5     | `COMPLETE_REWARD`  | 完了報酬 | Granted when the parent approves |
| 6     | `MINUTES`          | 時間    | Estimated minutes; display only |
| 7     | `EXPIRY`           | 期限    | YYYY/MM/DD; tasks past expiry can't be applied |

To add a column: insert an entry into `TASK_SCHEMA`. Everything else updates
automatically. Existing sheets need a manual header insert.

### History sheet (`履歴_<user>`)

| Index | Key       | Header  | Notes |
| ----: | --------- | ------- | ----- |
| 0     | `DATE`    | 日時    | `yyyy/MM/dd HH:mm` |
| 1     | `CONTENT` | 内容    | Free-form. e.g. `"英語 単語50個 (承認)"`, `"ポイント消費"` |
| 2     | `POINTS`  | ポイント | Positive (reward) or negative (cashout) |

### Runtime config (wrangler secrets)

All runtime knobs are wrangler secrets, read from `env` by `fetchConfig()`.
There is no spreadsheet round-trip on parent actions — `checkPassword()` is
synchronous. Changes require `wrangler secret put …` + `npm run deploy`.

| Secret             | Required | Notes |
| ------------------ | :------: | ----- |
| `GOOGLE_CLIENT_EMAIL` | ✅   | Service Account email for Sheets API. |
| `GOOGLE_PRIVATE_KEY`  | ✅   | Service Account private key (PEM). |
| `SHEET_ID`            | ✅   | Target spreadsheet (one per family). |
| `ACCESS_TOKEN`        | ✅   | Shared invitation token gating `/api`. Verified with `constantTimeEqual`. |
| `PARENT_PASSWORD`     | ✅   | Parent-mode password. Verified on approve / reject / cashout. |
| `USERS`               | ✅   | JSON array of `{key,label}`. Drives the in-app roster. |
| `LINE_TOKEN`          | ⬜   | LINE Messaging API channel access token. Notifications skipped if unset. |

`USERS` example:

```json
[{"key":"Light","label":"ライト"},{"key":"Tiara","label":"ティアラ"}]
```

`label` is optional (defaults to `key`). The parsed list is cached per Worker
isolate, so successive requests don't re-parse the JSON.

There is no `APP_URL` secret: deep-link URLs in LINE notifications are built
from the request's own origin (`new URL(req.url).origin`), which is
trustworthy on Cloudflare.

### Status values

```ts
STATUS = { PENDING: '未完了', APPLIED: '申請中', REJECTED: '差し戻し', APPROVED: '承認済み' }
```

Authoritative copy is in `server/schema.ts`. The frontend has a fallback
copy in `app.js` and overwrites it at startup via the `getConfig` action so
renaming a status in one place propagates after deploy.

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

`client/js/strings.js` is the single place for user-facing copy on the
frontend; `server/messages.ts` (`MSG`) is the equivalent on the server.
Two channels on the client:

1. **Static HTML** uses `data-i18n="key"` (text content) or
   `data-i18n-attr-<attr>="key"` (any attribute, e.g. `aria-label`,
   `placeholder`). `applyI18n()` runs once at startup and substitutes them.
2. **Dynamic JS strings** call `tr('key', { vars })`, where `{vars}` interpolates
   `{name}`-style placeholders.

Server-side, `fmt(MSG.someKey, { vars })` does the same `{name}` interpolation.

To support a second language: keep `strings.js` as a default and add e.g.
`strings.en.js`; pick one based on `localStorage` or `navigator.language`.

Sheet column headers and status values are intentionally left in Japanese in
the schema, because the spreadsheet is the parent-facing source of truth.

## Code map

### Worker (`server/`)

- `index.ts` — `fetch` handler. Routes `POST /api` to `dispatch()`, everything
  else to the static `ASSETS` binding. Catches `HttpError` and converts to JSON.
- `actions.ts` — `ACTIONS` table and the seven handlers
  (`getConfig`, `getData`, `verifyPassword`, `applyTask`, `approveTask`,
  `rejectTask`, `cashout`).
- `api.ts` — Sheets API + JWT-based access token issuance via Web Crypto
  (`crypto.subtle.sign` with RS256). Also `casTaskStatus` (the optimistic-lock
  primitive) and the row shaping for the frontend.
- `config.ts` — `fetchConfig` reads runtime config (`PARENT_PASSWORD`, `USERS`)
  from `env`. Synchronous; the parsed `USERS` JSON is cached per isolate.
  `checkPassword` is the only auth gate.
- `schema.ts` — column indexes, status values, sheet name prefixes.
- `notify.ts` — LINE broadcast (best effort; never breaks the user flow).
- `messages.ts` — server-side `MSG` catalog and `fmt()` helper.
- `util.ts` — `HttpError`, `constantTimeEqual`, b64url, date helpers,
  `isExpired` (Asia/Tokyo).

### Frontend (`client/js/app.js`)

- `STATUS` / `STRINGS` — bootstrapped fallbacks. Real values come from server.
- `tr()` / `applyI18n()` — translation helpers.
- `store.*` — `localStorage` accessors.
- `state` — in-memory state for the running session.
- `api(action, payload)` — single entry point for Worker calls. Posts to
  `/api` (relative; same origin as the SPA).
- `render*` — pure view layer; no network or mutation.
- `taskItemHtml(t)` — task row template; XSS-escapes via `escapeHtml`.
- `bootstrap()` — startup. Reads localStorage, pulls the user roster via
  `refreshServerConfig`, applies any user-switch deep-link, then loads data
  and handles parent-mode auto-login from a LINE link.
- `refreshServerConfig()` — pulls `STATUS` and the `USERS` roster from the
  Worker. The roster is authoritative: the client mirrors it into
  `state.serverUsers` and falls back to the active user being the first listed
  key if the previously selected key is no longer in the list.
- `labelOf(key)` — resolve a sheet-name key to the display label from
  `state.serverUsers`. Falls back to the key itself when no roster is loaded.

## Adding a new action — checklist

1. **Worker** — add to `ACTIONS` in `actions.ts`:
   ```ts
   newAction: {
     requireUser: true,
     handler: async (req, env, origin) =>
       handleNewAction(env, req.user as string, req.foo),
   },
   ```
2. **Worker** — implement `handleNewAction(env, user, foo)`. Use
   `casTaskStatus` for any task-row state transition; throw `HttpError` on
   bad input — `index.ts` packages errors as `{ ok: false, error: '...' }`.
3. **Frontend** — call `await api('newAction', { foo })`.
4. **Strings** — add new server messages to `server/messages.ts`,
   client strings to `client/js/strings.js`.
5. **Deploy** (`npm run deploy`).

## Local development

```bash
npm install
npm run dev          # wrangler dev — local Worker on http://localhost:8787
```

`wrangler dev` serves both the API and the static assets in `client/`. Secrets
from `wrangler secret put` are available locally too. There is no separate
preview server for the SPA.

The Worker hits the *real* Sheets API regardless of where it runs — write to a
separate "dev" spreadsheet (a different `SHEET_ID` secret) if you need to test
destructive flows. Switch via `wrangler secret put SHEET_ID` in a dev
environment, or use `wrangler.jsonc` env stanzas if you set up multiple.

## Deploy

```bash
npm run deploy
# → wrangler deploy → published to https://lesapay.<account>.workers.dev/
```

The Worker URL stays the same across deploys; the SPA shell, the JS, and the
API are all updated atomically.

### Required secrets

Set once with `wrangler secret put <NAME>`. See the table in the [Runtime
config](#runtime-config-wrangler-secrets) section above for the full list.
Required at minimum: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `SHEET_ID`,
`ACCESS_TOKEN`, `PARENT_PASSWORD`, `USERS`. `LINE_TOKEN` is optional.

The Service Account must be granted **Editor** access to the spreadsheet (share
the sheet with `client_email`).

### Required spreadsheet content

| Sheet              | Notes |
| ------------------ | ----- |
| `課題_<user>`      | One per child. Headers in row 1 must match `TASK_SCHEMA`. |
| `履歴_<user>`      | One per child. Headers in row 1 must match `HISTORY_SCHEMA`. |

There is no longer a `設定` sheet — runtime config moved to wrangler secrets.

### OAuth scope

The Service Account requests a single scope at runtime (`api.ts` `SCOPE`):
`https://www.googleapis.com/auth/spreadsheets`. No consent screen is involved
because the Service Account itself owns its delegation.

## Security model (and its limits)

- The Worker URL is publicly reachable. Anyone who learns the URL can call
  `getData` / `applyTask` for any user.
- `approveTask` / `rejectTask` / `cashout` require `PARENT_PASSWORD` verified
  by the Worker (`checkPassword`, constant-time compare).
- The frontend stores the verified password in `localStorage` after a
  successful login. This effectively turns the device into a "parent device"
  for the parent-mode auto-login from LINE notifications.
- Secrets (`GOOGLE_PRIVATE_KEY`, etc.) live only in `wrangler secret`-managed
  storage on Cloudflare; they are never sent to the browser.
- We accept the residual risks (siblings inspecting `localStorage`, an
  attacker discovering the URL) for a small family-internal app. If wider
  exposure becomes a concern, add a server-side family token gate to every
  action.

## Things that intentionally aren't here

- No Service Worker / offline caching. Adding one would conflict with the
  "always show the latest deploy" behaviour we want during active development.
- No bundler for the frontend. The Worker serves `client/` as-is. Adding
  bundling trades simplicity for marginal performance — avoid until needed.
- No automated tests. The behaviour surface is small enough to verify manually
  per change. `npx tsc --noEmit` is the only static check; `wrangler deploy`
  also runs a build that surfaces the same errors.

## Reviewer notes

When reviewing a PR, the things most likely to be wrong:

1. A new sheet column was added but read code still uses the old width
   (`TASK_COL_COUNT` should propagate; double-check any range string like
   `${tasksSheet}!A2:${TASK_LAST_COL_LETTER}` and the `shapeTasks` mapper).
2. A new state was added but only some of the comparison sites were updated.
   Search for `STATUS.` in both `server/` and `client/js/app.js`.
3. A new UI string was added but only added to `strings.js`, not actually
   referenced via `tr(...)` (or vice versa). Server-side, the equivalent slip
   is referencing a `MSG.x` key that doesn't exist.
4. A new action was added but `requireUser` was set wrong (most actions need
   `true`; `getConfig` and `verifyPassword` are the exceptions).
5. A handler mutates a task without going through `casTaskStatus`. Without
   it, two concurrent requests can both pass the read-side validation and
   produce a lost update.
6. New side effects added on the frontend instead of in the Worker. Move them.
7. The user roster is server-managed via the `USERS` wrangler secret (JSON).
   If you find code that adds or deletes users from the client side, that is
   a regression — the roster is intentionally read-only on the frontend.

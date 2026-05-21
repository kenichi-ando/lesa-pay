# LesserPay architecture

This is the developer-facing companion to `README.md`. The README covers
"how to set up and run LesserPay for your family" (in Japanese, since the
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
│  - Service Worker  │                   │  - Web Push (VAPID)  │
│    for Web Push    │                   │                      │
└────────────────────┘                   └──────────────────────┘
        ▲                                  │           │
        │  Worker also serves              ▼           ▼
        │  static assets from client/   ┌─────────────┐  ┌──────────────┐
        │                               │  Google     │  │  Web Push    │
        ▲                               │  Spreadsheet│  │  endpoints   │
        │  encrypted push payload       │  per-child  │  │  (FCM / APNs │
        │  (RFC 8291 aes128gcm)         │  + push     │  │   /Mozilla)  │
        └───────────────────────────────│  subs       │  └──────────────┘
                                        └─────────────┘
```

- The browser is **untrusted**. A child can open DevTools and replay any HTTP request.
- Therefore *all* state-transition checks (only APPLIED can be approved, only
  PENDING/RETURNED can submit, balance must be sufficient, etc.) live in the
  Worker.
- The frontend's only job is to render and to forward user intents.
- API and SPA share the same origin: the Worker matches `/api` first, and falls
  through to the static-assets binding (`client/`) for everything else.
  This is set up in `wrangler.jsonc` via `assets.run_worker_first`.

## Repository layout

```
lesser-pay/
├── server/                # Cloudflare Worker (TypeScript)
│   ├── index.ts           # Top-level fetch handler + dispatch
│   ├── actions.ts         # ACTIONS table + handlers
│   ├── api.ts             # Sheets API v4 + Service Account JWT
│   ├── config.ts          # wrangler secrets → Config object
│   ├── schema.ts          # Sheet schema (TASK_SCHEMA, STATUS, etc.)
│   ├── messages.ts        # MSG catalog + fmt() template helper
│   ├── notify.ts          # Notification fan-out (delegates to push.ts)
│   ├── push.ts            # Web Push: VAPID JWT + RFC 8291 aes128gcm encryption
│   ├── env.ts             # Env bindings interface
│   └── util.ts            # HttpError, encoding, date helpers
├── client/                # Served by the same Worker via assets binding
│   ├── index.html
│   ├── css/style.css
│   ├── icons/*            # PNG (favicons/app icons) + optional SVG assets
│   ├── manifest.webmanifest
│   ├── sw.js              # Service Worker: push handler + badge counter
│   └── js/
│       ├── config.js                  # localStorage keys (no personal data)
│       ├── strings.js                 # All user-facing UI strings (i18n)
│       ├── app-i18n.js                # tr() / applyI18n()
│       ├── app-store.js               # localStorage accessors
│       ├── app-utils.js               # formatting / escaping helpers
│       ├── app-render.js              # pure rendering layer
│       ├── app-controller-data.js     # api(), bootstrap(), loadData()
│       ├── app-controller-actions.js  # task actions / cashout / toast
│       ├── app-controller.js          # user selection + parent-mode orchestration
│       └── app.js                     # wiring + event listeners only
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
    handler: async (req, env) =>
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
| `lesserpay_user`          | Currently selected sheet-name suffix (a key into the `USERS` roster) |
| `lesserpay_parent_pin`    | Last successful parent PIN — kept so a returning device can re-enter parent mode without retyping it |
| `lesserpay_parent_mode`   | `"1"` while the current session is acting as a parent device |
| `lesserpay_api_token`     | Long bearer token (`API_TOKEN` secret, ~256 bits) returned by `redeemInvite` after the user types the short `INVITE_CODE` once. Sent on every `/api` call as `Authorization: Bearer …`. Cleared on 401 (server-side rotation forces re-redeem). |
| `lesserpay_push_prompt_dismissed` | `"1"` once the user has dismissed the "enable notifications" prompt for this device |

Tasks and history are *not* cached across reloads. The user roster itself is
*not* persisted in the browser — it is fetched from the Worker via `getConfig`
on every boot. Roster changes therefore require a `wrangler secret put USERS`
+ `npm run deploy`; client-side changes alone are not enough. There is no API
URL stored either: the SPA and `/api` are co-hosted, so the frontend just
calls a relative `/api`.

### 4. Side effects (notifications, etc.) belong on the server.

Web Push fan-out is invoked from `server/notify.ts` (which delegates to
`push.ts`). The frontend must never call external APIs directly. If a future
feature needs a webhook, add an action and let the Worker make the outbound
request.

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
VAPID keys) lives in `wrangler secret`-managed env vars and is read by
`server/config.ts` / `server/push.ts`.

The Worker reads sheet ranges from `A2:` down, so **row 1 (the header) is
ignored** — label it however you want in the spreadsheet UI. The constants
below define column ORDER and the values written into the STATUS column;
nothing else.

### Task sheet (`Tasks_<user>`)

Defined by `TASK_SCHEMA`. `TASK_COL`, `TASK_COL_COUNT`, `TASK_LAST_COL_LETTER`
are derived from it.

| Index | Key                | Notes |
| ----: | ------------------ | ----- |
| 0     | `ID`               | Auto-generated on read if blank (`T<unix>_<rand>`) |
| 1     | `STATUS`           | `STATUS.PENDING` / `SUBMITTED` / `RETURNED` / `APPROVED`. Blank = `PENDING`. |
| 2     | `CATEGORY`         | Used as the group heading in the UI. Empty rows fall under `tasks.otherGroup`. |
| 3     | `TITLE`            | Required |
| 4     | `SUBMIT_REWARD`    | Granted on the *first* submit only |
| 5     | `COMPLETE_REWARD`  | Granted when the parent approves |
| 6     | `MINUTES`          | Estimated minutes; display only |
| 7     | `EXPIRY`           | YYYY/MM/DD; tasks past expiry can't be applied |

To add a column: append a key to `TASK_SCHEMA`. Everything else updates
automatically.

### History sheet (`History_<user>`)

| Index | Key       | Notes |
| ----: | --------- | ----- |
| 0     | `DATE`    | `yyyy/MM/dd HH:mm` |
| 1     | `CONTENT` | Free-form, emoji-prefixed string set by the Worker. Format is `"<emoji> <category> <title>"` for task events (e.g. `"✅ Chores Wash dishes"`, `"📩 Study Spelling drill"`, `"↩️ Study Spelling drill"` for withdrawals), `HISTORY_LABEL.CASHOUT` for cashouts, and `"🎁 <free-form label>"` for parent-granted bonuses (no associated task row). The catalogue of prefixes lives in `schema.ts` `HISTORY_LABEL`. |
| 2     | `POINTS`  | Positive (reward) or negative (cashout) |

### Runtime config (wrangler secrets)

All runtime knobs are wrangler secrets, read from `env` by `fetchConfig()`.
There is no spreadsheet round-trip on parent actions — `checkPin()` is
synchronous. Changes require `wrangler secret put …` + `npm run deploy`.

| Secret             | Required | Notes |
| ------------------ | :------: | ----- |
| `GOOGLE_CLIENT_EMAIL` | ✅   | Service Account email for Sheets API. |
| `GOOGLE_PRIVATE_KEY`  | ✅   | Service Account private key (PEM). |
| `GOOGLE_SHEET_ID`            | ✅   | Target spreadsheet (one per family). |
| `INVITE_CODE`         | ✅   | 6-char `[A-Z0-9]` invitation code. Used only by the `redeemInvite` action: the SPA submits it once on the locked screen, the Worker verifies it with `constantTimeEqual` and returns `API_TOKEN`. Never sent again. |
| `API_TOKEN`           | ✅   | Long opaque bearer token (~256 bits) returned by `redeemInvite`. Sent as `Authorization: Bearer …` on every other `/api` call. Verified with `constantTimeEqual`. |
| `PARENT_PIN`          | ✅   | Parent-mode PIN. Verified on approve / reject / cashout. |
| `USERS`               | ✅   | Comma-separated `key:label` pairs. `key` is the sheet-name suffix (`Tasks_<key>` / `History_<key>`); `label` is an optional display name (defaults to `key`). |
| `PUSH_VAPID_PUBLIC_KEY`  | ⬜ | VAPID public key (P-256 uncompressed point, base64url). Push is skipped if unset. |
| `PUSH_VAPID_PRIVATE_KEY` | ⬜ | VAPID private key (`d` JWK component, base64url). Required if public key is set. |
| `PUSH_SUBJECT`           | ⬜ | Contact identifier in the VAPID JWT `sub` claim. `mailto:you@yourdomain.com` style. APNs rejects clearly fake values. |

`USERS` example:

```
Light:ライト, Tiara:ティアラ
```

The parsed list is cached per Worker isolate, so successive requests don't
re-parse the secret on every call.

### Status values

```ts
STATUS = { PENDING: 'Pending', SUBMITTED: 'Submitted', RETURNED: 'Returned', APPROVED: 'Approved' }
```

Authoritative copy is in `server/schema.ts`. The frontend `STATUS` is empty
at module load and gets populated from the `getConfig` response inside
`bootstrap()`, before any rendering runs — so renaming a status on the server
propagates after deploy without a matching client change.

State transitions:

```
PENDING ─[applyTask, +submitReward]─▶ SUBMITTED ─[approveTask, +completeReward]─▶ APPROVED
   ▲                                     │
   │                                     ├─[rejectTask]─▶ RETURNED
   │                                     │                    │
   │                                     │                    └─[applyTask, no submit reward]─▶ SUBMITTED
   │                                     │
   └─[withdrawTask, -submitReward]───────┘   (child cancels their own submission)
```

Approved is terminal. Rejecting an already-approved task is forbidden (avoids
double payout). Withdrawal is the *child's* counterpart to reject: it's only
valid from `SUBMITTED` and lands back in `PENDING` with a compensating history
row (`-submitReward`, or `0` if none was paid). Re-submitting after a withdraw
therefore pays the submit reward again — the +/- entries cancel out, so the
balance stays consistent regardless of how many times the child toggles.
Returned (parent-driven) and withdrawn (child-driven) intentionally land in
*different* states so the spreadsheet timeline stays distinguishable.

## Web Push

Push is the only notification channel. There is no email/LINE/SMS fallback.

### Subscription lifecycle

1. The browser registers `client/sw.js` (`navigator.serviceWorker.register`).
2. User taps the bell button — `Notification.requestPermission()` then
   `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
3. The frontend POSTs `subscribePush` with the `endpoint` / `p256dh` / `auth`
   to the Worker, which writes them to the `PushSubscriptions` sheet.
4. To send a notification the Worker iterates rows that match the target role
   (`child` / `parent`), encrypts the payload per RFC 8291, signs a per-endpoint
   VAPID JWT (`ES256`, `aud = origin of endpoint`, ~1h expiry), and POSTs to
   the endpoint with `Authorization: vapid t=…, k=…` and
   `Content-Encoding: aes128gcm`.
5. 404 / 410 responses prune the row automatically. Other 4xx/5xx are logged
   and skipped — never break the user-visible flow.

### Payload encryption (RFC 8291)

`encryptPayload` in `push.ts` does the standard dance:

```
ephemeral ECDH P-256 keypair (AS) ↔ subscription public key (UA)
  → ecdh_secret (32 bytes)
prk_key  = HMAC-SHA-256(auth_secret, ecdh_secret)
ikm      = HKDF-Expand(prk_key, "WebPush: info\0" || ua_pub || as_pub, 32)
salt     = random(16)
prk      = HMAC-SHA-256(salt, ikm)
cek      = HKDF-Expand(prk, "Content-Encoding: aes128gcm\0", 16)
nonce    = HKDF-Expand(prk, "Content-Encoding: nonce\0",     12)
ciphertext = AES-128-GCM(cek, nonce, plaintext || 0x02)
body = salt || rs(=4096, BE u32) || idlen(=65) || as_pub || ciphertext
```

We send a single record (no chunking). Plaintext is `JSON.stringify({title,
body})`; the SW reads both fields. Without payload encryption, iOS / APNs
silently drop the push (no `push` event, no badge update) — Chrome/FCM still
fires the event with empty data, which is what made this regression invisible
in PC testing for a while.

### Service Worker

`client/sw.js` is intentionally minimal:

- `push` handler decodes the JSON payload, calls `showNotification(title,
  {body, icon, badge, tag, renotify})`, and increments a badge counter
  persisted in IndexedDB (DB `lesserpay-badge`, store `kv`, key `count`).
  IndexedDB is required because SW global state is not durable and the
  Badging API has no `getAppBadge()`.
- `message` handler accepts `{type: 'clearBadge'}` from the page to reset the
  counter and call `navigator.clearAppBadge()`.
- `notificationclick` focuses an existing client window (or opens `/`),
  clearing the badge as a side effect.

`client/js/app.js` posts `clearBadge` whenever the document becomes visible,
giving "open the app → badge disappears" UX.

### `PushSubscriptions` sheet

Auto-created on first send. Columns: `endpoint, p256dh, auth, user, role,
createdAt, updatedAt`. Capped at `MAX_PUSH_SUBSCRIPTIONS` (50) rows; rows
that 404/410 are cleared (cells emptied) but the row index remains so the
range geometry stays stable.

Re-keying VAPID requires deleting old rows: subscriptions remember the
public key they were created with, and the push services reject sends
signed by a mismatched key (`VapidPkHashMismatch` / `VAPID public key
mismatch`).

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

System-internal identifiers (sheet name prefixes, STATUS values, schema keys)
are English; user-visible copy lives in `strings.js` / `messages.ts`. The
spreadsheet's row 1 (header) is ignored by the Worker, so families can label
columns in whatever language they prefer without affecting behaviour.

## Code map

### Worker (`server/`)

- `index.ts` — `fetch` handler. Routes `POST /api` to `dispatch()`, everything
  else to the static `ASSETS` binding. Catches `HttpError` and converts to JSON.
- `actions.ts` — `ACTIONS` table and the handlers
  (`getConfig`, `getData`, `verifyPin`, `applyTask`, `approveTask`,
  `rejectTask`, `withdrawTask`, `cashout`, `grantBonus`, `subscribePush`, `unsubscribePush`).
  `grantBonus` is parent-only (PIN-protected) and writes a single `🎁 <label>`
  history row without going through the task approval flow — there is no
  `Tasks_` row for bonuses.
- `api.ts` — Sheets API + JWT-based access token issuance via Web Crypto
  (`crypto.subtle.sign` with RS256). Also `casTaskStatus` (the optimistic-lock
  primitive) and the row shaping for the frontend.
- `config.ts` — `fetchConfig` reads runtime config (`PARENT_PIN`, `USERS`)
  from `env`. Synchronous; the parsed `USERS` JSON is cached per isolate.
  `checkPin` is the only auth gate.
- `schema.ts` — column indexes, status values, sheet name prefixes.
- `notify.ts` — Notification fan-out (delegates to `push.ts`). Best effort;
  never breaks the user flow.
- `push.ts` — Web Push: VAPID JWT signing, RFC 8291 (aes128gcm) payload
  encryption, subscription storage in the `PushSubscriptions` sheet, automatic
  pruning of expired endpoints (404/410).
- `messages.ts` — server-side `MSG` catalog and `fmt()` helper.
- `util.ts` — `HttpError`, `constantTimeEqual`, b64url, date helpers,
  `isExpired` (Asia/Tokyo).

### Frontend (`client/js/*.js`)

- `app.js` — bootstraps the app, wires dependencies, defines shared `state`,
  and attaches DOM event listeners.
- `app-i18n.js` — `tr()` and `applyI18n()` implementation.
- `app-store.js` — browser persistence (`lesserpay_user`, `lesserpay_parent_pin`,
  `lesserpay_api_token`).
- `app-utils.js` — `escapeHtml`, date parsing/formatting, expired checks,
  and minutes formatting.
- `app-render.js` — pure render layer (`render()`, `renderTabs()`, task/history
  templates). No network calls.
- `app-controller-data.js` — API wrapper (`api()`), boot flow (`bootstrap()`),
  config refresh, cache-aware `loadData()`, and locked-screen rendering.
- `app-controller-actions.js` — mutation-side UI actions (`apply/approve/reject`,
  `cashout`, `grantBonus`) plus `toast()`.
- `app-controller.js` — orchestration for user selection popover, parent-login
  modal flow, parent-mode-aware user switching, and coordination across the
  data/actions modules.

## Adding a new action — checklist

1. **Worker** — add to `ACTIONS` in `actions.ts`:
   ```ts
   newAction: {
     requireUser: true,
     handler: async (req, env) =>
       handleNewAction(env, req.user as string, req.foo),
   },
   ```
   The dispatcher in `index.ts` enforces `Authorization: Bearer <API_TOKEN>`
   before any handler runs, so every new action is automatically gated — no
   per-action work needed for that. (`redeemInvite` is the sole exception
   handled inline in the dispatcher, since it issues the token.) Parent-only
   actions additionally call `checkPin(env, req.password)` inside the handler
   (see `approveTask` / `cashout`).
2. **Worker** — implement `handleNewAction(env, user, foo)`. Use
   `casTaskStatus` for any task-row state transition; throw `HttpError` on
   bad input — `index.ts` packages errors as `{ ok: false, error: '...' }`.
3. **Frontend** — call `await api('newAction', { foo })`. The client's `api()`
   wrapper attaches the `Authorization: Bearer <token>` header automatically.
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
separate "dev" spreadsheet (a different `GOOGLE_SHEET_ID` secret) if you need to test
destructive flows. Switch via `wrangler secret put GOOGLE_SHEET_ID` in a dev
environment, or use `wrangler.jsonc` env stanzas if you set up multiple.

## Deploy

```bash
npm run deploy
# → wrangler deploy → published to https://<worker-name>.<account>.workers.dev/
```

`<worker-name>` is the `name` field in `wrangler.jsonc`; `<account>` is your
Cloudflare account subdomain. The actual URL prints at the end of the deploy
output and is also visible in the Cloudflare dashboard under Workers & Pages.

The Worker URL stays the same across deploys; the SPA shell, the JS, and the
API are all updated atomically.

### Required secrets

Set once with `wrangler secret put <NAME>`. See the table in the [Runtime
config](#runtime-config-wrangler-secrets) section above for the full list.
Required at minimum: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID`,
`INVITE_CODE`, `API_TOKEN`, `PARENT_PIN`, `USERS`. `PUSH_VAPID_PUBLIC_KEY` /
`PUSH_VAPID_PRIVATE_KEY` / `PUSH_SUBJECT` are optional (omit them and Web
Push is silently disabled).

The Service Account must be granted **Editor** access to the spreadsheet (share
the sheet with `client_email`).

### Required spreadsheet content

| Sheet              | Notes |
| ------------------ | ----- |
| `Tasks_<user>`     | One per child. Column ORDER must match `TASK_SCHEMA`; row 1 headers are ignored. |
| `History_<user>`   | One per child. Column ORDER must match `HISTORY_SCHEMA`; row 1 headers are ignored. |

Runtime config lives in `wrangler secret`s; there is no config sheet.

### OAuth scope

The Service Account requests a single scope at runtime (`api.ts` `SCOPE`):
`https://www.googleapis.com/auth/spreadsheets`. No consent screen is involved
because the Service Account itself owns its delegation.

## Security model (and its limits)

- **Two-layer auth: short `INVITE_CODE` + long `API_TOKEN`.** Family members
  type a 6-char `[A-Z0-9]` invitation code into the locked screen exactly
  once. The SPA submits it via the `redeemInvite` action; on a constant-time
  match the Worker returns the long-lived `API_TOKEN` (~256 bits). All other
  `/api` calls require `Authorization: Bearer <API_TOKEN>` — the short code
  is never reused for API gating.
- This split lets the human-typed secret stay short (6 chars / ~31 bits) while
  the actual API gate is sized so that brute force is infeasible without rate
  limiting. A 6-char invite code alone (≈2.18×10⁹ space) is reachable in
  weeks at high request rates, but the only thing an attacker gets by guessing
  it is the chance to redeem one `API_TOKEN`. Combined with normal Cloudflare
  edge rate-limiting against the Worker, family-internal use is acceptable.
- The invitation code is typed once and never persisted client-side; only the
  `API_TOKEN` is stored in `localStorage`. Neither value ever appears in the
  URL, so screenshots, browser history, and screen-share streams don't leak
  them. Push notifications carry only the title and body.
- Rotation:
  - **Invite-only rotation**: `wrangler secret put INVITE_CODE` + redeploy.
    Existing family devices keep their `API_TOKEN`, so they're unaffected;
    new joiners use the new code.
  - **Full rotation**: also `wrangler secret put API_TOKEN` + redeploy. Every
    device's stored token starts returning 401, the SPA falls back to the
    locked screen, and family members must re-redeem with the (possibly new)
    invitation code.
- `approveTask` / `rejectTask` / `cashout` / `grantBonus` additionally require
  `PARENT_PIN` verified by the Worker (`checkPin`, constant-time compare).
- The frontend stores the verified PIN in `localStorage` after a
  successful login. This effectively turns the device into a "parent device"
  for parent-mode auto-login on subsequent visits.
- Push payloads are encrypted per RFC 8291 (ECDH P-256 + HKDF + AES-128-GCM)
  with a fresh ephemeral key per send. The body never reaches FCM/APNs/Mozilla
  in plaintext, even though the transport itself is TLS to those operators.
- Secrets (`GOOGLE_PRIVATE_KEY`, `INVITE_CODE`, `API_TOKEN`, etc.) live only
  in `wrangler secret`-managed storage on Cloudflare. The `API_TOKEN` is sent
  to the browser exactly once — as the response to a successful `redeemInvite`
  — and never re-issued; everything else stays server-side.
- We accept the residual risks (siblings inspecting `localStorage`, the
  invitation code leaking inside the family) for a small family-internal app.
  Rotation is described above (invite-only vs full rotation).

## Things that intentionally aren't here

- No offline caching in the Service Worker. `client/sw.js` exists *only* for
  Web Push and the badge counter — it has no `fetch` handler, so the page
  always loads from the network and "always show the latest deploy" still
  holds.
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
   Search for `STATUS.` in both `server/` and `client/js/`.
3. A new UI string was added but only added to `strings.js`, not actually
   referenced via `tr(...)` (or vice versa). Server-side, the equivalent slip
   is referencing a `MSG.x` key that doesn't exist.
4. A new action was added but `requireUser` was set wrong (most actions need
   `true`; `getConfig` and `verifyPin` are the exceptions).
5. A handler mutates a task without going through `casTaskStatus`. Without
   it, two concurrent requests can both pass the read-side validation and
   produce a lost update.
6. New side effects added on the frontend instead of in the Worker. Move them.
7. The user roster is server-managed via the `USERS` wrangler secret (JSON).
   If you find code that adds or deletes users from the client side, that is
   a regression — the roster is intentionally read-only on the frontend.
8. Push regressions: any change to `sendWebPush` that drops the body or the
   `Content-Encoding: aes128gcm` header will silently break iOS while leaving
   Chrome working. If you touch `push.ts`, verify with `wrangler tail` that
   sends to `web.push.apple.com` return `201`.

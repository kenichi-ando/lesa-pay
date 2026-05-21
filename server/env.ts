/**
 * Cloudflare Worker bindings.
 *
 * Secrets are set via `wrangler secret put <KEY>`. ASSETS is provided
 * automatically by the static-assets binding declared in wrangler.jsonc.
 */
export interface Env {
	// Google Sheets service account credentials.
	GOOGLE_CLIENT_EMAIL: string;
	GOOGLE_PRIVATE_KEY: string;
	// Target spreadsheet (one per family).
	GOOGLE_SHEET_ID: string;
	// Shared invitation code (6-char [A-Z0-9]). Family members type this once
	// into the locked screen; the server exchanges it for API_TOKEN.
	INVITE_CODE: string;
	// Long random bearer token (43-char [A-Za-z0-9_-], 256 bits) used as
	// Authorization: Bearer on every /api call. Returned by the redeemInvite
	// action and persisted by the SPA in localStorage.
	API_TOKEN: string;
	// Parent-mode PIN (verified on approve / reject / cashout).
	PARENT_PIN: string;
	// JSON array of {key,label} for the user roster, e.g.
	//   '[{"key":"Light","label":"ライト"},{"key":"Tiara","label":"ティアラ"}]'
	USERS: string;
	// Optional: VAPID key pair for Web Push (PWA notifications).
	// Unset → push notifications are skipped.
	PUSH_VAPID_PUBLIC_KEY?: string;
	PUSH_VAPID_PRIVATE_KEY?: string;
	// Optional: contact URL in VAPID JWT `sub` claim.
	// Example: "mailto:you@example.com"
	PUSH_SUBJECT?: string;
	// Optional: when truthy, appends a "Debug User" to the USERS roster and
	// suppresses parent-targeted push notifications for that user. Lets you
	// exercise the app without touching real children's data or notifying the
	// parent device(s). "0" / "false" / "no" / "off" / "" / unset → off.
	DEBUG?: string;
	ASSETS: Fetcher;
}

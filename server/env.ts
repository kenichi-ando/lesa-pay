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
	// Shared invitation code gating /api.
	INVITE_CODE: string;
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
	ASSETS: Fetcher;
}

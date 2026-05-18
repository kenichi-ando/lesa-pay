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
	SHEET_ID: string;
	// Shared invitation token gating /api.
	ACCESS_TOKEN: string;
	// Parent-mode password (verified on approve / reject / cashout).
	PARENT_PASSWORD: string;
	// JSON array of {key,label} for the child roster, e.g.
	//   '[{"key":"Light","label":"ライト"},{"key":"Tiara","label":"ティアラ"}]'
	USERS: string;
	// Optional: LINE Messaging API channel access token (long-lived).
	// Unset → notifications are skipped, the app still works.
	LINE_TOKEN?: string;
	ASSETS: Fetcher;
}

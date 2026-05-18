/**
 * Cloudflare Worker bindings.
 *
 * Secrets are set via `wrangler secret put <KEY>`. ASSETS is provided
 * automatically by the static-assets binding declared in wrangler.jsonc.
 */
export interface Env {
	GOOGLE_CLIENT_EMAIL: string;
	GOOGLE_PRIVATE_KEY: string;
	SHEET_ID: string;
	ACCESS_TOKEN: string;
	ASSETS: Fetcher;
}

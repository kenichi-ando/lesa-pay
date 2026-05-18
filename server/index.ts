/**
 * LesaPay API (Cloudflare Worker).
 *
 * Reads and writes a Google Spreadsheet via Sheets API v4 using a service
 * account. The same Worker also serves the SPA from `public/` via the
 * static-assets binding, so frontend and API live on a single origin.
 *
 * Single dispatch endpoint:
 *   POST /api      body={action, ...}
 *
 * Anything else falls through to the static-assets binding.
 */

import { ACTIONS, type ActionRequest } from "./actions";
import type { Env } from "./env";
import { HttpError, constantTimeEqual, isValidUser } from "./util";

export type { Env };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		try {
			if (url.pathname === "/api" && req.method === "POST") {
				if (!authorized(req, env)) {
					return json({ ok: false, error: "Unauthorized" }, 401);
				}
				return await dispatch(req, env);
			}
			// Anything else is a static asset (SPA shell, JS, CSS, icons, etc.).
			return env.ASSETS.fetch(req);
		} catch (e: unknown) {
			if (e instanceof HttpError) {
				return json({ ok: false, error: e.message }, e.status);
			}
			const err = e as Error;
			console.error("Unhandled error:", err.stack ?? err.message);
			return json({ ok: false, error: err.message }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function dispatch(req: Request, env: Env): Promise<Response> {
	let body: ActionRequest;
	try {
		const text = await req.text();
		body = JSON.parse(text);
	} catch {
		return json({ ok: false, error: "Invalid JSON body" }, 400);
	}

	const def = body.action ? ACTIONS[body.action] : undefined;
	if (!def) {
		return json({ ok: false, error: `Unsupported action: ${body.action}` }, 400);
	}
	if (def.requireUser && !isValidUser(body.user)) {
		return json({ ok: false, error: `Invalid user: ${body.user}` }, 400);
	}

	// origin (e.g. https://lesapay.rp0.workers.dev) is used by handlers that
	// embed a deep link in LINE notifications. Trustworthy on Cloudflare —
	// `req.url` reflects the edge host, not a Host header from the client.
	const origin = new URL(req.url).origin;
	const result = await def.handler(body, env, origin);
	return json({ ok: true, ...(result as object) });
}

// Gate /api with the shared ACCESS_TOKEN secret. The token is delivered to the
// browser once via an invitation URL (?k=<token>), persisted in localStorage,
// and sent on every /api call as Authorization: Bearer <token>. Without it,
// the static SPA still loads — but no spreadsheet data is ever exposed.
function authorized(req: Request, env: Env): boolean {
	if (!env.ACCESS_TOKEN) return false;
	const header = req.headers.get("Authorization") ?? "";
	const m = header.match(/^Bearer\s+(.+)$/i);
	if (!m) return false;
	return constantTimeEqual(m[1], env.ACCESS_TOKEN);
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Access-Control-Max-Age": "86400",
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			...corsHeaders(),
		},
	});
}

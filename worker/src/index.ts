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
import { HttpError, isValidUser } from "./util";

export type { Env };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		try {
			if (url.pathname === "/api" && req.method === "POST") {
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

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
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

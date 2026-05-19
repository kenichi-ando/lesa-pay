/**
 * LesserPay API (Cloudflare Worker).
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
const INVITE_CODE_PATTERN = /^[A-Z0-9]{6}$/;
// API_TOKEN: opaque bearer token. We only length-bound it to reject pathological
// inputs; format is otherwise unconstrained.
const API_TOKEN_MIN_LENGTH = 16;
const API_TOKEN_MAX_LENGTH = 128;

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

	// `redeemInvite` is the only action that runs without API_TOKEN. Everything
	// else requires Authorization: Bearer <API_TOKEN>.
	if (body.action === "redeemInvite") {
		const code = typeof body.code === "string" ? body.code : "";
		if (!isValidInviteCode(code)) {
			return json({ ok: false, error: "Invalid invite code" }, 400);
		}
		const expected = env.INVITE_CODE ?? "";
		if (!isValidInviteCode(expected) || !constantTimeEqual(code, expected)) {
			return json({ ok: false, error: "Invalid invite code" }, 401);
		}
		const apiToken = env.API_TOKEN ?? "";
		if (!isValidApiToken(apiToken)) {
			return json({ ok: false, error: "Server misconfigured" }, 500);
		}
		return json({ ok: true, apiToken });
	}

	const def = body.action ? ACTIONS[body.action] : undefined;
	if (!def) {
		return json({ ok: false, error: `Unsupported action: ${body.action}` }, 400);
	}
	if (!authorized(req, env)) {
		return json({ ok: false, error: "Unauthorized" }, 401);
	}
	if (def.requireUser && !isValidUser(body.user)) {
		return json({ ok: false, error: `Invalid user: ${body.user}` }, 400);
	}

	const result = await def.handler(body, env);
	return json({ ok: true, ...(result as object) });
}

// Gate /api with the long-lived API_TOKEN secret. The SPA obtains it once via
// `redeemInvite` (after the user types the short INVITE_CODE) and persists it
// in localStorage. Brute-forcing the API_TOKEN directly is the only attack
// surface left for non-invite-holders, so it's sized for ~256 bits of entropy.
function authorized(req: Request, env: Env): boolean {
	const expected = env.API_TOKEN ?? "";
	if (!isValidApiToken(expected)) return false;
	const header = req.headers.get("Authorization") ?? "";
	const m = /^Bearer\s+(.+)$/i.exec(header);
	if (!m) return false;
	if (!isValidApiToken(m[1])) return false;
	return constantTimeEqual(m[1], expected);
}

function isValidInviteCode(value: string): boolean {
	return INVITE_CODE_PATTERN.test(value);
}

function isValidApiToken(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length >= API_TOKEN_MIN_LENGTH &&
		value.length <= API_TOKEN_MAX_LENGTH
	);
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

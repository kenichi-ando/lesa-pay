/**
 * Runtime config — derived from wrangler secrets, not from a spreadsheet.
 *
 * Everything is set once via `wrangler secret put …`:
 *   - PARENT_PASSWORD: parent-mode password (string)
 *   - USERS:           JSON array of {key,label} for the child roster
 *
 * Changes require a `wrangler secret put` + `npm run deploy`. Family-scale
 * apps don't change the roster often enough for the spreadsheet round-trip
 * to be worth the extra Sheets read on every action.
 */

import type { Env } from "./env";
import { MSG } from "./messages";
import { HttpError, constantTimeEqual } from "./util";

export interface User {
	key: string;
	label: string;
}

export interface Config {
	parentPassword: string;
	users: User[];
}

// Cache the parsed users list per Worker isolate. USERS is a static secret —
// re-parsing on every request would be wasteful, and a stale parse can only
// happen at the next deploy (which restarts the isolate anyway).
let usersCache: { raw: string; parsed: User[] } | null = null;

function parseUsers(raw: string): User[] {
	if (!raw) return [];
	if (usersCache && usersCache.raw === raw) return usersCache.parsed;

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new HttpError(500, "USERS secret is not valid JSON");
	}
	if (!Array.isArray(data)) {
		throw new HttpError(500, "USERS secret must be a JSON array");
	}
	const parsed: User[] = [];
	for (const u of data) {
		if (u && typeof u === "object" && typeof (u as User).key === "string" && (u as User).key) {
			const key = (u as User).key;
			const label = typeof (u as User).label === "string" && (u as User).label ? (u as User).label : key;
			parsed.push({ key, label });
		}
	}
	usersCache = { raw, parsed };
	return parsed;
}

export function fetchConfig(env: Env): Config {
	return {
		parentPassword: env.PARENT_PASSWORD ?? "",
		users: parseUsers(env.USERS ?? ""),
	};
}

// Throws if the password is missing, the server is misconfigured, or the
// supplied password does not match. Used by every parent-only action.
export function checkPassword(env: Env, password: unknown): void {
	if (typeof password !== "string" || password.length === 0) {
		throw new HttpError(400, MSG.errPasswordRequired);
	}
	const cfg = fetchConfig(env);
	if (!cfg.parentPassword) {
		throw new HttpError(500, MSG.errParentPwNotSet);
	}
	if (!constantTimeEqual(password, cfg.parentPassword)) {
		throw new HttpError(401, MSG.errPasswordWrong);
	}
}

export function labelFor(users: User[], userKey: string): string {
	for (const u of users) if (u.key === userKey) return u.label;
	return userKey;
}

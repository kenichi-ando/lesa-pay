/**
 * Runtime config — derived from wrangler secrets, not from a spreadsheet.
 *
 * Everything is set once via `wrangler secret put …`:
 *   - PARENT_PIN: parent-mode PIN (string)
 *   - USERS:      Comma-separated `key:label` pairs, e.g. `Rina:りな, Yurika:ゆりか`.
 *                 `label` is optional (`key` is used when omitted).
 *
 * Family-scale apps don't change the roster often enough for the spreadsheet
 * round-trip to be worth the extra Sheets read on every action.
 */

import type { Env } from "./env";
import { MSG } from "./messages";
import { HttpError, constantTimeEqual } from "./util";

export interface User {
	key: string;
	label: string;
}

export interface Config {
	parentPin: string;
	users: User[];
}

// When env.DEBUG is set, this user is appended to the USERS roster and its
// parent-targeted push notifications are suppressed. Kept English-only on
// purpose — it's an operator-facing test account, not a child.
export const DEBUG_USER_KEY = "Debug";
const DEBUG_USER_LABEL = "Debug User";

// Cache the parsed users list per Worker isolate. USERS is a static secret —
// re-parsing on every request would be wasteful, and a stale parse can only
// happen at the next deploy (which restarts the isolate anyway).
let usersCache: { raw: string; parsed: User[] } | null = null;

function parseUsers(raw: string): User[] {
	if (!raw) return [];
	if (usersCache && usersCache.raw === raw) return usersCache.parsed;

	const parsed: User[] = [];
	for (const entry of raw.split(",")) {
		const [keyPart, ...labelParts] = entry.split(":");
		const key = (keyPart ?? "").trim();
		if (!key) continue;
		const label = labelParts.join(":").trim() || key;
		parsed.push({ key, label });
	}
	usersCache = { raw, parsed };
	return parsed;
}

// "0" / "false" / "no" / "off" / "" → off; anything else → on. Lets you flip
// the flag with `wrangler secret put DEBUG 0` instead of `secret delete`.
function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

export function fetchConfig(env: Env): Config {
	const base = parseUsers(env.USERS ?? "");
	const users =
		isTruthyFlag(env.DEBUG) && !base.some((u) => u.key === DEBUG_USER_KEY)
			? [...base, { key: DEBUG_USER_KEY, label: DEBUG_USER_LABEL }]
			: base;
	return {
		parentPin: env.PARENT_PIN ?? "",
		users,
	};
}

// Throws if the PIN is missing, the server is misconfigured, or the supplied
// PIN does not match. Used by every parent-only action.
export function checkPin(env: Env, pin: unknown): void {
	if (typeof pin !== "string" || pin.length === 0) {
		throw new HttpError(400, MSG.errPinRequired);
	}
	const cfg = fetchConfig(env);
	if (!cfg.parentPin) {
		throw new HttpError(500, MSG.errParentPinNotSet);
	}
	if (!constantTimeEqual(pin, cfg.parentPin)) {
		throw new HttpError(401, MSG.errPinWrong);
	}
}

export function labelFor(users: User[], userKey: string): string {
	for (const u of users) if (u.key === userKey) return u.label;
	return userKey;
}

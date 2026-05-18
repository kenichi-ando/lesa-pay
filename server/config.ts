/**
 * 設定 sheet → in-memory Config object.
 *
 * Single source of truth for runtime knobs that the parent edits without
 * redeploying: APP_URL, PARENT_PASSWORD, LINE_TOKEN, USERS, USER_LABELS.
 */

import type { Env } from "./env";
import { CONFIG_SHEET } from "./schema";
import { getAccessToken } from "./api";
import { MSG } from "./messages";
import { HttpError, constantTimeEqual } from "./util";

export interface Config {
	parentPassword: string;
	lineToken: string;
	users: { key: string; label: string }[];
}

export async function fetchConfig(env: Env): Promise<Config> {
	const token = await getAccessToken(env);
	const range = `${CONFIG_SHEET}!A:Z`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(range)}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new HttpError(502, `Sheets API error: ${res.status} ${await res.text()}`);
	}
	const { values = [] } = (await res.json()) as { values?: string[][] };

	const map = new Map<string, string[]>();
	for (const row of values) {
		const key = row[0];
		if (!key) continue;
		map.set(
			key,
			row.slice(1).filter((v) => v != null && v !== ""),
		);
	}

	const keys = map.get("USERS") ?? [];
	const labels = map.get("USER_LABELS") ?? [];
	const users = keys.map((key, i) => ({ key, label: labels[i] ?? key }));

	return {
		parentPassword: map.get("PARENT_PASSWORD")?.[0] ?? "",
		lineToken: map.get("LINE_TOKEN")?.[0] ?? "",
		users,
	};
}

// Throws if the password is missing, the server is misconfigured, or the
// supplied password does not match. Used by every parent-only action.
export async function checkPassword(env: Env, password: unknown): Promise<void> {
	if (typeof password !== "string" || password.length === 0) {
		throw new HttpError(400, MSG.errPasswordRequired);
	}
	const cfg = await fetchConfig(env);
	if (!cfg.parentPassword) {
		throw new HttpError(500, MSG.errParentPwNotSet);
	}
	if (!constantTimeEqual(password, cfg.parentPassword)) {
		throw new HttpError(401, MSG.errPasswordWrong);
	}
}

export function labelFor(
	users: { key: string; label: string }[],
	userKey: string,
): string {
	for (const u of users) if (u.key === userKey) return u.label;
	return userKey;
}

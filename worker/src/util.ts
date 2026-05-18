/**
 * Small, framework-free helpers. No external dependencies.
 */

// Error type carrying an HTTP status code. Thrown from anywhere; caught by the
// top-level dispatch in index.ts and converted to a JSON response.
export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export function isValidUser(user: unknown): user is string {
	return typeof user === "string" && user.length > 0 && user.length <= 50;
}

export function nonEmpty(v: unknown): boolean {
	return v != null && v !== "";
}

// Constant-time string compare to avoid leaking length-based timing.
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function toNumber(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

// Expiry / date cells: pass through "yyyy/MM/dd" as-is. Sheets returns date
// cells as formatted strings because we request
// dateTimeRenderOption=FORMATTED_STRING when reading.
export function toDateString(v: unknown): string {
	if (v == null || v === "") return "";
	return String(v);
}

export function toDateTimeString(v: unknown): string {
	if (v == null || v === "") return "";
	// Pre-fix history rows were appended with valueInputOption=USER_ENTERED, so
	// Sheets coerced "yyyy/MM/dd HH:mm" into a serial number (days since
	// 1899/12/30). Decode those rows on read so the UI stays clean. New rows
	// are written RAW and arrive here as strings, hitting the early return.
	if (typeof v === "number" && Number.isFinite(v)) {
		const epoch = Date.UTC(1899, 11, 30); // Sheets epoch in UTC ms
		const ms = epoch + v * 86400 * 1000;
		return formatDateTime(new Date(ms));
	}
	return String(v);
}

// Today (Asia/Tokyo) at 00:00 in epoch ms. Used to compare against EXPIRY.
// Workers run in UTC; we hard-code Tokyo because the spreadsheet authoring
// audience is Japan. Good enough until proven otherwise.
export function todayTokyoStart(): number {
	const now = new Date();
	const tokyo = new Date(now.getTime() + 9 * 3600 * 1000);
	tokyo.setUTCHours(0, 0, 0, 0);
	return tokyo.getTime() - 9 * 3600 * 1000;
}

export function isExpired(v: unknown): boolean {
	if (v == null || v === "") return false;
	const parsed = new Date(String(v));
	if (Number.isNaN(parsed.getTime())) return false;
	return parsed.getTime() < todayTokyoStart();
}

// "yyyy/MM/dd HH:mm" in Asia/Tokyo, matching gas/Code.gs formatDateTime.
export function formatDateTime(d: Date): string {
	const tokyo = new Date(d.getTime() + 9 * 3600 * 1000);
	const yyyy = tokyo.getUTCFullYear();
	const mm = String(tokyo.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(tokyo.getUTCDate()).padStart(2, "0");
	const hh = String(tokyo.getUTCHours()).padStart(2, "0");
	const mi = String(tokyo.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

export function generateTaskId(): string {
	const ts = Date.now().toString();
	const rand = Math.random().toString(36).slice(2, 6);
	return `T${ts}_${rand}`;
}

export function b64url(s: string): string {
	return b64urlBytes(new TextEncoder().encode(s));
}

export function b64urlBytes(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

import type { Env } from "./env";
import { getAccessToken } from "./api";
import { b64url, b64urlBytes, formatDateTime } from "./util";

const PUSH_SHEET = "PushSubscriptions";
const PUSH_HEADERS = ["endpoint", "p256dh", "auth", "user", "role", "createdAt", "updatedAt"] as const;
const MAX_PUSH_SUBSCRIPTIONS = 50;

export interface PushSubscriptionInput {
	endpoint?: unknown;
	keys?: {
		p256dh?: unknown;
		auth?: unknown;
	};
}

interface StoredSubscription {
	rowIndex: number;
	endpoint: string;
	p256dh: string;
	auth: string;
	role: PushRole;
}

export type PushRole = "child" | "parent";

export function getPushPublicKey(env: Env): string {
	const key = (env.PUSH_VAPID_PUBLIC_KEY ?? "").trim();
	return key;
}

export function pushEnabled(env: Env): boolean {
	return Boolean(getPushPublicKey(env) && (env.PUSH_VAPID_PRIVATE_KEY ?? "").trim());
}

export function normalizePushSubscription(input: unknown): PushSubscriptionInput {
	if (!input || typeof input !== "object") return {};
	const sub = input as Record<string, unknown>;
	const keys = sub.keys && typeof sub.keys === "object" ? (sub.keys as Record<string, unknown>) : {};
	return {
		endpoint: sub.endpoint,
		keys: {
			p256dh: keys.p256dh,
			auth: keys.auth,
		},
	};
}

export async function upsertPushSubscription(
	env: Env,
	user: string,
	subscription: PushSubscriptionInput,
	roleRaw: unknown,
): Promise<void> {
	if (!pushEnabled(env)) return;
	const endpoint = String(subscription.endpoint ?? "").trim();
	const p256dh = String(subscription.keys?.p256dh ?? "").trim();
	const auth = String(subscription.keys?.auth ?? "").trim();
	if (!endpoint || !p256dh || !auth) return;

	const token = await getAccessToken(env);
	await ensurePushSheet(env, token);
	const rows = await readPushRows(env, token);
	const now = formatDateTime(new Date());
	const role = normalizePushRole(roleRaw);
	const found = rows.find((r) => r.endpoint === endpoint);
	if (found) {
		await updatePushRow(env, token, found.rowIndex, [endpoint, p256dh, auth, user, role, now]);
		return;
	}
	if (rows.length >= MAX_PUSH_SUBSCRIPTIONS) return;
	await appendPushRow(env, token, [endpoint, p256dh, auth, user, role, now, now]);
}

export async function removePushSubscription(env: Env, endpointRaw: unknown): Promise<void> {
	if (!pushEnabled(env)) return;
	const endpoint = String(endpointRaw ?? "").trim();
	if (!endpoint) return;
	const token = await getAccessToken(env);
	await ensurePushSheet(env, token);
	const rows = await readPushRows(env, token);
	const found = rows.find((r) => r.endpoint === endpoint);
	if (!found) return;
	await clearPushRow(env, token, found.rowIndex);
}

export async function notifyViaPush(
	env: Env,
	title: string,
	body: string,
	targetRole?: PushRole,
): Promise<void> {
	if (!pushEnabled(env)) return;
	const token = await getAccessToken(env);
	await ensurePushSheet(env, token);
	const rows = await readPushRows(env, token);
	if (rows.length === 0) return;

	const deduped = new Map<string, StoredSubscription>();
	for (const row of rows) {
		if (targetRole && row.role !== targetRole) continue;
		deduped.set(row.endpoint, row);
	}

	const pub = getPushPublicKey(env);
	const plaintext = new TextEncoder().encode(JSON.stringify({ title, body }));
	for (const row of deduped.values()) {
		try {
			const encrypted = await encryptPayload(plaintext, row.p256dh, row.auth);
			const vapidToken = await buildVapidJwt(env, row.endpoint);
			const res = await sendWebPush(row.endpoint, vapidToken, pub, encrypted);
			// 404/410 means expired subscription, so prune it.
			if (res.status === 404 || res.status === 410) {
				await clearPushRow(env, token, row.rowIndex);
				continue;
			}
			if (!res.ok) {
				console.warn("Push send failed:", res.status, await res.text());
			}
		} catch (e) {
			console.warn(
				"Push send exception:",
				e instanceof Error ? e.message : String(e),
				`(title=${title}, body=${body.slice(0, 60)})`,
			);
		}
	}
}

async function sendWebPush(
	endpoint: string,
	token: string,
	pub: string,
	body: Uint8Array,
): Promise<Response> {
	return fetch(endpoint, {
		method: "POST",
		headers: {
			TTL: "120",
			Urgency: "high",
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			"Content-Length": String(body.length),
			Authorization: `vapid t=${token}, k=${pub}`,
		},
		body,
	});
}

// RFC 8291 (Web Push) + RFC 8188 (aes128gcm) payload encryption.
// iOS/APNs drops no-payload pushes silently, so we must encrypt and ship a body.
async function encryptPayload(
	plaintext: Uint8Array,
	uaPublicB64Url: string,
	authSecretB64Url: string,
): Promise<Uint8Array> {
	const uaPublicRaw = base64UrlToBytes(uaPublicB64Url);
	const authSecret = base64UrlToBytes(authSecretB64Url);

	const asKeyPair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const asPublicRaw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer,
	);

	const uaPublicKey = await crypto.subtle.importKey(
		"raw",
		uaPublicRaw,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	// `public` is a reserved word in Cloudflare's workers-types, surfaced as `$public`.
	// The runtime accepts the standard `public` field per the WebCrypto spec.
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
			asKeyPair.privateKey,
			256,
		),
	);

	// RFC 8291 §3.4: PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HKDF-Expand(PRK_key, key_info, 32)
	const prkKey = await hmacSha256(authSecret, ecdhSecret);
	const keyInfo = concatBytes(
		new TextEncoder().encode("WebPush: info\0"),
		uaPublicRaw,
		asPublicRaw,
	);
	const ikm = await hkdfExpand(prkKey, keyInfo, 32);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const prk = await hmacSha256(salt, ikm);
	const cek = await hkdfExpand(
		prk,
		new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdfExpand(
		prk,
		new TextEncoder().encode("Content-Encoding: nonce\0"),
		12,
	);

	// Single (last) record: append 0x02 delimiter, then AES-128-GCM encrypt.
	const padded = new Uint8Array(plaintext.length + 1);
	padded.set(plaintext, 0);
	padded[plaintext.length] = 0x02;

	const cekKey = await crypto.subtle.importKey(
		"raw",
		cek,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, padded),
	);

	// Record header: salt(16) || rs(4 BE) || idlen(1) || keyid(asPublicRaw, 65 bytes)
	const header = new Uint8Array(16 + 4 + 1 + 65);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096, false);
	header[20] = 65;
	header.set(asPublicRaw, 21);

	return concatBytes(header, ciphertext);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

// Single-block HKDF-Expand. Outputs <= 32 bytes only (sufficient for CEK/nonce/IKM).
async function hkdfExpand(
	prk: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array> {
	const data = new Uint8Array(info.length + 1);
	data.set(info, 0);
	data[info.length] = 0x01;
	const t = await hmacSha256(prk, data);
	return t.slice(0, length);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const a of arrays) total += a.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) {
		out.set(a, off);
		off += a.length;
	}
	return out;
}

async function buildVapidJwt(env: Env, endpoint: string): Promise<string> {
	const privateKeyB64Url = (env.PUSH_VAPID_PRIVATE_KEY ?? "").trim();
	const publicKeyB64Url = getPushPublicKey(env);
	const privateKey = await importEcPrivateKey(privateKeyB64Url, publicKeyB64Url);
	const header = { typ: "JWT", alg: "ES256" };
	const now = Math.floor(Date.now() / 1000);
	const claim = {
		aud: new URL(endpoint).origin,
		exp: now + 60 * 60,
		sub: env.PUSH_SUBJECT || "mailto:no-reply@example.com",
	};
	const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
	const sigRaw = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			privateKey,
			new TextEncoder().encode(unsigned),
		),
	);
	return `${unsigned}.${b64urlBytes(derToJose(sigRaw, 32))}`;
}

async function importEcPrivateKey(
	privateKeyB64Url: string,
	publicKeyB64Url: string,
): Promise<CryptoKey> {
	const { x, y } = splitVapidPublicKey(publicKeyB64Url);
	const jwk = {
		kty: "EC",
		crv: "P-256",
		d: privateKeyB64Url,
		x,
		y,
		ext: true,
		key_ops: ["sign"],
	};
	return crypto.subtle.importKey(
		"jwk",
		jwk,
		{
			name: "ECDSA",
			namedCurve: "P-256",
		},
		false,
		["sign"],
	);
}

function splitVapidPublicKey(publicKeyB64Url: string): { x: string; y: string } {
	const raw = base64UrlToBytes(publicKeyB64Url);
	// Uncompressed P-256 point: 0x04 || X(32) || Y(32)
	if (raw.length !== 65 || raw[0] !== 0x04) {
		throw new Error("Invalid VAPID public key format");
	}
	const x = bytesToBase64Url(raw.slice(1, 33));
	const y = bytesToBase64Url(raw.slice(33, 65));
	return { x, y };
}

function derToJose(der: Uint8Array, size: number): Uint8Array {
	// Some runtimes already return JOSE-compatible raw signatures (r||s).
	if (der.length === size * 2) return der;
	// ECDSA signature from SubtleCrypto is ASN.1 DER sequence. Web Push JWT needs
	// raw JOSE format (r||s).
	if (der.length < 8 || der[0] !== 0x30) {
		throw new Error("Unexpected DER signature");
	}
	let offset = 2;
	if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
	if (der[offset] !== 0x02) throw new Error("Invalid DER signature (r)");
	const rLen = der[offset + 1];
	const rStart = offset + 2;
	const r = der.slice(rStart, rStart + rLen);
	const sOffset = rStart + rLen;
	if (der[sOffset] !== 0x02) throw new Error("Invalid DER signature (s)");
	const sLen = der[sOffset + 1];
	const sStart = sOffset + 2;
	const s = der.slice(sStart, sStart + sLen);
	const out = new Uint8Array(size * 2);
	out.set(trimAndPad(r, size), 0);
	out.set(trimAndPad(s, size), size);
	return out;
}

function trimAndPad(input: Uint8Array, size: number): Uint8Array {
	let data = input;
	while (data.length > 0 && data[0] === 0x00) data = data.slice(1);
	if (data.length > size) return data.slice(data.length - size);
	if (data.length === size) return data;
	const out = new Uint8Array(size);
	out.set(data, size - data.length);
	return out;
}

function base64UrlToBytes(value: string): Uint8Array {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function ensurePushSheet(env: Env, token: string): Promise<void> {
	const exists = await hasPushSheet(env, token);
	if (exists) return;

	const createUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}:batchUpdate`;
	const createRes = await fetch(createUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			requests: [{ addSheet: { properties: { title: PUSH_SHEET } } }],
		}),
	});
	// Duplicate title races are acceptable.
	if (!createRes.ok && createRes.status !== 400) {
		console.warn("Push sheet creation failed:", createRes.status, await createRes.text());
	}
	await writePushHeaders(env, token);
}

async function hasPushSheet(env: Env, token: string): Promise<boolean> {
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}?fields=sheets.properties.title`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) return false;
	const json = (await res.json()) as {
		sheets?: { properties?: { title?: string } }[];
	};
	const titles = (json.sheets ?? []).map((s) => s.properties?.title).filter(Boolean);
	return titles.includes(PUSH_SHEET);
}

async function writePushHeaders(env: Env, token: string): Promise<void> {
	const range = `${PUSH_SHEET}!A1:G1`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
	await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ range, majorDimension: "ROWS", values: [PUSH_HEADERS] }),
	});
}

async function readPushRows(env: Env, token: string): Promise<StoredSubscription[]> {
	const range = `${PUSH_SHEET}!A2:G`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) return [];
	const body = (await res.json()) as { values?: unknown[][] };
	const values = body.values ?? [];
	return values
		.map((row, i) => {
			const endpoint = String(row[0] ?? "").trim();
			const p256dh = String(row[1] ?? "").trim();
			const auth = String(row[2] ?? "").trim();
			const role = normalizePushRole(row[4]);
			return { rowIndex: i + 2, endpoint, p256dh, auth, role };
		})
		.filter((row) => row.endpoint && row.p256dh && row.auth);
}

async function appendPushRow(
	env: Env,
	token: string,
	row: [string, string, string, string, PushRole, string, string],
): Promise<void> {
	const range = `${PUSH_SHEET}!A:G`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
	await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ range, majorDimension: "ROWS", values: [row] }),
	});
}

async function updatePushRow(
	env: Env,
	token: string,
	rowIndex: number,
	row: [string, string, string, string, PushRole, string],
): Promise<void> {
	const range = `${PUSH_SHEET}!A${rowIndex}:G${rowIndex}`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
	const current = await readPushUpdatedAt(env, token, rowIndex);
	await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			range,
			majorDimension: "ROWS",
			values: [[row[0], row[1], row[2], row[3], row[4], current || row[5], row[5]]],
		}),
	});
}

async function readPushUpdatedAt(env: Env, token: string, rowIndex: number): Promise<string> {
	const range = `${PUSH_SHEET}!F${rowIndex}`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) return "";
	const body = (await res.json()) as { values?: unknown[][] };
	return String(body.values?.[0]?.[0] ?? "");
}

async function clearPushRow(env: Env, token: string, rowIndex: number): Promise<void> {
	const range = `${PUSH_SHEET}!A${rowIndex}:G${rowIndex}`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
	await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			range,
			majorDimension: "ROWS",
			values: [["", "", "", "", "", "", ""]],
		}),
	});
}

function normalizePushRole(value: unknown): PushRole {
	return value === "parent" ? "parent" : "child";
}

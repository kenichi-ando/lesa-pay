/**
 * LINE Messaging API broadcast.
 *
 * Best-effort: failures are logged but never break the caller's flow.
 * No-op if env.LINE_TOKEN is not set as a wrangler secret.
 */

import type { Env } from "./env";
import { MSG } from "./messages";

export async function notify(
	env: Env,
	origin: string,
	targetUser: string,
	subject: string,
	body: string,
): Promise<void> {
	if (!env.LINE_TOKEN) return;

	let message = `【${subject}】\n${body}`;
	if (origin) {
		// `?parent=1` opens the parent login dialog automatically.
		// `?user=<key>` switches the device to that child before login.
		// We intentionally do NOT include the access token here: LINE history
		// is durable and easily forwarded, so the token would leak with every
		// notification. Family members open the link from a device that was
		// previously invited via the one-shot ?k=<token> URL.
		const url = `${origin}/?parent=1&user=${encodeURIComponent(targetUser)}`;
		message += `\n\n${MSG.notifyOpenInParentMode}\n${url}`;
	}

	try {
		const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.LINE_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [{ type: "text", text: message }],
			}),
		});
		if (!res.ok) {
			console.warn("LINE send failed:", res.status, await res.text());
		}
	} catch (e) {
		console.warn("LINE send exception:", (e as Error).message);
	}
}

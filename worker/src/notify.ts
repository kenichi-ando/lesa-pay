/**
 * LINE Messaging API broadcast.
 *
 * Best-effort: failures are logged but never break the caller's flow.
 * No-op if LINE_TOKEN is not set in the 設定 sheet.
 */

import type { Config } from "./config";
import { MSG } from "./messages";

export async function notify(
	cfg: Config,
	origin: string,
	targetUser: string,
	subject: string,
	body: string,
): Promise<void> {
	if (!cfg.lineToken) return;

	let message = `【${subject}】\n${body}`;
	if (origin) {
		// `?parent=1` opens the parent login dialog automatically.
		// `?user=<key>` switches the device to that child before login.
		const url = `${origin}/?parent=1&user=${encodeURIComponent(targetUser)}`;
		message += `\n\n${MSG.notifyOpenInParentMode}\n${url}`;
	}

	try {
		const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cfg.lineToken}`,
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

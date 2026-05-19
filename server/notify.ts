/**
 * Notification fan-out (Web Push only).
 *
 * Best-effort: failures are logged but never break the caller's flow.
 */

import type { Env } from "./env";
import { notifyViaPush, type PushRole } from "./push";

export async function notify(
	env: Env,
	subject: string,
	body: string,
	targetRole?: PushRole,
): Promise<void> {
	await notifyViaPush(env, subject, body, targetRole);
}

/**
 * Action handlers + dispatch table.
 *
 * Each handler is a pure async function with explicit args; the ACTIONS
 * registry adapts the request shape to those args. Mirrors gas/Code.gs.
 */

import type { Env } from "./env";
import { SHEET_PREFIX, STATUS, TASK_COL, HISTORY_LABEL, normalizeStatus } from "./schema";
import { MSG, fmt } from "./messages";
import {
	appendHistoryRow,
	casTaskStatus,
	findTaskRow,
	getAccessToken,
	readHistoryRows,
	readUserData,
} from "./api";
import { checkPin, fetchConfig, labelFor } from "./config";
import { notify } from "./notify";
import {
	getPushPublicKey,
	normalizePushSubscription,
	pushEnabled,
	removePushSubscription,
	upsertPushSubscription,
} from "./push";
import { HttpError, formatDateTime, isExpired, toNumber } from "./util";

export interface ActionRequest {
	action?: string;
	user?: string;
	[k: string]: unknown;
}

interface ActionDef {
	requireUser: boolean;
	handler: (req: ActionRequest, env: Env) => Promise<unknown>;
}

export const ACTIONS: Record<string, ActionDef> = {
	getConfig: {
		requireUser: false,
		handler: async (_req, env) => handleGetConfig(env),
	},
	getData: {
		requireUser: true,
		handler: async (req, env) => handleGetData(env, req.user as string),
	},
	verifyPin: {
		requireUser: false,
		handler: async (req, env) => handleVerifyPin(env, req.pin),
	},
	applyTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleApplyTask(env, req.user as string, req.taskId as string),
	},
	approveTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleApproveTask(env, req.user as string, req.taskId as string, req.pin),
	},
	rejectTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleRejectTask(env, req.user as string, req.taskId as string, req.pin),
	},
	withdrawTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleWithdrawTask(env, req.user as string, req.taskId as string),
	},
	cashout: {
		requireUser: true,
		handler: async (req, env) =>
			handleCashout(env, req.user as string, req.amount, req.pin),
	},
	grantBonus: {
		requireUser: true,
		handler: async (req, env) =>
			handleGrantBonus(env, req.user as string, req.label, req.amount, req.pin),
	},
	subscribePush: {
		requireUser: true,
		handler: async (req, env) =>
			handleSubscribePush(env, req.user as string, req.subscription, req.role),
	},
	unsubscribePush: {
		requireUser: false,
		handler: async (req, env) => handleUnsubscribePush(env, req.endpoint),
	},
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetConfig(env: Env) {
	const cfg = fetchConfig(env);
	return {
		users: cfg.users,
		status: STATUS,
		push: {
			enabled: pushEnabled(env),
			publicKey: getPushPublicKey(env),
		},
	};
}

async function handleGetData(env: Env, user: string) {
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;
	return readUserData(env, tasksSheet, historySheet);
}

async function handleVerifyPin(env: Env, pin: unknown) {
	checkPin(env, pin);
	return { verified: true };
}

async function handleApplyTask(env: Env, user: string, taskId: string) {
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;

	// Optimistic locking:
	//   1. Read the task row.
	//   2. Validate state transition + expiry locally.
	//   3. CAS STATUS via casTaskStatus, which re-reads right before writing.
	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);

	const currentStatus = normalizeStatus(row[TASK_COL.STATUS]);
	if (currentStatus === STATUS.SUBMITTED) throw new HttpError(409, MSG.errAlreadyApplied);
	if (currentStatus === STATUS.APPROVED) throw new HttpError(409, MSG.errAlreadyApproved);

	const expiry = row[TASK_COL.EXPIRY];
	if (isExpired(expiry)) throw new HttpError(409, MSG.errExpired);

	const submitReward = toNumber(row[TASK_COL.SUBMIT_REWARD]);
	const completeReward = toNumber(row[TASK_COL.COMPLETE_REWARD]);
	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const taskLabel = composeTaskLabel(category, title);

	// Submit reward fires only on the first transition (PENDING → SUBMITTED).
	// Resubmitting from RETURNED skips it: the parent sent it back and the
	// reward was already paid once. Withdrawals route through PENDING with a
	// compensating history entry, so they re-earn the submit reward on the next
	// apply — the +/- pair cancels out.
	const isFirstSubmit = currentStatus !== STATUS.RETURNED;

	if (isFirstSubmit && submitReward > 0) {
		await appendHistoryRow(env, token, historySheet, [
			formatDateTime(new Date()),
			HISTORY_LABEL.SUBMIT_PREFIX + taskLabel,
			submitReward,
		]);
	}

	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.SUBMITTED);

	// Notification — best effort; never break the user flow.
	const cfg = fetchConfig(env);
	const displayName = labelFor(cfg.users, user);
	await notify(
		env,
		fmt(MSG.notifySubjectApply, { user: displayName }),
		buildApplyNotifyBody(displayName, {
			taskLabel,
			completeReward,
			submitReward: isFirstSubmit ? submitReward : 0,
		}),
		"parent",
	);

	return { taskId };
}

// "category title" with empty parts skipped. Used both for history CONTENT
// and notification bodies, so the two callers stay consistent.
function composeTaskLabel(category: string, title: string): string {
	return [category, title].filter((s) => s && s.length > 0).join(" ");
}

function buildApplyNotifyBody(
	displayName: string,
	p: { taskLabel: string; completeReward: number; submitReward: number },
): string {
	const lines = [fmt(MSG.notifyApplyBodyHeader, { user: displayName, label: p.taskLabel })];
	if (p.submitReward > 0) {
		lines.push(fmt(MSG.notifyApplyBodySubmit, { pt: p.submitReward }));
	}
	lines.push(fmt(MSG.notifyApplyBodyComplete, { pt: p.completeReward }));
	lines.push("");
	lines.push(MSG.notifyApplyBodyFooter);
	return lines.join("\n");
}

async function handleApproveTask(env: Env, user: string, taskId: string, pin: unknown) {
	checkPin(env, pin);
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;

	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);

	const currentStatus = normalizeStatus(row[TASK_COL.STATUS]);
	if (currentStatus === STATUS.APPROVED) throw new HttpError(409, MSG.errAlreadyApproved);
	if (currentStatus !== STATUS.SUBMITTED) {
		throw new HttpError(409, fmt(MSG.errNotAppliedTask, { status: currentStatus }));
	}

	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const points = toNumber(row[TASK_COL.COMPLETE_REWARD]);
	const content = HISTORY_LABEL.APPROVE_PREFIX + composeTaskLabel(category, title);

	// Append history first, then flip status. A partial failure that stops
	// after the history append leaves the task still SUBMITTED (visible to the
	// parent), which is recoverable. The reverse order would risk "approved
	// without payout" — much harder to spot.
	await appendHistoryRow(env, token, historySheet, [
		formatDateTime(new Date()),
		content,
		points,
	]);
	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.APPROVED);

	return { taskId, points };
}

async function handleCashout(
	env: Env,
	user: string,
	amount: unknown,
	pin: unknown,
) {
	checkPin(env, pin);
	const amt = Number(amount);
	if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, MSG.errInvalidAmount);

	const token = await getAccessToken(env);
	const historySheet = SHEET_PREFIX.HISTORY + user;

	// Compute balance from the entire history. The window between read and
	// append is the race surface; for family-scale traffic we accept it.
	const rows = await readHistoryRows(env, token, historySheet);
	const total = rows.reduce((s, h) => s + (toNumber(h.points) || 0), 0);
	if (amt > total) {
		throw new HttpError(409, fmt(MSG.errInsufficientBalance, { total }));
	}
	await appendHistoryRow(env, token, historySheet, [
		formatDateTime(new Date()),
		HISTORY_LABEL.CASHOUT,
		-amt,
	]);
	const balance = total - amt;

	const cfg = fetchConfig(env);
	const displayName = labelFor(cfg.users, user);
	await notify(
		env,
		fmt(MSG.notifySubjectCashout, { user: displayName }),
		fmt(MSG.notifyCashoutBody, { user: displayName, amount: amt, balance }),
		"child",
	);

	return { amount: amt, balance };
}

async function handleGrantBonus(
	env: Env,
	user: string,
	labelRaw: unknown,
	amount: unknown,
	pin: unknown,
) {
	checkPin(env, pin);
	const amt = Number(amount);
	if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, MSG.errInvalidAmount);
	const label = String(labelRaw ?? "").trim();
	if (!label) throw new HttpError(400, MSG.errBonusLabelMissing);
	const maxLabelLen = 80;
	if (label.length > maxLabelLen) {
		throw new HttpError(400, fmt(MSG.errBonusLabelTooLong, { max: maxLabelLen }));
	}

	const token = await getAccessToken(env);
	const historySheet = SHEET_PREFIX.HISTORY + user;

	// Bonus posts directly to history; no Tasks_ row, no approval flow. Compute
	// the post-grant balance for the parent notification using the same
	// read-then-append pattern as cashout (race window is acceptable for
	// family-scale traffic).
	const rows = await readHistoryRows(env, token, historySheet);
	const total = rows.reduce((s, h) => s + (toNumber(h.points) || 0), 0);
	await appendHistoryRow(env, token, historySheet, [
		formatDateTime(new Date()),
		HISTORY_LABEL.BONUS_PREFIX + label,
		amt,
	]);
	const balance = total + amt;

	const cfg = fetchConfig(env);
	const displayName = labelFor(cfg.users, user);
	await notify(
		env,
		fmt(MSG.notifySubjectBonus, { user: displayName }),
		fmt(MSG.notifyBonusBody, { user: displayName, label, amount: amt, balance }),
		"child",
	);

	return { amount: amt, balance };
}

async function handleRejectTask(
	env: Env,
	user: string,
	taskId: string,
	pin: unknown,
) {
	checkPin(env, pin);
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;

	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);
	const currentStatus = normalizeStatus(row[TASK_COL.STATUS]);
	// History row was already credited at approve time; stop double-pay.
	if (currentStatus === STATUS.APPROVED) {
		throw new HttpError(409, MSG.errCannotRejectApproved);
	}

	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.RETURNED);
	const cfg = fetchConfig(env);
	const displayName = labelFor(cfg.users, user);
	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const taskLabel = composeTaskLabel(category, title);
	await notify(
		env,
		fmt(MSG.notifySubjectReject, { user: displayName }),
		fmt(MSG.notifyRejectBody, { user: displayName, label: taskLabel }),
		"child",
	);

	return { taskId };
}

async function handleWithdrawTask(env: Env, user: string, taskId: string) {
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;

	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);
	const currentStatus = normalizeStatus(row[TASK_COL.STATUS]);
	// Withdraw cancels a pending submission only. Approved tasks have already
	// paid the complete reward, and pending/returned tasks weren't submitted in
	// the first place.
	if (currentStatus !== STATUS.SUBMITTED) {
		throw new HttpError(409, fmt(MSG.errNotAppliedTask, { status: currentStatus }));
	}

	const submitReward = toNumber(row[TASK_COL.SUBMIT_REWARD]);
	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const taskLabel = composeTaskLabel(category, title);

	// Compensate the prior submit-reward credit, if any. Even when submitReward
	// is 0 we still log a row so the timeline shows the withdrawal happened.
	// Append before flipping status: a partial failure that stops here leaves
	// the task in SUBMITTED, which is recoverable; the reverse order would
	// produce a withdrawn task with no compensating history.
	await appendHistoryRow(env, token, historySheet, [
		formatDateTime(new Date()),
		HISTORY_LABEL.WITHDRAW_PREFIX + taskLabel,
		submitReward > 0 ? -submitReward : 0,
	]);
	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.PENDING);

	return { taskId };
}

async function handleSubscribePush(
	env: Env,
	user: string,
	subscription: unknown,
	role: unknown,
) {
	const normalized = normalizePushSubscription(subscription);
	await upsertPushSubscription(env, user, normalized, role);
	return { subscribed: true };
}

async function handleUnsubscribePush(env: Env, endpoint: unknown) {
	await removePushSubscription(env, endpoint);
	return { unsubscribed: true };
}

/**
 * Action handlers + dispatch table.
 *
 * Each handler is a pure async function with explicit args; the ACTIONS
 * registry adapts the request shape to those args. Mirrors gas/Code.gs.
 */

import type { Env } from "./env";
import { SHEET_PREFIX, STATUS, TASK_COL, HISTORY_LABEL } from "./schema";
import { MSG, fmt } from "./messages";
import {
	appendHistoryRow,
	casTaskStatus,
	findTaskRow,
	getAccessToken,
	readHistoryRows,
	readUserData,
} from "./api";
import { checkPassword, fetchConfig, labelFor } from "./config";
import { notify } from "./notify";
import { HttpError, formatDateTime, isExpired, toNumber } from "./util";

export interface ActionRequest {
	action?: string;
	user?: string;
	[k: string]: unknown;
}

interface ActionDef {
	requireUser: boolean;
	handler: (req: ActionRequest, env: Env, origin: string) => Promise<unknown>;
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
	verifyPassword: {
		requireUser: false,
		handler: async (req, env) => handleVerifyPassword(env, req.password),
	},
	applyTask: {
		requireUser: true,
		handler: async (req, env, origin) =>
			handleApplyTask(env, req.user as string, req.taskId as string, origin),
	},
	approveTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleApproveTask(env, req.user as string, req.taskId as string, req.password),
	},
	rejectTask: {
		requireUser: true,
		handler: async (req, env) =>
			handleRejectTask(env, req.user as string, req.taskId as string, req.password),
	},
	cashout: {
		requireUser: true,
		handler: async (req, env, origin) =>
			handleCashout(env, req.user as string, req.amount, req.password, origin),
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
	};
}

async function handleGetData(env: Env, user: string) {
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;
	return readUserData(env, tasksSheet, historySheet);
}

async function handleVerifyPassword(env: Env, password: unknown) {
	checkPassword(env, password);
	return { verified: true };
}

async function handleApplyTask(env: Env, user: string, taskId: string, origin: string) {
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;

	// Optimistic locking:
	//   1. Read the task row.
	//   2. Validate state transition + expiry locally.
	//   3. CAS STATUS via casTaskStatus, which re-reads right before writing.
	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);

	const currentStatus = (String(row[TASK_COL.STATUS] ?? "") || STATUS.PENDING) as string;
	if (currentStatus === STATUS.APPLIED) throw new HttpError(409, MSG.errAlreadyApplied);
	if (currentStatus === STATUS.APPROVED) throw new HttpError(409, MSG.errAlreadyApproved);

	const expiry = row[TASK_COL.EXPIRY];
	if (isExpired(expiry)) throw new HttpError(409, MSG.errExpired);

	const submitReward = toNumber(row[TASK_COL.SUBMIT_REWARD]);
	const completeReward = toNumber(row[TASK_COL.COMPLETE_REWARD]);
	const subject = String(row[TASK_COL.SUBJECT] ?? "");
	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const taskLabel = composeTaskLabel(subject, category, title);

	// Submit reward fires only on the first transition (PENDING → APPLIED).
	// Resubmitting from REJECTED skips the submit reward.
	const isFirstSubmit = currentStatus !== STATUS.REJECTED;

	if (isFirstSubmit && submitReward > 0) {
		await appendHistoryRow(env, token, historySheet, [
			formatDateTime(new Date()),
			HISTORY_LABEL.SUBMIT_PREFIX + taskLabel,
			submitReward,
		]);
	}

	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.APPLIED);

	// LINE notification — best effort; never break the user flow.
	const cfg = fetchConfig(env);
	const displayName = labelFor(cfg.users, user);
	await notify(
		env,
		origin,
		user,
		fmt(MSG.notifySubjectApply, { user: displayName }),
		buildApplyNotifyBody(displayName, {
			taskLabel,
			completeReward,
			submitReward: isFirstSubmit ? submitReward : 0,
		}),
	);

	return { taskId };
}

// "subject category title" with empty parts skipped. Used both for history
// CONTENT and LINE notification bodies, so all three callers stay consistent.
function composeTaskLabel(subject: string, category: string, title: string): string {
	return [subject, category, title].filter((s) => s && s.length > 0).join(" ");
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

async function handleApproveTask(env: Env, user: string, taskId: string, password: unknown) {
	checkPassword(env, password);
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;
	const historySheet = SHEET_PREFIX.HISTORY + user;

	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);

	const currentStatus = (String(row[TASK_COL.STATUS] ?? "") || STATUS.PENDING) as string;
	if (currentStatus === STATUS.APPROVED) throw new HttpError(409, MSG.errAlreadyApproved);
	if (currentStatus !== STATUS.APPLIED) {
		throw new HttpError(409, fmt(MSG.errNotAppliedTask, { status: currentStatus }));
	}

	const subject = String(row[TASK_COL.SUBJECT] ?? "");
	const category = String(row[TASK_COL.CATEGORY] ?? "");
	const title = String(row[TASK_COL.TITLE] ?? "");
	const points = toNumber(row[TASK_COL.COMPLETE_REWARD]);
	const content = HISTORY_LABEL.APPROVE_PREFIX + composeTaskLabel(subject, category, title);

	// Append history first, then flip status. A partial failure that stops
	// after the history append leaves the task still APPLIED (visible to the
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
	password: unknown,
	origin: string,
) {
	checkPassword(env, password);
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
		origin,
		user,
		fmt(MSG.notifySubjectCashout, { user: displayName }),
		fmt(MSG.notifyCashoutBody, { user: displayName, amount: amt, balance }),
	);

	return { amount: amt, balance };
}

async function handleRejectTask(env: Env, user: string, taskId: string, password: unknown) {
	checkPassword(env, password);
	if (!taskId) throw new HttpError(400, MSG.errTaskIdMissing);

	const token = await getAccessToken(env);
	const tasksSheet = SHEET_PREFIX.TASKS + user;

	const { row, rowIndex } = await findTaskRow(env, token, tasksSheet, taskId);
	const currentStatus = (String(row[TASK_COL.STATUS] ?? "") || STATUS.PENDING) as string;
	// History row was already credited at approve time; stop double-pay.
	if (currentStatus === STATUS.APPROVED) {
		throw new HttpError(409, MSG.errCannotRejectApproved);
	}

	await casTaskStatus(env, token, tasksSheet, rowIndex, currentStatus, STATUS.REJECTED);

	return { taskId };
}

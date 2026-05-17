/**
 * Spreadsheet schema constants. The values here are written into the user's
 * spreadsheet, so they must stay in sync with gas/Code.gs and the actual
 * sheet contents.
 */

// Sheet naming
export const SHEET_PREFIX = {
	TASKS: "課題_",
	HISTORY: "履歴_",
} as const;
export const CONFIG_SHEET = "設定";

// Task statuses written into the STATUS column.
export const STATUS = {
	PENDING: "未完了",
	APPLIED: "申請中",
	REJECTED: "差し戻し",
	APPROVED: "承認済み",
} as const;

// Task sheet schema. Order = column index.
export const TASK_SCHEMA = [
	{ key: "ID", header: "ID" },
	{ key: "STATUS", header: "状態" },
	{ key: "SUBJECT", header: "科目" },
	{ key: "CATEGORY", header: "分類" },
	{ key: "TITLE", header: "項目" },
	{ key: "SUBMIT_REWARD", header: "提出報酬" },
	{ key: "COMPLETE_REWARD", header: "完了報酬" },
	{ key: "MINUTES", header: "時間" },
	{ key: "EXPIRY", header: "期限" },
] as const;
export const TASK_COL = Object.fromEntries(TASK_SCHEMA.map((c, i) => [c.key, i])) as Record<
	(typeof TASK_SCHEMA)[number]["key"],
	number
>;
export const TASK_COL_COUNT = TASK_SCHEMA.length;
export const TASK_LAST_COL_LETTER = colLetter(TASK_COL_COUNT);

// History sheet schema.
export const HISTORY_SCHEMA = [
	{ key: "DATE", header: "日時" },
	{ key: "CONTENT", header: "内容" },
	{ key: "POINTS", header: "ポイント" },
] as const;
export const HISTORY_COL = Object.fromEntries(
	HISTORY_SCHEMA.map((c, i) => [c.key, i]),
) as Record<(typeof HISTORY_SCHEMA)[number]["key"], number>;
export const HISTORY_COL_COUNT = HISTORY_SCHEMA.length;
export const HISTORY_LAST_COL_LETTER = colLetter(HISTORY_COL_COUNT);

// Special history content labels used in HISTORY.CONTENT.
export const HISTORY_LABEL = {
	SUBMIT_SUFFIX: " (提出)",
	APPROVE_SUFFIX: " (承認)",
	CASHOUT: "ポイント消費",
} as const;

// Column index (1-based) → column letter (A, B, ..., Z, AA, ...).
// Lives here because schema constants depend on it; reused in index.ts.
export function colLetter(col: number): string {
	let s = "";
	let n = col;
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

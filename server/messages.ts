/**
 * User-facing message catalog.
 *
 * Errors thrown here are returned verbatim in the JSON response and rendered
 * by the frontend, so wording matters. Keep this in sync with gas/Code.gs MSG.
 */

export const MSG = {
	errPinRequired: "暗証番号を入力してください",
	errPinWrong: "暗証番号が違います",
	errParentPinNotSet: "PARENT_PIN が未設定です",
	errTaskNotFound: "課題が見つかりません",
	errTaskRowNotFound: "該当する課題が見つかりません",
	errTaskIdMissing: "taskId が未指定",
	errAlreadyApplied: "すでに申請中です",
	errAlreadyApproved: "すでに承認済みです",
	errExpired: "期限切れです",
	errNotAppliedTask: "申請中の課題ではありません (現在: {status})",
	errCannotRejectApproved: "承認済みの課題は訂正依頼できません",
	errInvalidAmount: "金額が不正です",
	errInsufficientBalance: "残高不足です (現在 {total} pt)",

	notifySubjectApply: "{user}から完了報告",
	notifySubjectReject: "{user}の課題に訂正依頼",
	notifySubjectCashout: "{user}のレッサーポイント消費",
	notifyApplyBodyHeader: "{user} が「{label}」を完了報告しました。",
	notifyApplyBodySubmit: "提出報酬: {pt} pt (付与済み)",
	notifyApplyBodyComplete: "完了報酬: {pt} pt (承認後に付与)",
	notifyApplyBodyFooter: "アプリで承認してください。",
	notifyRejectBody: "{user} の「{label}」が訂正依頼になりました。内容を見直して再提出してください。",
	notifyCashoutBody: "{user} が {amount} pt を使いました。\n残高: {balance} pt",
} as const;

// Render a template like "{name} さん" with the given vars.
export function fmt(tpl: string, vars: Record<string, unknown>): string {
	return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

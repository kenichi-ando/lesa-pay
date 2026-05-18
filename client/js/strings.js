// LesserPay UI string resources.
//
// All user-facing strings live here. Use `tr('foo.bar')` from app.js,
// `tr('foo.bar', { n: 3 })` to interpolate `{n}`.
//
// HTML elements use `data-i18n="key"` (replaces textContent) or
// `data-i18n-attr-<attr>="key"` (replaces an attribute, e.g. placeholder/aria-label).
window.LESSERPAY_STRINGS = {
  app: { title: 'LesserPay' },

  header: {
    refresh: '更新',
    currentUser: '現在のユーザー',
    currentKid: '{name}',
    currentParent: '保護者（{name}）'
  },

  userSelect: {
    title: 'だれがつかう？',
    desc: 'つかう人をえらんでね',
    parent: '保護者',
    close: '選択画面を閉じる'
  },

  balance: {
    label: 'いまのポイント',
    unit: 'pt',
    loading: '読み込み中…',
    updating: '更新中…'
  },

  tasks: {
    sectionTitle: 'がんばること',
    otherGroup: 'その他',
    empty: '課題がまだありません',
    loading: '読み込み中…',
    apply: '完了報告',
    resubmit: '↻ 再提出',
    applying: '送信中…',
    approve: '✓ 承認',
    reject: '✏️ 訂正依頼',
    appliedBadge: '申請中',
    approvedBadge: '✓ 承認',
    confirmApply: '完了したことを報告しますか?',
    confirmApprove: 'この課題を承認してポイントを付与しますか?',
    confirmReject: 'この課題を訂正依頼します。よろしいですか?',
    toastApplied: '🎉 報告しました!承認をまってね',
    toastApproved: '✓ 承認しました',
    toastRejected: '訂正依頼しました',
    expiryLabel: '期限: {date}',
    pendingCount: '{n}件 申請中',
    rewardSubmitOnly: '提出+{submit} pt',
    rewardCompleteOnly: '完了+{complete} pt',
    rewardCompleteLabeled: '完了+{complete} pt',
    rewardBoth: '提出+{submit} & 完了+{complete} pt'
  },

  history: {
    sectionTitle: 'あしあと',
    empty: '履歴がまだありません',
    loading: '読み込み中…'
  },

  parent: {
    title: '保護者ログイン',
    desc: 'パスワードを入力してください',
    cancel: 'キャンセル',
    login: 'ログイン',
    checking: '確認中…',
    needPassword: 'パスワードを入力してください'
  },

  cashout: {
    button: '💸 ポイントを使う',
    title: 'ポイントを使う',
    desc: '使うポイント数を入力してください',
    submit: '使う',
    processing: '処理中…',
    cancel: 'キャンセル',
    invalid: '正しい数値を入力してください',
    insufficient: '残高不足です (現在 {total} pt)',
    confirm: '{amount} pt を使います。よろしいですか?',
    toast: '💸 {amount} pt を使いました',
    balance: '現在: {total} pt'
  },

  setup: {
    needUsers: 'USERS シークレット (wrangler secret put USERS) を設定してください'
  },

  locked: {
    title: '🔒 アクセスできません',
    desc: '招待リンクをもう一度開いてください。リンクは家族の中で共有してください。'
  },

  users: {
    switcherTitle: 'ユーザー切り替え',
    childSwitchTitle: '表示する子供',
    loginSwitch: 'ログインユーザーを切り替える',
    switchedDisplayToast: '{name} に切り替えました',
    switchedLoginToast: '{name} でログインしました',
    switchedParentToast: '保護者でログインしました'
  },

  time: {
    hourAndMinute: '{h}時間{m}分',
    hour:          '{h}時間',
    minute:        '{m}分'
  },

  errors: {
    network: '通信エラー',
    unknown: '不明なエラー'
  }
};

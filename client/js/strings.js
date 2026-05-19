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
    currentUser: '現在のユーザー',
    currentKid: '{name}',
    currentParent: '保護者（{name}）'
  },

  userSelect: {
    title: '誰が使う？',
    desc: '使う人を選んでね',
    parent: '保護者',
    close: '選択画面を閉じる'
  },

  balance: {
    label: '現在のポイント',
    unit: 'pt'
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
    rewardSubmitOnly: '提出 {submit} pt',
    rewardCompleteOnly: '完了 {complete} pt',
    rewardBoth: '提出 {submit} & 完了 {complete} pt'
  },

  history: {
    sectionTitle: 'あしあと',
    empty: '履歴がまだありません',
    loading: '読み込み中…'
  },

  parent: {
    title: '保護者ログイン',
    desc: '暗証番号を入力してください',
    cancel: 'キャンセル',
    login: 'ログイン',
    checking: '確認中…',
    needPin: '暗証番号を入力してください'
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
    desc: '家族から教わった招待コードを入力してください。',
    openInput: '招待コードを入力',
    inputLabel: '招待コード ({n} 文字 / 大文字・数字)',
    inputPlaceholder: '例: K7QXZ4',
    cancel: '閉じる',
    submit: 'アプリを開く',
    submitting: '確認中…',
    invalid: '招待コードを入力してください',
    invalidLength: '招待コードは {n} 文字 (大文字または数字) で入力してください',
    invalidCode: '招待コードが正しくありません'
  },

  users: {
    switcherTitle: 'ユーザー切り替え',
    childSwitchTitle: '表示する子供',
    loginSwitch: 'ログインユーザーを切り替える',
    switchedDisplayToast: '{name} に切り替えました',
    switchedLoginToast: '{name} でログインしました',
    switchedParentToast: '保護者でログインしました'
  },

  settings: {
    open: '設定を開く',
    title: '⚙️ 設定',
    desc: 'お知らせと音を切り替えできます',
    notifications: 'お知らせ',
    sound: '効果音',
    close: '閉じる'
  },

  push: {
    unsupported: 'この端末では通知に未対応です',
    denied: '通知がブロックされています。ブラウザ設定で許可してください',
    enabledToast: '通知を有効化しました',
    disabledToast: '通知を無効化しました',
    failed: '通知の設定に失敗しました'
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

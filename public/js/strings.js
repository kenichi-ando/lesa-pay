// LesaPay UI string resources.
//
// All user-facing strings live here. Use `tr('foo.bar')` from app.js,
// `tr('foo.bar', { n: 3 })` to interpolate `{n}`.
//
// HTML elements use `data-i18n="key"` (replaces textContent) or
// `data-i18n-attr-<attr>="key"` (replaces an attribute, e.g. placeholder/aria-label).
window.LESAPAY_STRINGS = {
  app: { title: 'LesaPay' },

  header: {
    settings: '設定',
    parentMode: '保護者モード',
    parentModeOn: '🔓 保護者モード',
    lock: 'ロック',
    refresh: '更新'
  },

  balance: {
    label: 'いまのポイント',
    unit: 'pt',
    loading: '読み込み中…',
    updating: '更新中…',
    metaWithName: '{name} の残高 / 履歴 {count} 件',
    meta: '残高 / 履歴 {count} 件'
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
    confirmApply: '完了したことを報告しますか？',
    confirmApprove: 'この課題を承認してポイントを付与しますか？',
    confirmReject: 'この課題を訂正依頼します(未完了に戻して、子にやり直してもらう)。よろしいですか？',
    toastApplied: '🎉 報告しました!承認をまってね',
    toastApproved: '✓ 承認しました',
    toastRejected: '訂正依頼しました',
    expiry: '期限: {date}',
    pendingCount: '{n}件 申請中',
    rewardSubmitOnly: '提出+{submit} pt',
    rewardCompleteOnly: '+{complete} pt',
    rewardBoth: '提出+{submit} / 完了+{complete} pt'
  },

  history: {
    sectionTitle: 'あしあと(履歴)',
    empty: '履歴がまだありません',
    loading: '読み込み中…'
  },

  parent: {
    title: '保護者ログイン',
    desc: 'パスワードを入力してください',
    cancel: 'キャンセル',
    login: 'ログイン',
    checking: '確認中…',
    needPassword: 'パスワードを入力してください',
    modeOn: '🔓 保護者モード ON',
    modeOff: '保護者モードを解除しました'
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
    toast: '💸 {amount} pt を使いました'
  },

  setup: {
    title: 'はじめての設定',
    desc: 'この端末で使う情報を設定します',
    gasUrlLabel: 'GAS Web App URL',
    gasUrlPlaceholder: 'https://script.google.com/macros/s/.../exec',
    userLabel: 'シート名(「課題_◯◯」「履歴_◯◯」の◯◯部分)',
    userPlaceholder: 'ライト',
    labelLabel: '画面に表示する愛称(任意・空欄ならシート名と同じ)',
    labelPlaceholder: 'ライト',
    save: '保存',
    checking: '確認中…',
    cancel: 'キャンセル',
    needUrl: 'GAS URLを入力してください',
    needUser: 'シート名(例: ライト)を入力してください',
    saved: '設定を保存しました',
    urlResetPrompt: 'GAS URL を再設定しますか?'
  },

  time: {
    hourAndMinute: '{h}時間{m}分',
    hour:          '{h}時間',
    minute:        '{m}分'
  },

  errors: {
    gasUrlNotSet: 'GAS URLが未設定です',
    network: '通信エラー',
    unknown: '不明なエラー'
  }
};

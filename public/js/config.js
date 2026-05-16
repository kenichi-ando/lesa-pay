// LesaPay 設定ファイル (個人情報なし)
window.LESAPAY_CONFIG = {
  STORAGE_KEYS: {
    user:   'lesapay_user',     // シート名サフィックス (例: "ライト" → 課題_ライト)
    label:  'lesapay_label',    // 画面表示愛称 (任意。空なら user と同じ)
    gasUrl: 'lesapay_gas_url'   // GAS Web App URL
  },
  CACHE_TTL_SEC: 30
};

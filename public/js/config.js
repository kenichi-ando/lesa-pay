// LesaPay configuration (no personal data here).
window.LESAPAY_CONFIG = {
  STORAGE_KEYS: {
    user:    'lesapay_user',          // Sheet-name suffix (e.g. "ライト" → 課題_ライト)
    label:   'lesapay_label',         // Display nickname (optional; falls back to `user`)
    gasUrl:  'lesapay_gas_url',       // GAS Web App URL
    parentPw:'lesapay_parent_pw'      // Parent password, persisted once after a successful login.
                                      // Used for auto-login from a LINE ?parent=1 link.
  },
  CACHE_TTL_SEC: 30
};

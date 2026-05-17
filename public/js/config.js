// LesaPay configuration (no personal data here).
window.LESAPAY_CONFIG = {
  STORAGE_KEYS: {
    user:    'lesapay_user',          // Currently selected sheet-name suffix (key into the GAS USERS list)
    gasUrl:  'lesapay_gas_url',       // GAS Web App URL
    parentPw:'lesapay_parent_pw'      // Parent password, persisted once after a successful login.
                                      // Used for auto-login from a LINE ?parent=1 link.
  },
  CACHE_TTL_SEC: 30
};

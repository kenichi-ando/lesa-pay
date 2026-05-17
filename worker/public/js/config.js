// LesaPay configuration (no personal data here).
window.LESAPAY_CONFIG = {
  STORAGE_KEYS: {
    user:    'lesapay_user',          // Currently selected sheet-name suffix (key into the USERS list)
    parentPw:'lesapay_parent_pw'      // Parent password, persisted once after a successful login.
                                      // Used for auto-login from a LINE ?parent=1 link.
  },
  // The API and the SPA are served from the same Cloudflare Worker, so the
  // endpoint is a relative path. No setup-time URL input required.
  API_URL: '/api',
  CACHE_TTL_SEC: 30
};

// LesaPay configuration (no personal data here).
window.LESAPAY_CONFIG = {
  STORAGE_KEYS: {
    user:        'lesapay_user',         // Currently selected sheet-name suffix (key into the USERS list)
    parentPw:    'lesapay_parent_pw',    // Parent password, persisted once after a successful login.
                                         // Used for auto-login from a LINE ?parent=1 link.
    accessToken: 'lesapay_access_token'  // Shared invitation token. Captured from ?k=<token> on
                                         // first visit, then sent as Authorization: Bearer on every
                                         // /api call. Without it, no spreadsheet data is fetched.
  },
  // Query-string param the SPA reads on boot. Family members open
  // https://<worker-url>/?k=<token> once; the SPA stores the token and strips
  // ?k from the address bar so it does not leak via screenshots/history.
  TOKEN_PARAM: 'k',
  // The API and the SPA are served from the same Cloudflare Worker, so the
  // endpoint is a relative path. No setup-time URL input required.
  API_URL: '/api',
  CACHE_TTL_SEC: 30
};

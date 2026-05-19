// LesserPay configuration (no personal data here).
window.LESSERPAY_CONFIG = {
  STORAGE_KEYS: {
    user:        'lesserpay_user',         // Currently selected sheet-name suffix (key into the CHILDREN list)
    parentPin:   'lesserpay_parent_pin',   // Parent PIN, persisted once after a successful login.
    parentMode:  'lesserpay_parent_mode',  // "1" when current session should stay in parent mode.
    accessToken: 'lesserpay_access_token', // Shared invitation code. Typed into the locked screen
                                         // once and sent as Authorization: Bearer on every /api
                                         // call. Without it, no spreadsheet data is fetched.
    pushPromptDismissed: 'lesserpay_push_prompt_dismissed'
  },
  // Invitation code format. Keep in sync with server-side validation.
  INVITE_CODE_LENGTH: 8,
  INVITE_CODE_PATTERN: /^[A-Z0-9]{8}$/,
  // The API and the SPA are served from the same Cloudflare Worker, so the
  // endpoint is a relative path. No setup-time URL input required.
  API_URL: '/api',
  CACHE_TTL_SEC: 30
};

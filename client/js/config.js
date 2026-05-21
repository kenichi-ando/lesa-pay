// LesserPay configuration (no personal data here).
window.LESSERPAY_CONFIG = {
  STORAGE_KEYS: {
    user:        'lesserpay_user',         // Currently selected sheet-name suffix (key into the CHILDREN list)
    parentPin:   'lesserpay_parent_pin',   // Parent PIN, persisted once after a successful login.
    parentMode:  'lesserpay_parent_mode',  // "1" when current session should stay in parent mode.
    apiToken:    'lesserpay_api_token',    // Long bearer token returned by `redeemInvite`. Sent
                                         // as Authorization: Bearer on every /api call.
    pushPromptDismissed: 'lesserpay_push_prompt_dismissed',
    // Per-user list of task IDs that were Submitted at the last loadData. On
    // the next load, any of these that are now Approved triggers a kid-side
    // celebration. Persisted so it survives app close/reopen — that's the
    // exact case where a parent approves while the kid isn't looking.
    submittedSnapshot: 'lesserpay_submitted_snapshot'
  },
  // Invitation code format. Keep in sync with server-side validation.
  INVITE_CODE_LENGTH: 6,
  INVITE_CODE_PATTERN: /^[A-Z0-9]{6}$/,
  // The API and the SPA are served from the same Cloudflare Worker, so the
  // endpoint is a relative path. No setup-time URL input required.
  API_URL: '/api',
  CACHE_TTL_SEC: 30
};

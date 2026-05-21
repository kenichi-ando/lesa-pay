(function () {
  'use strict';

  function create(storageKeys) {
    const sk = storageKeys;
    return {
      getUser: function () { return localStorage.getItem(sk.user); },
      setUser: function (user) { localStorage.setItem(sk.user, user); },
      clearUser: function () { localStorage.removeItem(sk.user); },
      getParentPin: function () { return localStorage.getItem(sk.parentPin); },
      setParentPin: function (pin) { localStorage.setItem(sk.parentPin, pin); },
      clearParentPin: function () { localStorage.removeItem(sk.parentPin); },
      getParentMode: function () { return localStorage.getItem(sk.parentMode) === '1'; },
      setParentMode: function (enabled) {
        if (enabled) localStorage.setItem(sk.parentMode, '1');
        else localStorage.removeItem(sk.parentMode);
      },
      clearParentMode: function () { localStorage.removeItem(sk.parentMode); },
      getApiToken: function () { return localStorage.getItem(sk.apiToken); },
      setApiToken: function (token) { localStorage.setItem(sk.apiToken, token); },
      clearApiToken: function () { localStorage.removeItem(sk.apiToken); },
      getPushPromptDismissed: function () { return localStorage.getItem(sk.pushPromptDismissed) === '1'; },
      setPushPromptDismissed: function () { localStorage.setItem(sk.pushPromptDismissed, '1'); },
      clearPushPromptDismissed: function () { localStorage.removeItem(sk.pushPromptDismissed); },
      getSubmittedSnapshot: function (user) {
        return JSON.parse(localStorage.getItem(sk.submittedSnapshot + '_' + user) || '[]');
      },
      setSubmittedSnapshot: function (user, ids) {
        localStorage.setItem(sk.submittedSnapshot + '_' + user, JSON.stringify(ids));
      }
    };
  }

  window.LESSERPAY_STORE = { create: create };
})();

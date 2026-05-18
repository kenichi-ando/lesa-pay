(function () {
  'use strict';

  function create(storageKeys) {
    const sk = storageKeys;
    return {
      getUser: function () { return localStorage.getItem(sk.user); },
      setUser: function (user) { localStorage.setItem(sk.user, user); },
      clearUser: function () { localStorage.removeItem(sk.user); },
      getParentPw: function () { return localStorage.getItem(sk.parentPw); },
      setParentPw: function (pw) { localStorage.setItem(sk.parentPw, pw); },
      clearParentPw: function () { localStorage.removeItem(sk.parentPw); },
      getAccessToken: function () { return localStorage.getItem(sk.accessToken); },
      setAccessToken: function (token) { localStorage.setItem(sk.accessToken, token); },
      clearAccessToken: function () { localStorage.removeItem(sk.accessToken); }
    };
  }

  window.LESSERPAY_STORE = { create: create };
})();

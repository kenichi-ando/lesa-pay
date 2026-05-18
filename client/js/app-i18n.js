(function () {
  'use strict';

  function create(strings) {
    const dict = strings || {};

    function tr(key, vars) {
      const value = key.split('.').reduce((obj, part) => (obj == null ? obj : obj[part]), dict);
      if (typeof value !== 'string') return key;
      if (!vars) return value;
      return value.replace(/\{(\w+)\}/g, function (_, name) {
        return vars[name] != null ? vars[name] : '';
      });
    }

    function applyI18n(root) {
      const targetRoot = root || document;
      targetRoot.querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = tr(el.getAttribute('data-i18n'));
      });
      targetRoot.querySelectorAll('*').forEach(function (el) {
        Array.from(el.attributes).forEach(function (attr) {
          if (!attr.name.startsWith('data-i18n-attr-')) return;
          const targetAttr = attr.name.slice('data-i18n-attr-'.length);
          el.setAttribute(targetAttr, tr(attr.value));
        });
      });
    }

    return { tr: tr, applyI18n: applyI18n };
  }

  window.LESSERPAY_I18N = { create: create };
})();

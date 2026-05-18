(function () {
  'use strict';

  function create(options) {
    const tr = options.tr;

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        return ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        })[ch];
      });
    }

    function parseDate(source) {
      if (!source) return null;
      let date = new Date(String(source).replace(/-/g, '/'));
      if (!Number.isNaN(date.getTime())) return date;
      date = new Date(source);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDate(source) {
      const date = parseDate(source);
      if (!date) return String(source == null ? '' : source);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return y + '/' + m + '/' + d;
    }

    function isExpired(source) {
      const date = parseDate(source);
      if (!date) return false;
      date.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return date < today;
    }

    function formatMinutes(mins) {
      const m = Number(mins) || 0;
      if (m <= 0) return '';
      const h = Math.floor(m / 60);
      const r = m % 60;
      if (h > 0 && r > 0) return tr('time.hourAndMinute', { h: h, m: r });
      if (h > 0) return tr('time.hour', { h: h });
      return tr('time.minute', { m: r });
    }

    return {
      escapeHtml: escapeHtml,
      parseDate: parseDate,
      formatDate: formatDate,
      isExpired: isExpired,
      formatMinutes: formatMinutes
    };
  }

  window.LESSERPAY_UTILS = { create: create };
})();

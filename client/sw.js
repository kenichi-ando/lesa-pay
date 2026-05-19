const BADGE_DB = 'lesserpay-badge';
const BADGE_STORE = 'kv';
const BADGE_KEY = 'count';

function openBadgeDb() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(BADGE_DB, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(BADGE_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function getBadgeCount() {
  return openBadgeDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(BADGE_STORE, 'readonly');
      const req = tx.objectStore(BADGE_STORE).get(BADGE_KEY);
      req.onsuccess = function () { resolve(Number(req.result) || 0); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function setBadgeCount(n) {
  return openBadgeDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(BADGE_STORE, 'readwrite');
      tx.objectStore(BADGE_STORE).put(n, BADGE_KEY);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function applyBadge(n) {
  if (typeof self.navigator !== 'undefined' && 'setAppBadge' in self.navigator) {
    return self.navigator.setAppBadge(n).catch(function () {});
  }
  return Promise.resolve();
}

function clearBadge() {
  if (typeof self.navigator !== 'undefined' && 'clearAppBadge' in self.navigator) {
    return self.navigator.clearAppBadge().catch(function () {});
  }
  return Promise.resolve();
}

async function notifyOpenClients() {
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  let hasVisibleClient = false;
  list.forEach(function (c) {
    try { c.postMessage({ type: 'reload-data' }); } catch (_e) { /* ignore */ }
    if (c.visibilityState === 'visible') hasVisibleClient = true;
  });
  return hasVisibleClient;
}

self.addEventListener('push', function (event) {
  let payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_e) {
      payload = { body: event.data.text() };
    }
  }
  const title = payload && payload.title ? String(payload.title) : 'LesserPay';
  const body = payload && payload.body ? String(payload.body) : 'You have a new LesserPay update.';

  const work = notifyOpenClients().then(function (hasVisibleClient) {
    // If a tab is already on-screen, just trigger a reload there. Skip the
    // badge increment so the count doesn't grow while the user is actively
    // looking at the app.
    if (hasVisibleClient) {
      return Promise.resolve();
    }
    return getBadgeCount().then(function (current) {
      const next = current + 1;
      return setBadgeCount(next).then(function () { return applyBadge(next); });
    });
  }).catch(function () {});

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32x32.png',
      tag: 'lesserpay-update',
      renotify: true
    }),
    work
  ]));
});

self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'clearBadge') return;
  event.waitUntil(setBadgeCount(0).then(clearBadge));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    setBadgeCount(0)
      .then(clearBadge)
      .then(function () {
        return clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(function (clientList) {
        for (let i = 0; i < clientList.length; i++) {
          const c = clientList[i];
          if ('focus' in c) return c.focus();
        }
        return clients.openWindow('/');
      })
  );
});

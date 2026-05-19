(function () {
  'use strict';

  function create(deps) {
    const CONFIG = deps.CONFIG;
    const store = deps.store;
    const state = deps.state;
    const tr = deps.tr;
    const runtime = deps.runtime;
    const setStatus = deps.setStatus;
    let pushSubscribed = false;

    let dataCache = null;

    function isValidInviteCode(value) {
      const code = (value || '').trim().toUpperCase();
      return CONFIG.INVITE_CODE_PATTERN.test(code);
    }

    class UnauthorizedError extends Error {
      constructor() {
        super('unauthorized');
        this.name = 'UnauthorizedError';
      }
    }

    function isStandalone() {
      if (typeof window === 'undefined') return false;
      if (window.navigator && window.navigator.standalone === true) return true;
      if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true;
      return false;
    }

    function isIos() {
      const ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
      // iPadOS 13+ reports as "MacIntel" but exposes touch — treat that as iOS too.
      if (/iPhone|iPad|iPod/.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
      return false;
    }

    function pushSupported() {
      if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return false;
      // iOS only delivers Web Push to installed PWAs. In a regular Safari tab
      // PushManager exists but subscribe() never fires notifications, so we
      // disable the toggle to avoid a confusing "enabled but silent" state.
      if (isIos() && !isStandalone()) return false;
      return true;
    }

    function notificationPermission() {
      return (typeof Notification !== 'undefined' && Notification.permission) ? Notification.permission : 'unsupported';
    }

    function base64UrlToUint8Array(base64Url) {
      const padding = '='.repeat((4 - base64Url.length % 4) % 4);
      const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }

    function bufferToBase64Url(buf) {
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    async function ensureServiceWorker() {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) return reg;
      const created = await navigator.serviceWorker.register('/sw.js');
      return created;
    }

    async function syncPushSubscription(reg) {
      const current = await reg.pushManager.getSubscription();
      if (!current) return false;
      const p256dh = current.getKey('p256dh');
      const auth = current.getKey('auth');
      await api('subscribePush', {
        role: state.parentMode ? 'parent' : 'child',
        subscription: {
          endpoint: current.endpoint,
          keys: {
            p256dh: p256dh ? bufferToBase64Url(p256dh) : '',
            auth: auth ? bufferToBase64Url(auth) : ''
          }
        }
      });
      return true;
    }

    async function refreshPushSubscriptionRole() {
      if (!pushSupported()) return;
      if (!state.pushConfig || !state.pushConfig.enabled || !state.pushConfig.publicKey) return;
      try {
        const reg = await ensureServiceWorker();
        await syncPushSubscription(reg);
      } catch (_err) {
        // Keep the UI responsive even if push sync fails.
      }
    }

    function setPushSubscribedState(isEnabled) {
      pushSubscribed = !!isEnabled;
    }

    async function disablePushNotifications() {
      if (!pushSupported()) return;
      try {
        const reg = await ensureServiceWorker();
        const current = await reg.pushManager.getSubscription();
        if (current) {
          await api('unsubscribePush', { endpoint: current.endpoint });
          await current.unsubscribe();
        }
        setPushSubscribedState(false);
        deps.toast(tr('push.disabledToast'), 'success');
      } catch (e) {
        deps.toast(tr('push.failed'), 'error');
      }
    }

    async function enablePushNotifications() {
      if (!pushSupported()) {
        deps.toast(tr('push.unsupported'), 'error');
        return;
      }
      if (!state.pushConfig || !state.pushConfig.enabled || !state.pushConfig.publicKey) return;
      if (notificationPermission() === 'denied') {
        deps.toast(tr('push.denied'), 'error');
        store.setPushPromptDismissed();
        return;
      }
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          if (perm === 'denied') store.setPushPromptDismissed();
          return;
        }
        const reg = await ensureServiceWorker();
        const current = await reg.pushManager.getSubscription();
        if (!current) {
          await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToUint8Array(state.pushConfig.publicKey)
          });
        }
        await syncPushSubscription(reg);
        setPushSubscribedState(true);
        deps.toast(tr('push.enabledToast'), 'success');
      } catch (_err) {
        deps.toast(tr('push.failed'), 'error');
      }
    }

    async function setupPushSubscription() {
      if (!pushSupported()) return;
      if (!state.pushConfig || !state.pushConfig.enabled || !state.pushConfig.publicKey) return;
      try {
        const reg = await ensureServiceWorker();
        const subscribed = await syncPushSubscription(reg);
        setPushSubscribedState(subscribed);
      } catch (_e) {
        setPushSubscribedState(false);
      }
    }

    function isPushSupportedNow() {
      return pushSupported() && !!(state.pushConfig && state.pushConfig.enabled && state.pushConfig.publicKey);
    }
    function isPushEnabled() {
      return !!pushSubscribed;
    }

    async function api(action, payload) {
      const token = store.getAccessToken();
      if (!token) throw new UnauthorizedError();
      const body = Object.assign({ action: action }, payload || {});
      if (state.user && body.user == null) body.user = state.user;

      let res;
      try {
        res = await fetch(CONFIG.API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify(body)
        });
      } catch (_err) {
        throw new Error(tr('errors.network'));
      }

      if (res.status === 401) {
        store.clearAccessToken();
        throw new UnauthorizedError();
      }

      let data;
      try {
        data = await res.json();
      } catch (_err) {
        throw new Error(tr('errors.network') + ' (' + res.status + ')');
      }
      if (!data.ok) throw new Error(data.error || tr('errors.unknown'));
      return data;
    }

    function clearDataCache() {
      dataCache = null;
    }

    async function refreshServerConfig() {
      const res = await api('getConfig');
      if (res && res.status) setStatus(res.status);
      const push = (res && res.push) || {};
      state.pushConfig = {
        enabled: !!push.enabled,
        publicKey: typeof push.publicKey === 'string' ? push.publicKey : ''
      };
      const incoming = Array.isArray(res && res.users) ? res.users : [];
      state.serverUsers = incoming.filter(function (u) {
        return u && typeof u.key === 'string' && u.key;
      });
      deps.reconcileActiveUser();
    }

    function renderLocked() {
      const main = document.querySelector('.app-main');
      const header = document.querySelector('.app-header');
      if (header) header.classList.add('hidden');
      if (main) main.classList.add('hidden');
      let panel = document.getElementById('app-locked');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'app-locked';
        panel.className = 'locked-panel';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'locked-mascot');
        svg.setAttribute('width', '80');
        svg.setAttribute('height', '80');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#lesser-panda');
        svg.appendChild(use);

        const title = document.createElement('h2');
        title.className = 'locked-title';

        const desc = document.createElement('p');
        desc.className = 'locked-desc';

        const openButton = document.createElement('button');
        openButton.id = 'locked-token-open';
        openButton.className = 'btn btn-primary';
        openButton.type = 'button';

        const modal = document.createElement('div');
        modal.id = 'invite-modal';
        modal.className = 'modal hidden';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content';

        const modalTitle = document.createElement('h3');
        modalTitle.className = 'modal-title';

        const modalDesc = document.createElement('p');
        modalDesc.className = 'modal-desc';

        const input = document.createElement('input');
        input.id = 'invite-token-input';
        input.className = 'modal-input';
        input.type = 'text';
        input.autocomplete = 'off';
        input.autocapitalize = 'characters';
        input.spellcheck = false;
        input.maxLength = CONFIG.INVITE_CODE_LENGTH;
        input.style.textTransform = 'uppercase';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancel = document.createElement('button');
        cancel.id = 'invite-cancel-btn';
        cancel.className = 'btn btn-secondary';
        cancel.type = 'button';

        const submit = document.createElement('button');
        submit.id = 'invite-submit-btn';
        submit.className = 'btn btn-primary';
        submit.type = 'button';

        const error = document.createElement('div');
        error.id = 'invite-error';
        error.className = 'modal-error hidden';

        actions.appendChild(cancel);
        actions.appendChild(submit);
        modalContent.appendChild(modalTitle);
        modalContent.appendChild(modalDesc);
        modalContent.appendChild(input);
        modalContent.appendChild(actions);
        modalContent.appendChild(error);
        modal.appendChild(modalContent);

        panel.appendChild(svg);
        panel.appendChild(title);
        panel.appendChild(desc);
        panel.appendChild(openButton);
        document.body.appendChild(panel);
        document.body.appendChild(modal);
      }
      panel.querySelector('.locked-title').textContent = tr('locked.title');
      panel.querySelector('.locked-desc').textContent = tr('locked.desc');
      panel.querySelector('#locked-token-open').textContent = tr('locked.openInput');

      const modal = document.getElementById('invite-modal');
      modal.querySelector('.modal-title').textContent = tr('locked.openInput');
      modal.querySelector('.modal-desc').textContent = tr('locked.inputLabel', { n: CONFIG.INVITE_CODE_LENGTH });
      modal.querySelector('#invite-token-input').placeholder = tr('locked.inputPlaceholder');
      modal.querySelector('#invite-cancel-btn').textContent = tr('locked.cancel');
      modal.querySelector('#invite-submit-btn').textContent = tr('locked.submit');

      const input = modal.querySelector('#invite-token-input');
      const submit = modal.querySelector('#invite-submit-btn');
      const cancel = modal.querySelector('#invite-cancel-btn');
      const error = modal.querySelector('#invite-error');
      const saveToken = function () {
        const parsedToken = (input.value || '').trim().toUpperCase();
        if (!parsedToken) {
          error.textContent = tr('locked.invalid');
          error.classList.remove('hidden');
          return;
        }
        if (!isValidInviteCode(parsedToken)) {
          error.textContent = tr('locked.invalidLength', { n: CONFIG.INVITE_CODE_LENGTH });
          error.classList.remove('hidden');
          return;
        }
        store.setAccessToken(parsedToken);
        location.reload();
      };
      panel.querySelector('#locked-token-open').onclick = function () {
        error.classList.add('hidden');
        modal.classList.remove('hidden');
        setTimeout(function () { input.focus(); }, 50);
      };
      submit.onclick = saveToken;
      cancel.onclick = function () { modal.classList.add('hidden'); };
      modal.onclick = function (e) {
        if (e.target === modal) modal.classList.add('hidden');
      };
      input.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveToken();
      };
      input.oninput = function () { error.classList.add('hidden'); };
      panel.classList.remove('hidden');
    }

    async function loadData(force) {
      const forced = !!force;
      if (!state.booted || !state.user) return;
      const now = Date.now();
      if (!forced && dataCache && now - dataCache.ts < CONFIG.CACHE_TTL_SEC * 1000) {
        state.tasks = dataCache.tasks;
        state.history = dataCache.history;
        await refreshPushSubscriptionRole();
        runtime.render();
        return;
      }
      state.loading = true;
      runtime.render();
      try {
        const data = await api('getData');
        state.tasks = data.tasks || [];
        state.history = data.history || [];
        dataCache = { ts: now, tasks: state.tasks, history: state.history };
        await refreshPushSubscriptionRole();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          renderLocked();
          return;
        }
        deps.toast(err.message, 'error');
      } finally {
        state.loading = false;
        runtime.render();
      }
    }

    async function bootstrap() {
      // Clear app icon badge when user opens the app.
      if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(function () {});
      }
      if (!store.getAccessToken()) {
        renderLocked();
        return;
      }
      const stored = store.getUser();
      if (stored) state.user = stored;
      runtime.render();
      try {
        await refreshServerConfig();
        await setupPushSubscription();
        if (store.getParentMode()) {
          await deps.tryAutoLoginParent();
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          renderLocked();
          return;
        }
        deps.toast(err.message, 'error');
      }
      if (state.serverUsers.length === 0) {
        deps.toast(tr('setup.needUsers'), 'error');
        return;
      }
      const hasStoredUser = !!store.getUser() && deps.userKeys().includes(store.getUser());
      if (!hasStoredUser) {
        state.booted = true;
        deps.showUserSelection({ closable: false, keepSession: false });
        return;
      }
      state.booted = true;
      runtime.render();
      await loadData(false);
    }

    return {
      api: api,
      bootstrap: bootstrap,
      loadData: loadData,
      renderLocked: renderLocked,
      refreshServerConfig: refreshServerConfig,
      clearDataCache: clearDataCache,
      refreshPushSubscriptionRole: refreshPushSubscriptionRole,
      enablePush: enablePushNotifications,
      disablePush: disablePushNotifications,
      isPushEnabled: isPushEnabled,
      isPushSupported: isPushSupportedNow,
      pushPermission: notificationPermission
    };
  }

  window.LESSERPAY_CONTROLLER_DATA = { create: create };
})();

(function () {
  'use strict';

  function create(deps) {
    const CONFIG = deps.CONFIG;
    const store = deps.store;
    const state = deps.state;
    const tr = deps.tr;
    const runtime = deps.runtime;
    const setStatus = deps.setStatus;

    let dataCache = null;

    class UnauthorizedError extends Error {
      constructor() {
        super('unauthorized');
        this.name = 'UnauthorizedError';
      }
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
        panel.innerHTML =
          '<svg class="locked-mascot" width="80" height="80" aria-hidden="true"><use href="#lesser-panda"/></svg>' +
          '<h2 class="locked-title"></h2>' +
          '<p class="locked-desc"></p>';
        document.body.appendChild(panel);
      }
      panel.querySelector('.locked-title').textContent = tr('locked.title');
      panel.querySelector('.locked-desc').textContent = tr('locked.desc');
      panel.classList.remove('hidden');
    }

    async function loadData(force) {
      const forced = !!force;
      if (!state.booted || !state.user) return;
      const now = Date.now();
      if (!forced && dataCache && now - dataCache.ts < CONFIG.CACHE_TTL_SEC * 1000) {
        state.tasks = dataCache.tasks;
        state.history = dataCache.history;
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
      const params = new URLSearchParams(location.search);
      const tokenParam = params.get(CONFIG.TOKEN_PARAM);
      if (tokenParam) {
        store.setAccessToken(tokenParam);
        params.delete(CONFIG.TOKEN_PARAM);
        const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState(null, '', cleaned);
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
      const linkUser = params.get('user');
      if (linkUser && deps.userKeys().includes(linkUser) && linkUser !== state.user) {
        state.user = linkUser;
        store.setUser(linkUser);
        state.parentMode = false;
        state.parentPassword = null;
        clearDataCache();
        state.tasks = [];
        state.history = [];
      }
      const hasStoredUser = !!store.getUser() && deps.userKeys().includes(store.getUser());
      if (!hasStoredUser && !linkUser) {
        state.booted = true;
        deps.showUserSelection({ closable: false, keepSession: false });
        return;
      }
      state.booted = true;
      runtime.render();
      await loadData(false);
      if (params.get('parent') === '1') {
        params.delete('parent');
        params.delete('user');
        const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState(null, '', cleaned);
        if (await deps.tryAutoLoginParent()) return;
        deps.openParentModal();
      } else if (linkUser) {
        params.delete('user');
        const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
        history.replaceState(null, '', cleaned);
      }
    }

    return {
      api: api,
      bootstrap: bootstrap,
      loadData: loadData,
      renderLocked: renderLocked,
      refreshServerConfig: refreshServerConfig,
      clearDataCache: clearDataCache
    };
  }

  window.LESSERPAY_CONTROLLER_DATA = { create: create };
})();

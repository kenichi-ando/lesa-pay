(function () {
  'use strict';

  const CONFIG  = window.LESSERPAY_CONFIG;
  const SK      = CONFIG.STORAGE_KEYS;
  const STRINGS = window.LESSERPAY_STRINGS || {};

  // Task status values. Authoritative source is the server (server/schema.ts);
  // bootstrap() awaits refreshServerConfig() before any rendering runs, so by
  // the time STATUS is consulted it has been overwritten with the server's
  // copy. Initialised empty here purely so the variable exists.
  let STATUS = /** @type {Record<string,string>} */ ({});

  // Translate "foo.bar" → STRINGS.foo.bar. With `vars` it interpolates `{name}`.
  function tr(key, vars) {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), STRINGS);
    if (typeof v !== 'string') return key;
    if (!vars) return v;
    return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }

  // Replace text/attrs annotated with data-i18n / data-i18n-attr-*.
  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = tr(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-i18n-attr-')) {
          const target = attr.name.slice('data-i18n-attr-'.length);
          el.setAttribute(target, tr(attr.value));
        }
      }
    });
  }

  // ---------- localStorage helpers ----------
  // The user list itself is owned by the server (USERS secret). We only
  // remember the most recently selected user key and the parent password.
  const store = {
    getUser()           { return localStorage.getItem(SK.user); },
    setUser(user)       { localStorage.setItem(SK.user, user); },
    clearUser()         { localStorage.removeItem(SK.user); },
    getParentPw()       { return localStorage.getItem(SK.parentPw); },
    setParentPw(pw)     { localStorage.setItem(SK.parentPw, pw); },
    clearParentPw()     { localStorage.removeItem(SK.parentPw); },
    getAccessToken()    { return localStorage.getItem(SK.accessToken); },
    setAccessToken(tok) { localStorage.setItem(SK.accessToken, tok); },
    clearAccessToken()  { localStorage.removeItem(SK.accessToken); }
  };

  // ---------- State ----------
  const state = {
    user: null,            // currently selected user key (sheet-name suffix)
    serverUsers: [],       // [{key, label}] from the server (USERS secret)
    parentMode: false,
    parentPassword: null,
    needsUserSelection: false,
    userSelectionClosable: false,
    selectionReturnState: null,
    pendingParentSwitchToast: false,
    tasks: [],
    history: [],
    loading: false,
    booted: false,
    activeTab: 'tasks'  // 'tasks' | 'history' — which content panel is visible
  };

  let dataCache = null;

  function userKeys()    { return state.serverUsers.map((u) => u.key); }
  function labelOf(key)  {
    const found = state.serverUsers.find((u) => u.key === key);
    return found ? found.label : key;
  }

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    userLabel: $('user-label'),
    userPopover: $('user-popover'),
    userPopoverList: $('user-popover-list'),
    userSelectScreen: $('user-select-screen'),
    userSelectList: $('user-select-list'),
    userSelectCloseBtn: $('user-select-close-btn'),
    cashoutBtn: $('cashout-btn'),
    refreshBtn: $('refresh-btn'),
    tabTasks: $('tab-tasks'),
    tabHistory: $('tab-history'),
    tabTasksBadge: $('tab-tasks-badge'),
    panelTasks: $('panel-tasks'),
    panelHistory: $('panel-history'),
    balance: $('balance-amount'),
    balanceMeta: $('balance-meta'),
    tasksList: $('tasks-list'),
    historyList: $('history-list'),
    parentModal: $('parent-modal'),
    parentPassword: $('parent-password'),
    parentSubmit: $('parent-submit-btn'),
    parentCancel: $('parent-cancel-btn'),
    parentError: $('parent-error'),
    cashoutModal: $('cashout-modal'),
    cashoutAmount: $('cashout-amount'),
    cashoutSubmit: $('cashout-submit-btn'),
    cashoutCancel: $('cashout-cancel-btn'),
    cashoutError: $('cashout-error'),
    cashoutBalance: $('cashout-balance'),
    toast: $('toast')
  };

  // ---------- API ----------
  // The Worker hosts both the SPA and the API on the same origin, so the
  // endpoint is a relative path and a normal application/json POST works
  // without a CORS preflight detour.
  // Sentinel error: the access token is missing or no longer accepted by the
  // Worker. bootstrap() catches it and renders the locked screen instead of a
  // generic toast, so the user knows to reopen their invitation URL.
  class UnauthorizedError extends Error {
    constructor() { super('unauthorized'); this.name = 'UnauthorizedError'; }
  }

  async function api(action, payload = {}) {
    const token = store.getAccessToken();
    if (!token) throw new UnauthorizedError();

    const body = { action, ...payload };
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
      // Token rejected by the Worker (e.g. ACCESS_TOKEN was rotated). Drop the
      // stored copy so the next visit shows the locked screen instead of
      // looping with a stale token.
      store.clearAccessToken();
      throw new UnauthorizedError();
    }
    // The server returns {ok:false, error} as JSON even on 4xx/5xx, so we let
    // the body win. Falling back to errors.network only when the body is not
    // JSON at all (proxy errors, captive portals, etc.).
    let data;
    try {
      data = await res.json();
    } catch (_err) {
      throw new Error(tr('errors.network') + ' (' + res.status + ')');
    }
    if (!data.ok) throw new Error(data.error || tr('errors.unknown'));
    return data;
  }


  // Pull STATUS + USERS roster from the server. The roster is authoritative;
  // we always overwrite state.serverUsers, then make sure the active user
  // still appears in it (otherwise switch to the first listed user).
  async function refreshServerConfig() {
    const res = await api('getConfig');
    if (res && res.status) STATUS = res.status;
    const incoming = Array.isArray(res && res.users) ? res.users : [];
    state.serverUsers = incoming.filter((u) => u && typeof u.key === 'string' && u.key);
    reconcileActiveUser();
  }

  function reconcileActiveUser() {
    const keys = userKeys();
    if (keys.length === 0) {
      state.user = null;
      store.clearUser();
      return;
    }
    if (!state.user || !keys.includes(state.user)) {
      state.user = keys[0];
      store.setUser(state.user);
      // The active identity changed → drop cached state and parent mode.
      state.parentMode = false;
      state.parentPassword = null;
      dataCache = null;
      state.tasks = [];
      state.history = [];
    }
  }

  // ---------- Render ----------
  function render() {
    // Cashout button: parent-mode AND positive balance. A 0-pt cashout would
    // just hit errInsufficientBalance on the server, so hide the affordance.
    const total = state.history.reduce((sum, h) => sum + (Number(h.points) || 0), 0);
    els.cashoutBtn.classList.toggle('hidden', !state.parentMode || total <= 0);
    if (state.user && !state.needsUserSelection) {
      const key = state.parentMode ? 'header.currentParent' : 'header.currentKid';
      els.userLabel.textContent = tr(key, { name: labelOf(state.user) });
      els.userLabel.classList.add('is-switchable');
      els.userLabel.classList.remove('hidden');
    } else {
      els.userLabel.classList.remove('is-switchable');
      els.userLabel.classList.add('hidden');
    }
    renderBalance();
    renderTasks();
    renderHistory();
    renderTabs();
  }

  // Reflect state.activeTab into the DOM: highlight the active tab, show the
  // matching panel, and surface the count of SUBMITTED tasks (申請中) as a badge
  // on the tasks tab so the parent notices pending approvals even from the
  // history tab.
  function renderTabs() {
    const tab = state.activeTab;
    els.tabTasks.classList.toggle('is-active', tab === 'tasks');
    els.tabHistory.classList.toggle('is-active', tab === 'history');
    els.tabTasks.setAttribute('aria-selected', tab === 'tasks');
    els.tabHistory.setAttribute('aria-selected', tab === 'history');
    els.panelTasks.classList.toggle('hidden', tab !== 'tasks');
    els.panelHistory.classList.toggle('hidden', tab !== 'history');

    // Badge surfaces "items needing your action":
    //   - parent mode: SUBMITTED tasks (申請中) waiting for approve/reject
    //   - kid mode:    REJECTED tasks (差し戻し) waiting for resubmit
    // Either way, the badge means "you have something to do here".
    const targetStatus = state.parentMode ? STATUS.SUBMITTED : STATUS.REJECTED;
    const actionCount = state.tasks.filter((t) => t.status === targetStatus).length;
    if (actionCount > 0) {
      els.tabTasksBadge.textContent = String(actionCount);
      els.tabTasksBadge.classList.remove('hidden');
    } else {
      els.tabTasksBadge.classList.add('hidden');
    }
  }

  function switchTab(tab) {
    if (tab !== 'tasks' && tab !== 'history') return;
    if (state.activeTab === tab) return;
    state.activeTab = tab;
    renderTabs();
  }

  function renderBalance() {
    const total = state.history.reduce((sum, h) => sum + (Number(h.points) || 0), 0);
    els.balance.textContent = total.toLocaleString();
    // The meta line is kept lean: only shows "更新中…" while a fetch is in
    // flight, empty otherwise. The balance number above already conveys
    // identity + freshness implicitly.
    els.balanceMeta.textContent = state.loading ? tr('balance.updating') : '';
    els.balanceMeta.classList.toggle('hidden', !state.loading);
  }

  function renderTasks() {
    if (state.loading && state.tasks.length === 0) {
      els.tasksList.innerHTML = `<div class="empty-state">${escapeHtml(tr('tasks.loading'))}</div>`;
      return;
    }
    const visible = state.tasks.filter((t) => t.status !== STATUS.APPROVED);

    if (visible.length === 0) {
      els.tasksList.innerHTML = `<div class="empty-state">${escapeHtml(tr('tasks.empty'))}</div>`;
      return;
    }

    const groups = new Map();
    for (const t of visible) {
      const key = t.category || tr('tasks.otherGroup');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    const sortedKeys = [...groups.keys()];

    els.tasksList.innerHTML = sortedKeys.map((key) => {
      const items = groups.get(key);
      const pendingCount = items.filter((t) => t.status === STATUS.SUBMITTED).length;
      const pendingBadge = pendingCount > 0 ? `<span class="task-group-badge">${escapeHtml(tr('tasks.pendingCount', { n: pendingCount }))}</span>` : '';
      const totalMinutes = items
        .filter((t) => t.status !== STATUS.APPROVED && t.status !== STATUS.SUBMITTED)
        .reduce((sum, t) => sum + (Number(t.minutes) || 0), 0);
      const timeBadge = totalMinutes > 0
        ? `<span class="task-group-time">⏱ ${escapeHtml(formatMinutes(totalMinutes))}</span>`
        : '';
      return `
        <div class="task-group">
          <h3 class="task-group-title">${escapeHtml(key)}${timeBadge}${pendingBadge}</h3>
          <div class="task-group-items">
            ${items.map(taskItemHtml).join('')}
          </div>
        </div>
      `;
    }).join('');
    els.tasksList.querySelectorAll('[data-task-id]').forEach((btn) => {
      btn.addEventListener('click', onTaskAction);
    });
  }

  function taskItemHtml(t) {
    const statusClass =
      t.status === STATUS.SUBMITTED   ? 'status-applied' :
      t.status === STATUS.APPROVED ? 'status-approved' :
      t.status === STATUS.REJECTED ? 'status-rejected' : 'status-pending';

    const expired = isExpired(t.expiry);
    const expiryLabel = t.expiry ? tr('tasks.expiryLabel', { date: formatDate(t.expiry) }) + (expired ? ' ⚠️' : '') : '';

    let actionHtml = '';
    if (state.parentMode && t.status === STATUS.SUBMITTED) {
      actionHtml = `
        <div class="task-action-group">
          <button class="task-btn approve-btn" data-task-id="${escapeHtml(t.id)}" data-action="approve">${escapeHtml(tr('tasks.approve'))}</button>
          <button class="task-btn reject-btn" data-task-id="${escapeHtml(t.id)}" data-action="reject">${escapeHtml(tr('tasks.reject'))}</button>
        </div>
      `;
    } else if (t.status === STATUS.PENDING) {
      actionHtml = `<button class="task-btn" data-task-id="${escapeHtml(t.id)}" data-action="apply" ${expired ? 'disabled' : ''}>${escapeHtml(tr('tasks.apply'))}</button>`;
    } else if (t.status === STATUS.REJECTED) {
      actionHtml = `<button class="task-btn resubmit-btn" data-task-id="${escapeHtml(t.id)}" data-action="apply" ${expired ? 'disabled' : ''}>${escapeHtml(tr('tasks.resubmit'))}</button>`;
    } else if (t.status === STATUS.SUBMITTED) {
      actionHtml = `<span class="task-status-badge">${escapeHtml(tr('tasks.appliedBadge'))}</span>`;
    } else if (t.status === STATUS.APPROVED) {
      actionHtml = `<span class="task-status-badge">${escapeHtml(tr('tasks.approvedBadge'))}</span>`;
    }

    return `
      <div class="task-item ${statusClass}">
        <div class="task-info">
          <div class="task-title">${escapeHtml(t.title)}</div>
          <div class="task-footer">
            ${formatRewards(t)}
            ${t.minutes ? `<span class="task-minutes">⏱ ${escapeHtml(formatMinutes(t.minutes))}</span>` : ''}
            ${expiryLabel ? `<span>${expiryLabel}</span>` : ''}
          </div>
        </div>
        <div class="task-action">${actionHtml}</div>
      </div>
    `;
  }

  function renderHistory() {
    if (state.loading && state.history.length === 0) {
      els.historyList.innerHTML = `<div class="empty-state">${escapeHtml(tr('history.loading'))}</div>`;
      return;
    }
    if (state.history.length === 0) {
      els.historyList.innerHTML = `<div class="empty-state">${escapeHtml(tr('history.empty'))}</div>`;
      return;
    }
    const sorted = [...state.history].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const display = sorted.slice(0, 100);
    els.historyList.innerHTML = display.map((h) => {
      const pts = Number(h.points) || 0;
      const sign = pts >= 0 ? '+' : '';
      const cls = pts >= 0 ? 'positive' : 'negative';
      return `
        <div class="history-item">
          <div class="history-info">
            <div class="history-content">${escapeHtml(h.content || '')}</div>
            <div class="history-date">${escapeHtml(h.date || '')}</div>
          </div>
          <div class="history-points ${cls}">${sign}${pts.toLocaleString()}</div>
        </div>
      `;
    }).join('');
  }

  // ---------- User popover ----------
  function renderUserPopover() {
    if (state.serverUsers.length === 0) {
      // USERS secret is empty — surface it to the operator.
      els.userPopoverList.innerHTML = `<li class="user-popover-empty">${escapeHtml(tr('setup.needUsers'))}</li>`;
      return;
    }

    const childItems = state.parentMode
      ? state.serverUsers.map(({ key, label }) => {
        const isCurrent = key === state.user;
        return `
          <li class="user-popover-item ${isCurrent ? 'is-current' : ''}">
            <button class="user-popover-pick" type="button" data-user="${escapeHtml(key)}">
              <span class="user-popover-mark">${isCurrent ? '✓' : ''}</span>
              <span class="user-popover-name">${escapeHtml(label)}</span>
            </button>
          </li>
        `;
      }).join('')
      : '';

    const header = state.parentMode
      ? `<li class="user-popover-group-title">${escapeHtml(tr('users.childSwitchTitle'))}</li>`
      : '';
    const divider = state.parentMode ? '<li class="user-popover-divider" aria-hidden="true"></li>' : '';

    els.userPopoverList.innerHTML = `
      ${header}
      ${childItems}
      ${divider}
      <li class="user-popover-item">
        <button class="user-popover-pick user-popover-login-switch" type="button" data-action="switch-login-user">
          <span class="user-popover-name">${escapeHtml(tr('users.loginSwitch'))}</span>
        </button>
      </li>
    `;

    els.userPopoverList.querySelectorAll('[data-user]').forEach((btn) => {
      btn.addEventListener('click', () => switchUser(btn.dataset.user, {
        keepParentMode: true,
        toastKey: 'users.switchedDisplayToast'
      }));
    });
    const loginSwitchBtn = els.userPopoverList.querySelector('[data-action="switch-login-user"]');
    if (loginSwitchBtn) loginSwitchBtn.addEventListener('click', openLoginUserSelection);
  }

  function openUserPopover() {
    renderUserPopover();
    els.userPopover.classList.remove('hidden');
  }

  function closeUserPopover() {
    els.userPopover.classList.add('hidden');
  }

  function toggleUserPopover() {
    if (state.needsUserSelection || !state.user) return;
    if (els.userPopover.classList.contains('hidden')) openUserPopover();
    else closeUserPopover();
  }

  function openLoginUserSelection() {
    closeUserPopover();
    const canClose = !!state.user;
    showUserSelection({
      closable: canClose,
      keepSession: canClose,
      returnState: canClose ? {
        user: state.user,
        parentMode: state.parentMode,
        parentPassword: state.parentPassword
      } : null
    });
  }

  function showUserSelection(options) {
    const opts = options || {};
    state.needsUserSelection = true;
    state.userSelectionClosable = !!opts.closable;
    state.selectionReturnState = opts.returnState || null;
    closeUserPopover();
    if (!opts.keepSession) {
      state.parentMode = false;
      state.parentPassword = null;
    }
    els.userSelectList.innerHTML = state.serverUsers.map(({ key, label }) => `
      <button class="user-select-btn" type="button" data-user-select="${escapeHtml(key)}">
        <span>${escapeHtml(label)}</span>
      </button>
    `).join('') + `
      <button class="user-select-btn is-parent" type="button" data-user-select="__parent__">
        <span class="user-select-key" aria-hidden="true">🔑</span>
        <span>${escapeHtml(tr('userSelect.parent'))}</span>
      </button>
    `;
    els.userSelectList.querySelectorAll('[data-user-select]').forEach((btn) => {
      btn.addEventListener('click', () => onUserSelect(btn.dataset.userSelect));
    });
    els.userSelectCloseBtn.classList.toggle('hidden', !state.userSelectionClosable);
    els.userSelectScreen.classList.remove('hidden');
    render();
  }

  function hideUserSelection() {
    state.needsUserSelection = false;
    state.userSelectionClosable = false;
    state.selectionReturnState = null;
    els.userSelectScreen.classList.add('hidden');
    render();
  }

  function closeUserSelectionWithoutChanges() {
    if (!state.userSelectionClosable) return;
    if (state.selectionReturnState) {
      state.user = state.selectionReturnState.user;
      state.parentMode = state.selectionReturnState.parentMode;
      state.parentPassword = state.selectionReturnState.parentPassword;
      store.setUser(state.user);
    }
    hideUserSelection();
  }

  async function onUserSelect(selection) {
    const shouldToast = state.userSelectionClosable;
    if (selection === '__parent__') {
      state.pendingParentSwitchToast = shouldToast;
      if (!state.user && state.serverUsers.length > 0) {
        state.user = state.serverUsers[0].key;
        store.setUser(state.user);
      }
      const autoLoggedIn = await tryAutoLoginParent();
      if (autoLoggedIn) {
        hideUserSelection();
        if (shouldToast) {
          toast(tr('users.switchedParentToast'), 'success');
        }
        state.pendingParentSwitchToast = false;
        return;
      }
      openParentModal();
      return;
    }
    await switchUser(selection, {
      silent: !shouldToast,
      toastKey: 'users.switchedLoginToast'
    });
    hideUserSelection();
  }

  async function switchUser(key, options) {
    const opts = options || {};
    if (!key || key === state.user) {
      closeUserPopover();
      return;
    }
    closeUserPopover();
    const keepParentMode = !!opts.keepParentMode && state.parentMode && !!state.parentPassword;
    state.user = key;
    store.setUser(key);
    if (!keepParentMode) {
      state.parentMode = false;
      state.parentPassword = null;
    }
    dataCache = null;
    state.tasks = [];
    state.history = [];
    render();
    if (!opts.silent) {
      const toastKey = opts.toastKey || 'users.switchedToast';
      toast(tr(toastKey, { name: labelOf(key) }), 'success');
    }
    await loadData(true);
  }

  // ---------- Bootstrap ----------
  async function bootstrap() {
    // Step 1: capture ?k=<token> if present and strip it from the URL before
    // anything else runs. The token then persists in localStorage so the
    // address bar stays clean (no leakage via screenshots, history, share).
    const params = new URLSearchParams(location.search);
    const tokenParam = params.get(CONFIG.TOKEN_PARAM);
    if (tokenParam) {
      store.setAccessToken(tokenParam);
      params.delete(CONFIG.TOKEN_PARAM);
      const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', cleaned);
    }

    // Step 2: without a stored token there is nothing meaningful to render
    // (every /api call would 401). Show the locked screen and stop.
    if (!store.getAccessToken()) {
      renderLocked();
      return;
    }

    // Tentative active user from localStorage; refreshServerConfig may override.
    const stored = store.getUser();
    if (stored) state.user = stored;

    // Preview render so the UI is not blank during the network call.
    render();

    try {
      await refreshServerConfig();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        renderLocked();
        return;
      }
      toast(err.message, 'error');
    }

    if (state.serverUsers.length === 0) {
      // USERS secret unset — nothing to render. Tell the operator.
      toast(tr('setup.needUsers'), 'error');
      return;
    }

    // Honor LINE deep-link ?user=<key> AFTER the server roster is known so we
    // never persist a key the server doesn't recognise.
    const linkUser = params.get('user');
    if (linkUser && userKeys().includes(linkUser) && linkUser !== state.user) {
      state.user = linkUser;
      store.setUser(linkUser);
      // Different child → reset transient state.
      state.parentMode = false;
      state.parentPassword = null;
      dataCache = null;
      state.tasks = [];
      state.history = [];
    }

    const hasStoredUser = !!store.getUser() && userKeys().includes(store.getUser());
    if (!hasStoredUser && !linkUser) {
      state.booted = true;
      showUserSelection({ closable: false, keepSession: false });
      return;
    }

    state.booted = true;
    render();
    await loadData();

    if (params.get('parent') === '1') {
      params.delete('parent');
      params.delete('user');
      const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', cleaned);

      if (await tryAutoLoginParent()) return;
      openParentModal();
    } else if (linkUser) {
      // ?user=<key> alone (no ?parent=1): clean up the URL too.
      params.delete('user');
      const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', cleaned);
    }
  }

  // Show a "locked" view when the SPA has no usable access token. Hides the
  // app body and renders an explanatory message in #app-locked. Family members
  // recover by reopening the invitation URL (?k=<token>).
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

  async function loadData(force = false) {
    if (!state.booted || !state.user) return;
    const now = Date.now();
    if (!force && dataCache && now - dataCache.ts < CONFIG.CACHE_TTL_SEC * 1000) {
      state.tasks = dataCache.tasks;
      state.history = dataCache.history;
      render();
      return;
    }
    state.loading = true;
    render();
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
      toast(err.message, 'error');
    } finally {
      state.loading = false;
      render();
    }
  }

  async function onTaskAction(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.taskId;
    const action = btn.dataset.action;

    if (action === 'apply') {
      if (!confirm(tr('tasks.confirmApply'))) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = tr('tasks.applying');
      try {
        await api('applyTask', { taskId: id });
        toast(tr('tasks.toastApplied'), 'success');
        dataCache = null;
        await loadData(true);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = original;
      }
      return;
    }

    if (action === 'approve') {
      if (!confirm(tr('tasks.confirmApprove'))) return;
      btn.disabled = true;
      try {
        await api('approveTask', { taskId: id, password: state.parentPassword });
        toast(tr('tasks.toastApproved'), 'success');
        dataCache = null;
        await loadData(true);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }

    if (action === 'reject') {
      if (!confirm(tr('tasks.confirmReject'))) return;
      btn.disabled = true;
      try {
        await api('rejectTask', { taskId: id, password: state.parentPassword });
        toast(tr('tasks.toastRejected'));
        dataCache = null;
        await loadData(true);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }
  }

  function openParentModal() {
    els.parentPassword.value = '';
    els.parentError.classList.add('hidden');
    els.parentModal.classList.remove('hidden');
    setTimeout(() => els.parentPassword.focus(), 50);
  }

  // Attempt to enter parent mode using the password persisted in localStorage.
  // Returns true on success. On failure (no password / wrong password) the
  // caller is expected to surface the manual login modal.
  async function tryAutoLoginParent() {
    if (state.parentMode) return true;
    const savedPw = store.getParentPw();
    if (!savedPw) return false;
    try {
      await api('verifyPassword', { password: savedPw });
      state.parentPassword = savedPw;
      state.parentMode = true;
      render();
      return true;
    } catch (_err) {
      // Stored password no longer matches (rotated by the parent) — clear it
      // so future taps go straight to the manual login flow.
      store.clearParentPw();
      state.parentPassword = null;
      return false;
    }
  }

  async function submitParentLogin() {
    const pw = els.parentPassword.value;
    if (!pw) {
      els.parentError.textContent = tr('parent.needPassword');
      els.parentError.classList.remove('hidden');
      return;
    }
    els.parentSubmit.disabled = true;
    const original = els.parentSubmit.textContent;
    els.parentSubmit.textContent = tr('parent.checking');
    try {
      await api('verifyPassword', { password: pw });
      state.parentPassword = pw;
      state.parentMode = true;
      store.setParentPw(pw);
      els.parentModal.classList.add('hidden');
      hideUserSelection();
      render();
      if (state.pendingParentSwitchToast) {
        toast(tr('users.switchedParentToast'), 'success');
      }
    } catch (err) {
      state.parentPassword = null;
      els.parentError.textContent = err.message;
      els.parentError.classList.remove('hidden');
    } finally {
      state.pendingParentSwitchToast = false;
      els.parentSubmit.disabled = false;
      els.parentSubmit.textContent = original;
    }
  }

  function closeParentModal() {
    state.pendingParentSwitchToast = false;
    els.parentModal.classList.add('hidden');
  }

  function openCashoutModal() {
    const total = state.history.reduce((s, h) => s + (Number(h.points) || 0), 0);
    // Pre-fill with the full balance (typical case = drain to allowance).
    // Parent edits down with the spinner or keypad. Deliberately no select()
    // so the value is not highlighted — that surprised the user previously.
    els.cashoutAmount.value = total > 0 ? String(total) : '';
    els.cashoutBalance.textContent = tr('cashout.balance', { total: total.toLocaleString() });
    els.cashoutError.classList.add('hidden');
    els.cashoutModal.classList.remove('hidden');
    setTimeout(() => els.cashoutAmount.focus(), 50);
  }

  async function submitCashout() {
    const amount = parseInt(els.cashoutAmount.value, 10);
    if (!amount || amount <= 0) {
      els.cashoutError.textContent = tr('cashout.invalid');
      els.cashoutError.classList.remove('hidden');
      return;
    }
    const total = state.history.reduce((s, h) => s + (Number(h.points) || 0), 0);
    if (amount > total) {
      els.cashoutError.textContent = tr('cashout.insufficient', { total });
      els.cashoutError.classList.remove('hidden');
      return;
    }
    if (!confirm(tr('cashout.confirm', { amount }))) return;

    els.cashoutSubmit.disabled = true;
    els.cashoutSubmit.textContent = tr('cashout.processing');
    try {
      await api('cashout', { amount, password: state.parentPassword });
      els.cashoutModal.classList.add('hidden');
      toast(tr('cashout.toast', { amount }), 'success');
      dataCache = null;
      await loadData(true);
    } catch (err) {
      els.cashoutError.textContent = err.message;
      els.cashoutError.classList.remove('hidden');
    } finally {
      els.cashoutSubmit.disabled = false;
      els.cashoutSubmit.textContent = tr('cashout.submit');
    }
  }

  // ---------- Helpers ----------
  function toast(msg, kind = '') {
    els.toast.textContent = msg;
    els.toast.className = 'toast' + (kind ? ' toast-' + kind : '');
    els.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.add('hidden'), 2800);
  }

  function formatRewards(t) {
    const sub = Number(t.submitReward)   || 0;
    const com = Number(t.completeReward) || Number(t.points) || 0;
    const showSub = sub > 0 && t.status !== STATUS.REJECTED;
    if (showSub && com > 0) {
      return `<span class="task-points">${escapeHtml(tr('tasks.rewardBoth', { submit: sub.toLocaleString(), complete: com.toLocaleString() }))}</span>`;
    }
    if (com > 0) {
      const wasResubmit = t.status === STATUS.REJECTED && sub > 0;
      const key = wasResubmit ? 'tasks.rewardCompleteLabeled' : 'tasks.rewardCompleteOnly';
      return `<span class="task-points">${escapeHtml(tr(key, { complete: com.toLocaleString() }))}</span>`;
    }
    if (showSub) return `<span class="task-points">${escapeHtml(tr('tasks.rewardSubmitOnly', { submit: sub.toLocaleString() }))}</span>`;
    return '';
  }

  function formatMinutes(mins) {
    const m = Number(mins) || 0;
    if (m <= 0) return '';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h > 0 && r > 0) return tr('time.hourAndMinute', { h, m: r });
    if (h > 0)          return tr('time.hour', { h });
    return tr('time.minute', { m: r });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function parseDate(s) {
    if (!s) return null;
    let d = new Date(String(s).replace(/-/g, '/'));
    if (!isNaN(d.getTime())) return d;
    d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(s) {
    const d = parseDate(s);
    if (!d) return String(s == null ? '' : s);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + day;
  }

  function isExpired(s) {
    const d = parseDate(s);
    if (!d) return false;
    d.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d < today;
  }

  // ---------- Wire up ----------
  function init() {
    els.userSelectCloseBtn.addEventListener('click', closeUserSelectionWithoutChanges);
    els.parentSubmit.addEventListener('click', submitParentLogin);
    els.parentPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitParentLogin();
    });
    els.parentCancel.addEventListener('click', closeParentModal);

    els.cashoutBtn.addEventListener('click', openCashoutModal);
    els.cashoutSubmit.addEventListener('click', submitCashout);
    els.cashoutCancel.addEventListener('click', () => els.cashoutModal.classList.add('hidden'));

    els.tabTasks.addEventListener('click', () => switchTab('tasks'));
    els.tabHistory.addEventListener('click', () => switchTab('history'));
    els.refreshBtn.addEventListener('click', () => loadData(true));

    els.userLabel.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleUserPopover();
    });
    document.addEventListener('click', (e) => {
      if (els.userPopover.classList.contains('hidden')) return;
      if (!els.userPopover.contains(e.target) && e.target !== els.userLabel) {
        closeUserPopover();
      }
    });

    [els.parentModal, els.cashoutModal].forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target !== m) return;
        if (m === els.parentModal) closeParentModal();
        else m.classList.add('hidden');
      });
    });

    applyI18n();
    bootstrap();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

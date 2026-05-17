(function () {
  'use strict';

  const CONFIG  = window.LESAPAY_CONFIG;
  const SK      = CONFIG.STORAGE_KEYS;
  const STRINGS = window.LESAPAY_STRINGS || {};

  // Task status values. Authoritative source is GAS Code.gs (STATUS constant);
  // we fetch it via the getConfig action at startup to keep the two in sync.
  // The values below are only fallbacks used until getConfig responds.
  let STATUS = {
    PENDING:  '未完了',
    APPLIED:  '申請中',
    REJECTED: '差し戻し',
    APPROVED: '承認済み'
  };

  // Translate "foo.bar" → STRINGS.foo.bar. With `vars` it interpolates `{name}`.
  // Returns the key itself if missing (helps spot typos during dev).
  function tr(key, vars) {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), STRINGS);
    if (typeof v !== 'string') return key;
    if (!vars) return v;
    return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }

  // Replace text/attrs annotated with data-i18n / data-i18n-attr-*.
  // Run once on load so the static HTML reflects STRINGS.
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
  const store = {
    getGasUrl()     { return localStorage.getItem(SK.gasUrl); },
    getUser()       { return localStorage.getItem(SK.user); },
    getLabel()      { return localStorage.getItem(SK.label); },
    getParentPw()   { return localStorage.getItem(SK.parentPw); },
    setParentPw(pw) { localStorage.setItem(SK.parentPw, pw); },
    clearParentPw() { localStorage.removeItem(SK.parentPw); },
    set({ gasUrl, user, label }) {
      if (gasUrl != null) localStorage.setItem(SK.gasUrl, gasUrl);
      if (user   != null) localStorage.setItem(SK.user, user);
      if (label  != null) localStorage.setItem(SK.label, label);
    },
    clearAll() {
      localStorage.removeItem(SK.gasUrl);
      localStorage.removeItem(SK.user);
      localStorage.removeItem(SK.label);
      localStorage.removeItem(SK.parentPw);
    }
  };

  // ---------- State ----------
  const state = {
    user: null,
    label: null,
    parentMode: false,
    parentPassword: null,
    tasks: [],
    history: [],
    loading: false,
    booted: false
  };

  let dataCache = null;

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    parentBtn: $('parent-mode-btn'),
    settingsBtn: $('settings-btn'),
    userLabel: $('user-label'),
    parentPanel: $('parent-panel'),
    parentLogout: $('parent-logout-btn'),
    cashoutBtn: $('cashout-btn'),
    refreshBtn: $('refresh-btn'),
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
    setupModal: $('setup-modal'),
    setupGasUrl: $('setup-gas-url'),
    setupUser: $('setup-user'),
    setupLabel: $('setup-label'),
    setupSubmit: $('setup-submit-btn'),
    setupCancel: $('setup-cancel-btn'),
    setupError: $('setup-error'),
    toast: $('toast')
  };

  // ---------- API ----------
  async function api(action, payload = {}) {
    const url = store.getGasUrl();
    if (!url) throw new Error(tr('errors.gasUrlNotSet'));
    const body = { action, ...payload };
    if (state.user && body.user == null) body.user = state.user;
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(tr('errors.network') + ' (' + res.status + ')');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || tr('errors.unknown'));
    return data;
  }

  // Pull server-defined values (e.g. STATUS) and merge into local memory.
  // Best-effort: failures are silent because the in-code fallback still works.
  async function refreshServerConfig() {
    try {
      const res = await api('getConfig');
      if (res && res.status) STATUS = res.status;
      render();
    } catch (_) { /* fall back to local defaults */ }
  }

  // ---------- Render ----------
  function render() {
    els.parentPanel.classList.toggle('hidden', !state.parentMode);
    els.parentBtn.classList.toggle('active', state.parentMode);
    if (state.label) {
      els.userLabel.textContent = state.label;
      els.userLabel.classList.remove('hidden');
    } else {
      els.userLabel.classList.add('hidden');
    }
    renderBalance();
    renderTasks();
    renderHistory();
  }

  function renderBalance() {
    const total = state.history.reduce((sum, h) => sum + (Number(h.points) || 0), 0);
    els.balance.textContent = total.toLocaleString();
    const name = state.label || '';
    els.balanceMeta.textContent = state.loading
      ? tr('balance.updating')
      : (name ? tr('balance.metaWithName', { name, count: state.history.length })
              : tr('balance.meta',         { count: state.history.length }));
  }

  function renderTasks() {
    if (state.loading && state.tasks.length === 0) {
      els.tasksList.innerHTML = `<div class="empty-state">${escapeHtml(tr('tasks.loading'))}</div>`;
      return;
    }
    // Hide approved tasks from the list (they live on in the spreadsheet
    // and in the history feed). The active list only shows pending work.
    const visible = state.tasks.filter((t) => t.status !== STATUS.APPROVED);

    if (visible.length === 0) {
      els.tasksList.innerHTML = `<div class="empty-state">${escapeHtml(tr('tasks.empty'))}</div>`;
      return;
    }

    // Group tasks by subject
    const groups = new Map();
    for (const t of visible) {
      const key = t.subject || tr('tasks.otherGroup');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    // Preserve sheet order for both groups and tasks within each group.
    // Map keeps insertion order, and state.tasks already comes from GAS in sheet order,
    // so simply skipping a sort after building `groups` keeps the order intact.
    const sortedKeys = [...groups.keys()];

    els.tasksList.innerHTML = sortedKeys.map((key) => {
      const items = groups.get(key);
      const pendingCount = items.filter((t) => t.status === STATUS.APPLIED).length;
      const pendingBadge = pendingCount > 0 ? `<span class="task-group-badge">${escapeHtml(tr('tasks.pendingCount', { n: pendingCount }))}</span>` : '';
      // Sum of estimated time for tasks that still need work (PENDING + REJECTED).
      const totalMinutes = items
        .filter((t) => t.status !== STATUS.APPROVED && t.status !== STATUS.APPLIED)
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
      t.status === STATUS.APPLIED   ? 'status-applied' :
      t.status === STATUS.APPROVED ? 'status-approved' :
      t.status === STATUS.REJECTED ? 'status-rejected' : 'status-pending';

    const expired = isExpired(t.expiry);
    const expiryLabel = t.expiry ? tr('tasks.expiryLabel', { date: formatDate(t.expiry) }) + (expired ? ' ⚠️' : '') : '';

    let actionHtml = '';
    if (state.parentMode && t.status === STATUS.APPLIED) {
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
    } else if (t.status === STATUS.APPLIED) {
      actionHtml = `<span class="task-status-badge">${escapeHtml(tr('tasks.appliedBadge'))}</span>`;
    } else if (t.status === STATUS.APPROVED) {
      actionHtml = `<span class="task-status-badge">${escapeHtml(tr('tasks.approvedBadge'))}</span>`;
    }

    return `
      <div class="task-item ${statusClass}">
        <div class="task-info">
          <div class="task-meta">
            ${t.subject ? `<span class="task-tag subject">${escapeHtml(t.subject)}</span>` : ''}
            ${t.category ? `<span class="task-tag category">${escapeHtml(t.category)}</span>` : ''}
          </div>
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

  // ---------- Setup ----------
  function openSetup({ initial }) {
    els.setupGasUrl.value = store.getGasUrl() || '';
    els.setupUser.value = store.getUser() || '';
    els.setupLabel.value = store.getLabel() || '';
    els.setupError.classList.add('hidden');
    els.setupCancel.classList.toggle('hidden', !!initial);
    els.setupModal.classList.remove('hidden');
    setTimeout(() => {
      if (!els.setupGasUrl.value) els.setupGasUrl.focus();
      else if (!els.setupUser.value) els.setupUser.focus();
      else els.setupLabel.focus();
    }, 50);
  }

  async function submitSetup() {
    const url = els.setupGasUrl.value.trim();
    const user = els.setupUser.value.trim();
    const label = els.setupLabel.value.trim();
    if (!url) {
      els.setupError.textContent = tr('setup.needUrl');
      els.setupError.classList.remove('hidden');
      return;
    }
    if (!user) {
      els.setupError.textContent = tr('setup.needUser');
      els.setupError.classList.remove('hidden');
      return;
    }
    els.setupSubmit.disabled = true;
    const orig = els.setupSubmit.textContent;
    els.setupSubmit.textContent = tr('setup.checking');
    try {
      // Connectivity check for URL + sheet name. If getData succeeds, SHEET_ID and user are both valid.
      const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'getData', user })
      });
      if (!res.ok) throw new Error(tr('errors.network') + ' (' + res.status + ')');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || tr('errors.unknown'));

      // Success → persist
      store.set({ gasUrl: url, user, label: label || '' });
      state.user = user;
      state.label = label || user;
      // H-4: switching child must reset parent mode
      state.parentMode = false;
      state.parentPassword = null;
      state.tasks = data.tasks || [];
      state.history = data.history || [];
      dataCache = { ts: Date.now(), tasks: state.tasks, history: state.history };
      state.booted = true;
      els.setupModal.classList.add('hidden');
      render();
      toast(tr('setup.saved'), 'success');
    } catch (err) {
      els.setupError.textContent = err.message;
      els.setupError.classList.remove('hidden');
    } finally {
      els.setupSubmit.disabled = false;
      els.setupSubmit.textContent = orig;
    }
  }

  function closeSetup() {
    els.setupModal.classList.add('hidden');
  }

  // ---------- Bootstrap ----------
  async function bootstrap() {
    if (!store.getGasUrl() || !store.getUser()) {
      openSetup({ initial: true });
      return;
    }
    // ?user=<name> from a LINE link switches this device to that child before loading.
    // The change is persisted to localStorage so a refresh keeps the new selection.
    const params = new URLSearchParams(location.search);
    const targetUser = params.get('user');
    if (targetUser && targetUser !== store.getUser()) {
      store.set({ user: targetUser, label: targetUser });
    }

    state.user = store.getUser();
    state.label = store.getLabel() || state.user;
    state.booted = true;
    render();

    // Fetch server-side config (STATUS values) in the background.
    // Run in parallel with loadData; the fallback STATUS is correct enough
    // until this resolves, and a second render() picks up any updates.
    refreshServerConfig();

    await loadData();

    // Handle ?parent=1 query (came from a LINE notification link).
    // If this device has logged in as parent before, auto-login with the saved password.
    // Otherwise just open the parent login modal.
    if (params.get('parent') === '1') {
      // Strip ?parent / ?user from the URL so a reload does not re-trigger this flow.
      params.delete('parent');
      params.delete('user');
      const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', cleaned);

      if (state.parentMode) return;
      const savedPw = store.getParentPw();
      if (savedPw) {
        try {
          await api('verifyPassword', { password: savedPw });
          state.parentPassword = savedPw;
          state.parentMode = true;
          render();
          toast(tr('parent.modeOn'), 'success');
          return;
        } catch (err) {
          // Saved password is no longer valid → drop it and fall back to manual login.
          store.clearParentPw();
        }
      }
      openParentModal();
    } else if (targetUser) {
      // ?user=<name> alone (no ?parent=1): clean up the URL too.
      params.delete('user');
      const cleaned = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', cleaned);
    }
  }

  async function loadData(force = false) {
    if (!state.booted) return;
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
    if (state.parentMode) {
      state.parentMode = false;
      state.parentPassword = null;
      render();
      toast(tr('parent.modeOff'));
      return;
    }
    els.parentPassword.value = '';
    els.parentError.classList.add('hidden');
    els.parentModal.classList.remove('hidden');
    setTimeout(() => els.parentPassword.focus(), 50);
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
      // Trust this device as a parent device. Used for auto-login on next ?parent=1 visit.
      store.setParentPw(pw);
      els.parentModal.classList.add('hidden');
      render();
      toast(tr('parent.modeOn'), 'success');
    } catch (err) {
      state.parentPassword = null;
      els.parentError.textContent = err.message;
      els.parentError.classList.remove('hidden');
    } finally {
      els.parentSubmit.disabled = false;
      els.parentSubmit.textContent = original;
    }
  }

  function openCashoutModal() {
    els.cashoutAmount.value = '';
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

  // Render submit/complete rewards. Show both side-by-side; show only one if the other is 0.
  function formatRewards(t) {
    const sub = Number(t.submitReward)   || 0;
    const com = Number(t.completeReward) || Number(t.points) || 0;
    // REJECTED means the submit reward was already paid out on the first submission, so hide it.
    const showSub = sub > 0 && t.status !== STATUS.REJECTED;
    if (showSub && com > 0) {
      return `<span class="task-points">${escapeHtml(tr('tasks.rewardBoth', { submit: sub.toLocaleString(), complete: com.toLocaleString() }))}</span>`;
    }
    // For REJECTED with a submit reward already paid, prefix the remaining
    // reward with "完了" so it's clear the points come from approval, not resubmit.
    if (com > 0) {
      const wasResubmit = t.status === STATUS.REJECTED && sub > 0;
      const key = wasResubmit ? 'tasks.rewardCompleteLabeled' : 'tasks.rewardCompleteOnly';
      return `<span class="task-points">${escapeHtml(tr(key, { complete: com.toLocaleString() }))}</span>`;
    }
    if (showSub) return `<span class="task-points">${escapeHtml(tr('tasks.rewardSubmitOnly', { submit: sub.toLocaleString() }))}</span>`;
    return '';
  }

  // Format minutes into the locale-specific representation defined in STRINGS.time.
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
    els.parentBtn.addEventListener('click', openParentModal);
    els.parentSubmit.addEventListener('click', submitParentLogin);
    els.parentPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitParentLogin();
    });
    els.parentCancel.addEventListener('click', () => els.parentModal.classList.add('hidden'));
    els.parentLogout.addEventListener('click', () => {
      state.parentMode = false;
      state.parentPassword = null;
      render();
      toast(tr('parent.modeOff'));
    });

    els.cashoutBtn.addEventListener('click', openCashoutModal);
    els.cashoutSubmit.addEventListener('click', submitCashout);
    els.cashoutCancel.addEventListener('click', () => els.cashoutModal.classList.add('hidden'));

    els.refreshBtn.addEventListener('click', () => loadData(true));

    els.settingsBtn.addEventListener('click', () => openSetup({ initial: false }));
    els.setupSubmit.addEventListener('click', submitSetup);
    els.setupCancel.addEventListener('click', closeSetup);
    els.setupGasUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSetup(); });
    els.setupUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSetup(); });
    els.setupLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSetup(); });

    [els.parentModal, els.cashoutModal].forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      });
    });

    applyI18n();
    bootstrap();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

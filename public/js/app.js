(function () {
  'use strict';

  const CONFIG = window.LESAPAY_CONFIG;
  const SK = CONFIG.STORAGE_KEYS;

  // ---------- localStorage helpers ----------
  const store = {
    getGasUrl() { return localStorage.getItem(SK.gasUrl); },
    getUser()   { return localStorage.getItem(SK.user); },
    getLabel()  { return localStorage.getItem(SK.label); },
    set({ gasUrl, user, label }) {
      if (gasUrl != null) localStorage.setItem(SK.gasUrl, gasUrl);
      if (user   != null) localStorage.setItem(SK.user, user);
      if (label  != null) localStorage.setItem(SK.label, label);
    },
    clearAll() {
      localStorage.removeItem(SK.gasUrl);
      localStorage.removeItem(SK.user);
      localStorage.removeItem(SK.label);
    }
  };

  // ---------- 状態 ----------
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
    if (!url) throw new Error('GAS URLが未設定です');
    const body = { action, ...payload };
    if (state.user && body.user == null) body.user = state.user;
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('通信エラー (' + res.status + ')');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '不明なエラー');
    return data;
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
      ? '更新中…'
      : `${name ? name + ' の' : ''}残高 / 履歴 ${state.history.length} 件`;
  }

  function renderTasks() {
    if (state.loading && state.tasks.length === 0) {
      els.tasksList.innerHTML = '<div class="empty-state">読み込み中…</div>';
      return;
    }
    const order = { '申請中': 0, '未完了': 1, '承認済み': 2 };
    const sorted = [...state.tasks].sort((a, b) => {
      const oa = order[a.status] ?? 99;
      const ob = order[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return (b.points || 0) - (a.points || 0);
    });
    if (sorted.length === 0) {
      els.tasksList.innerHTML = '<div class="empty-state">課題がまだありません</div>';
      return;
    }
    els.tasksList.innerHTML = sorted.map(taskItemHtml).join('');
    els.tasksList.querySelectorAll('[data-task-id]').forEach((btn) => {
      btn.addEventListener('click', onTaskAction);
    });
  }

  function taskItemHtml(t) {
    const statusClass =
      t.status === '申請中' ? 'status-applied' :
      t.status === '承認済み' ? 'status-approved' : 'status-pending';

    const expired = isExpired(t.expiry);
    const expiryLabel = t.expiry ? `期限: ${formatDate(t.expiry)}${expired ? ' ⚠️' : ''}` : '';

    let actionHtml = '';
    if (state.parentMode && t.status === '申請中') {
      actionHtml = `
        <div class="task-action-group">
          <button class="task-btn approve-btn" data-task-id="${escape(t.id)}" data-action="approve">✓ 承認</button>
          <button class="task-btn reject-btn" data-task-id="${escape(t.id)}" data-action="reject">✗ 却下</button>
        </div>
      `;
    } else if (t.status === '未完了') {
      actionHtml = `<button class="task-btn" data-task-id="${escape(t.id)}" data-action="apply" ${expired ? 'disabled' : ''}>完了報告</button>`;
    } else if (t.status === '申請中') {
      actionHtml = '<span class="task-status-badge">申請中</span>';
    } else if (t.status === '承認済み') {
      actionHtml = '<span class="task-status-badge">✓ 承認</span>';
    }

    return `
      <div class="task-item ${statusClass}">
        <div class="task-info">
          <div class="task-meta">
            ${t.subject ? `<span class="task-tag subject">${escape(t.subject)}</span>` : ''}
            ${t.category ? `<span class="task-tag category">${escape(t.category)}</span>` : ''}
          </div>
          <div class="task-title">${escape(t.title)}</div>
          <div class="task-footer">
            <span class="task-points">+${(t.points || 0).toLocaleString()} pt</span>
            ${expiryLabel ? `<span>${expiryLabel}</span>` : ''}
          </div>
        </div>
        <div class="task-action">${actionHtml}</div>
      </div>
    `;
  }

  function renderHistory() {
    if (state.loading && state.history.length === 0) {
      els.historyList.innerHTML = '<div class="empty-state">読み込み中…</div>';
      return;
    }
    if (state.history.length === 0) {
      els.historyList.innerHTML = '<div class="empty-state">履歴がまだありません</div>';
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
            <div class="history-content">${escape(h.content || '')}</div>
            <div class="history-date">${escape(h.date || '')}</div>
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
      els.setupError.textContent = 'GAS URLを入力してください';
      els.setupError.classList.remove('hidden');
      return;
    }
    if (!user) {
      els.setupError.textContent = 'シート名（例: ライト）を入力してください';
      els.setupError.classList.remove('hidden');
      return;
    }
    els.setupSubmit.disabled = true;
    const orig = els.setupSubmit.textContent;
    els.setupSubmit.textContent = '確認中…';
    try {
      // URL とシート名の疎通確認: getData が通れば SHEET_ID と user 両方OK
      const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'getData', user })
      });
      if (!res.ok) throw new Error('通信エラー (' + res.status + ')');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'GASエラー');

      // 成功 → 保存
      store.set({ gasUrl: url, user, label: label || '' });
      state.user = user;
      state.label = label || user;
      // H-4: 子を切り替えたら保護者モードはリセット
      state.parentMode = false;
      state.parentPassword = null;
      state.tasks = data.tasks || [];
      state.history = data.history || [];
      dataCache = { ts: Date.now(), tasks: state.tasks, history: state.history };
      state.booted = true;
      els.setupModal.classList.add('hidden');
      render();
      toast('設定を保存しました', 'success');
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
    state.user = store.getUser();
    state.label = store.getLabel() || state.user;
    state.booted = true;
    render();
    await loadData();
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
      if (!confirm('完了したことをパパ・ママに報告しますか？')) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '送信中…';
      try {
        await api('applyTask', { taskId: id });
        toast('🎉 報告しました！承認をまってね', 'success');
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
      if (!confirm('この課題を承認してポイントを付与しますか？')) return;
      btn.disabled = true;
      try {
        await api('approveTask', { taskId: id, password: state.parentPassword });
        toast('✓ 承認しました', 'success');
        dataCache = null;
        await loadData(true);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }

    if (action === 'reject') {
      if (!confirm('この課題を却下します（未完了に戻ります）。よろしいですか？')) return;
      btn.disabled = true;
      try {
        await api('rejectTask', { taskId: id, password: state.parentPassword });
        toast('却下しました');
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
      toast('保護者モードを解除しました');
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
      els.parentError.textContent = 'パスワードを入力してください';
      els.parentError.classList.remove('hidden');
      return;
    }
    els.parentSubmit.disabled = true;
    const original = els.parentSubmit.textContent;
    els.parentSubmit.textContent = '確認中…';
    try {
      await api('verifyPassword', { password: pw });
      state.parentPassword = pw;
      state.parentMode = true;
      els.parentModal.classList.add('hidden');
      render();
      toast('🔓 保護者モード ON', 'success');
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
      els.cashoutError.textContent = '正しい数値を入力してください';
      els.cashoutError.classList.remove('hidden');
      return;
    }
    const total = state.history.reduce((s, h) => s + (Number(h.points) || 0), 0);
    if (amount > total) {
      els.cashoutError.textContent = `残高不足です (現在 ${total} pt)`;
      els.cashoutError.classList.remove('hidden');
      return;
    }
    if (!confirm(`${amount} pt を換金します。よろしいですか？`)) return;

    els.cashoutSubmit.disabled = true;
    els.cashoutSubmit.textContent = '処理中…';
    try {
      await api('cashout', { amount, password: state.parentPassword });
      els.cashoutModal.classList.add('hidden');
      toast(`💴 ${amount} pt を換金しました`, 'success');
      dataCache = null;
      await loadData(true);
    } catch (err) {
      els.cashoutError.textContent = err.message;
      els.cashoutError.classList.remove('hidden');
    } finally {
      els.cashoutSubmit.disabled = false;
      els.cashoutSubmit.textContent = '換金実行';
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

  function escape(s) {
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
      toast('保護者モードを解除しました');
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

    bootstrap();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

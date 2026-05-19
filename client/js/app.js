(function () {
  'use strict';

  const CONFIG = window.LESSERPAY_CONFIG;
  const SK = CONFIG.STORAGE_KEYS;
  const STRINGS = window.LESSERPAY_STRINGS || {};
  const i18n = window.LESSERPAY_I18N.create(STRINGS);
  const tr = i18n.tr;
  const applyI18n = i18n.applyI18n;
  const store = window.LESSERPAY_STORE.create(SK);
  const utils = window.LESSERPAY_UTILS.create({ tr: tr });
  const escapeHtml = utils.escapeHtml;
  const formatDate = utils.formatDate;
  const isExpired = utils.isExpired;
  const formatMinutes = utils.formatMinutes;

  let STATUS = /** @type {Record<string,string>} */ ({});
  const state = {
    user: null,
    serverUsers: [],
    parentMode: false,
    parentPin: null,
    needsUserSelection: false,
    userSelectionClosable: false,
    selectionReturnState: null,
    pendingParentSwitchToast: false,
    pushConfig: { enabled: false, publicKey: '' },
    tasks: [],
    history: [],
    loading: false,
    booted: false,
    activeTab: 'tasks'
  };

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    userLabel: $('user-label'),
    userPopover: $('user-popover'),
    userPopoverList: $('user-popover-list'),
    userSelectScreen: $('user-select-screen'),
    userSelectList: $('user-select-list'),
    userSelectCloseBtn: $('user-select-close-btn'),
    cashoutBtn: $('cashout-btn'),
    tabTasks: $('tab-tasks'),
    tabHistory: $('tab-history'),
    tabTasksBadge: $('tab-tasks-badge'),
    panelTasks: $('panel-tasks'),
    panelHistory: $('panel-history'),
    balance: $('balance-amount'),
    tasksList: $('tasks-list'),
    historyList: $('history-list'),
    parentModal: $('parent-modal'),
    parentPin: $('parent-pin'),
    parentSubmit: $('parent-submit-btn'),
    parentCancel: $('parent-cancel-btn'),
    parentError: $('parent-error'),
    cashoutModal: $('cashout-modal'),
    cashoutAmount: $('cashout-amount'),
    cashoutSubmit: $('cashout-submit-btn'),
    cashoutCancel: $('cashout-cancel-btn'),
    cashoutError: $('cashout-error'),
    cashoutBalance: $('cashout-balance'),
    settingsModal: $('settings-modal'),
    settingsClose: $('settings-close-btn'),
    settingsPushRow: $('settings-push-row'),
    settingsPushToggle: $('settings-push-toggle'),
    settingsSoundRow: $('settings-sound-row'),
    settingsSoundToggle: $('settings-sound-toggle'),
    pullIndicator: $('pull-indicator'),
    toast: $('toast')
  };

  const runtime = {
    render: function () {},
    renderTabs: function () {}
  };

  const controller = window.LESSERPAY_CONTROLLER.create({
    CONFIG: CONFIG,
    store: store,
    state: state,
    els: els,
    tr: tr,
    escapeHtml: escapeHtml,
    runtime: runtime,
    getStatus: function () { return STATUS; },
    setStatus: function (status) { STATUS = status; },
    openSettings: function () { openSettingsModal(); }
  });

  const renderer = window.LESSERPAY_RENDER.create({
    state: state,
    els: els,
    tr: tr,
    getStatus: function () { return STATUS; },
    escapeHtml: escapeHtml,
    formatMinutes: formatMinutes,
    formatDate: formatDate,
    isExpired: isExpired,
    onTaskAction: controller.onTaskAction,
    labelOf: controller.labelOf
  });
  runtime.render = renderer.render;
  runtime.renderTabs = renderer.renderTabs;

  function switchTab(tab) {
    if (tab !== 'tasks' && tab !== 'history') return;
    if (state.activeTab === tab) return;
    state.activeTab = tab;
    runtime.renderTabs();
  }

  function init() {
    els.userSelectCloseBtn.addEventListener('click', controller.closeUserSelectionWithoutChanges);
    els.parentSubmit.addEventListener('click', controller.submitParentLogin);
    els.parentPin.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') controller.submitParentLogin();
    });
    els.parentCancel.addEventListener('click', controller.closeParentModal);

    els.cashoutBtn.addEventListener('click', controller.openCashoutModal);
    els.cashoutSubmit.addEventListener('click', controller.submitCashout);
    els.cashoutCancel.addEventListener('click', function () { els.cashoutModal.classList.add('hidden'); });

    els.tabTasks.addEventListener('click', function () { switchTab('tasks'); });
    els.tabHistory.addEventListener('click', function () { switchTab('history'); });

    els.userLabel.addEventListener('click', function (e) {
      e.stopPropagation();
      controller.toggleUserPopover();
    });
    document.addEventListener('click', function (e) {
      if (els.userPopover.classList.contains('hidden')) return;
      if (!els.userPopover.contains(e.target) && e.target !== els.userLabel) {
        controller.closeUserPopover();
      }
    });

    [els.parentModal, els.cashoutModal, els.settingsModal].forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        if (m === els.parentModal) controller.closeParentModal();
        else m.classList.add('hidden');
      });
    });

    if (els.settingsClose) els.settingsClose.addEventListener('click', function () {
      els.settingsModal.classList.add('hidden');
    });
    if (els.settingsPushRow) els.settingsPushRow.addEventListener('click', onTogglePush);
    if (els.settingsSoundRow) els.settingsSoundRow.addEventListener('click', onToggleSound);

    applyI18n();
    controller.bootstrap();
    setupBadgeClear();
    setupSoundUnlock();
    setupPullToRefresh();
    setupServiceWorkerMessages();
  }

  // ---- Settings ----
  function openSettingsModal() {
    syncSettingsToggles();
    els.settingsModal.classList.remove('hidden');
  }

  function syncSettingsToggles() {
    const pushOn = !!controller.isPushEnabled();
    setToggle(els.settingsPushToggle, pushOn);
    if (els.settingsPushRow) {
      const supported = !!controller.isPushSupported();
      els.settingsPushRow.disabled = !supported;
      els.settingsPushRow.style.opacity = supported ? '' : '0.55';
      els.settingsPushRow.style.pointerEvents = supported ? '' : 'none';
    }
    const sound = window.LESSERPAY_SOUND;
    const soundOn = sound ? !sound.isMuted() : true;
    setToggle(els.settingsSoundToggle, soundOn);
  }

  function setToggle(node, isOn) {
    if (!node) return;
    node.classList.toggle('is-on', !!isOn);
    node.setAttribute('aria-checked', isOn ? 'true' : 'false');
  }

  async function onTogglePush() {
    if (!controller.isPushSupported()) return;
    if (controller.isPushEnabled()) await controller.disablePush();
    else await controller.enablePush();
    syncSettingsToggles();
  }

  function onToggleSound() {
    const sound = window.LESSERPAY_SOUND;
    if (!sound) return;
    const muted = sound.toggleMuted();
    if (!muted) sound.play('toggle');
    syncSettingsToggles();
  }

  // ---- Refresh ----
  let refreshing = false;
  async function triggerRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await controller.loadData(true);
    } finally {
      refreshing = false;
    }
  }

  // ---- Pull-to-refresh ----
  function setupPullToRefresh() {
    if (!els.pullIndicator) return;
    let startY = null;
    let pulling = false;
    let dy = 0;
    const THRESHOLD = 70;
    const MAX = 110;

    function reset() {
      pulling = false;
      startY = null;
      dy = 0;
      els.pullIndicator.style.top = '';
      els.pullIndicator.style.transform = '';
      els.pullIndicator.classList.remove('is-visible');
    }

    document.addEventListener('touchstart', function (e) {
      if (refreshing) return;
      if (window.scrollY > 0) return;
      if (!e.touches || e.touches.length !== 1) return;
      // Skip if a modal/user-select is open
      if (!els.parentModal.classList.contains('hidden')) return;
      if (!els.cashoutModal.classList.contains('hidden')) return;
      if (!els.settingsModal.classList.contains('hidden')) return;
      if (!els.userSelectScreen.classList.contains('hidden')) return;
      startY = e.touches[0].clientY;
      pulling = true;
      dy = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!pulling || startY == null) return;
      const y = e.touches[0].clientY;
      dy = y - startY;
      if (dy <= 0) {
        reset();
        return;
      }
      const eased = Math.min(MAX, dy * 0.5);
      const top = -56 + eased;
      els.pullIndicator.style.top = top + 'px';
      els.pullIndicator.style.transform = 'translateX(-50%) rotate(' + (eased * 4) + 'deg)';
      els.pullIndicator.classList.add('is-visible');
    }, { passive: true });

    document.addEventListener('touchend', function () {
      if (!pulling) return;
      const triggered = dy > THRESHOLD * 2; // touchmove halves dy via easing
      if (triggered) {
        els.pullIndicator.style.transform = 'translateX(-50%)';
        els.pullIndicator.classList.add('is-loading');
        triggerRefresh().finally(function () {
          els.pullIndicator.classList.remove('is-loading');
          reset();
        });
      } else {
        reset();
      }
    }, { passive: true });

    document.addEventListener('touchcancel', reset, { passive: true });
  }

  // ---- Service Worker -> client messages (auto-reload on push) ----
  function setupServiceWorkerMessages() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', function (e) {
      const data = e.data || {};
      if (data.type === 'reload-data') {
        if (document.visibilityState === 'visible') {
          triggerRefresh();
        }
      }
    });
  }

  function setupSoundUnlock() {
    const sound = window.LESSERPAY_SOUND;
    if (!sound) return;
    function unlock() {
      sound.unlock();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    }
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  function clearBadge() {
    if (typeof navigator !== 'undefined' && 'clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(function () {});
    }
    // Reach the service worker even on first load (controller is null until
    // the first navigation through it). serviceWorker.ready resolves with the
    // active registration regardless.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg && reg.active) reg.active.postMessage({ type: 'clearBadge' });
      }).catch(function () {});
    }
  }

  function setupBadgeClear() {
    if (document.visibilityState === 'visible') clearBadge();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') clearBadge();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

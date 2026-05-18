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
    parentPassword: null,
    needsUserSelection: false,
    userSelectionClosable: false,
    selectionReturnState: null,
    pendingParentSwitchToast: false,
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
    setStatus: function (status) { STATUS = status; }
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
    els.parentPassword.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') controller.submitParentLogin();
    });
    els.parentCancel.addEventListener('click', controller.closeParentModal);

    els.cashoutBtn.addEventListener('click', controller.openCashoutModal);
    els.cashoutSubmit.addEventListener('click', controller.submitCashout);
    els.cashoutCancel.addEventListener('click', function () { els.cashoutModal.classList.add('hidden'); });

    els.tabTasks.addEventListener('click', function () { switchTab('tasks'); });
    els.tabHistory.addEventListener('click', function () { switchTab('history'); });
    els.refreshBtn.addEventListener('click', function () { controller.loadData(true); });

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

    [els.parentModal, els.cashoutModal].forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        if (m === els.parentModal) controller.closeParentModal();
        else m.classList.add('hidden');
      });
    });

    applyI18n();
    controller.bootstrap();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

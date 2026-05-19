(function () {
  'use strict';

  function create(deps) {
    const store = deps.store;
    const state = deps.state;
    const els = deps.els;
    const tr = deps.tr;
    const escapeHtml = deps.escapeHtml;
    const runtime = deps.runtime;

    function userKeys() {
      return state.serverUsers.map(function (u) { return u.key; });
    }

    function labelOf(key) {
      const found = state.serverUsers.find(function (u) { return u.key === key; });
      return found ? found.label : key;
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
        state.parentMode = false;
        state.parentPin = null;
        store.clearParentMode();
        data.clearDataCache();
        state.tasks = [];
        state.history = [];
      }
    }

    function renderUserPopover() {
      if (state.serverUsers.length === 0) {
        els.userPopoverList.innerHTML = '<li class="user-popover-empty">' + escapeHtml(tr('setup.needUsers')) + '</li>';
        return;
      }

      const childItems = state.parentMode ? state.serverUsers.map(function (_ref) {
          const key = _ref.key;
          const label = _ref.label;
          const isCurrent = key === state.user;
          return '\n<li class="user-popover-item ' + (isCurrent ? 'is-current' : '') + '">\n' +
            '  <button class="user-popover-pick" type="button" data-user="' + escapeHtml(key) + '">\n' +
            '    <span class="user-popover-mark">' + (isCurrent ? '✓' : '') + '</span>\n' +
            '    <span class="user-popover-name">' + escapeHtml(label) + '</span>\n' +
            '  </button>\n' +
            '</li>\n';
        }).join('') : '';

      const header = state.parentMode
        ? '<li class="user-popover-group-title">' + escapeHtml(tr('users.childSwitchTitle')) + '</li>'
        : '';
      const divider = state.parentMode ? '<li class="user-popover-divider" aria-hidden="true"></li>' : '';

      els.userPopoverList.innerHTML =
        header + childItems + divider +
        '<li class="user-popover-item">' +
        '  <button class="user-popover-pick user-popover-login-switch" type="button" data-action="switch-login-user">' +
        '    <span class="user-popover-name">👤 ' + escapeHtml(tr('users.loginSwitch')) + '</span>' +
        '  </button>' +
        '</li>' +
        '<li class="user-popover-item">' +
        '  <button class="user-popover-pick user-popover-settings" type="button" data-action="open-settings">' +
        '    <span class="user-popover-name">⚙️ ' + escapeHtml(tr('settings.open')) + '</span>' +
        '  </button>' +
        '</li>';

      els.userPopoverList.querySelectorAll('[data-user]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          switchUser(btn.dataset.user, { keepParentMode: true, toastKey: 'users.switchedDisplayToast' });
        });
      });
      const loginSwitchBtn = els.userPopoverList.querySelector('[data-action="switch-login-user"]');
      if (loginSwitchBtn) loginSwitchBtn.addEventListener('click', openLoginUserSelection);
      const settingsBtn = els.userPopoverList.querySelector('[data-action="open-settings"]');
      if (settingsBtn) settingsBtn.addEventListener('click', function () {
        closeUserPopover();
        if (deps.openSettings) deps.openSettings();
      });
    }

    function closeUserPopover() {
      els.userPopover.classList.add('hidden');
    }

    function toggleUserPopover() {
      if (state.needsUserSelection || !state.user) return;
      if (els.userPopover.classList.contains('hidden')) {
        renderUserPopover();
        els.userPopover.classList.remove('hidden');
      }
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
          parentPin: state.parentPin
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
        state.parentPin = null;
        store.clearParentMode();
      }
      const currentSelection = state.parentMode ? '__parent__' : state.user;
      els.userSelectList.innerHTML = state.serverUsers.map(function (_ref2) {
        const key = _ref2.key;
        const label = _ref2.label;
        const currentClass = key === currentSelection ? ' is-current' : '';
        return '<button class="user-select-btn' + currentClass + '" type="button" data-user-select="' + escapeHtml(key) + '">' +
          '<span class="user-select-icon" aria-hidden="true">🐾</span>' +
          '<span>' + escapeHtml(label) + '</span></button>';
      }).join('') +
      '<button class="user-select-btn is-parent' + (currentSelection === '__parent__' ? ' is-current' : '') + '" type="button" data-user-select="__parent__">' +
      '<span class="user-select-key" aria-hidden="true">🔑</span>' +
      '<span>' + escapeHtml(tr('userSelect.parent')) + '</span></button>';
      els.userSelectList.querySelectorAll('[data-user-select]').forEach(function (btn) {
        btn.addEventListener('click', function () { onUserSelect(btn.dataset.userSelect); });
      });
      els.userSelectCloseBtn.classList.toggle('hidden', !state.userSelectionClosable);
      els.userSelectScreen.classList.remove('hidden');
      runtime.render();
    }

    function hideUserSelection() {
      state.needsUserSelection = false;
      state.userSelectionClosable = false;
      state.selectionReturnState = null;
      els.userSelectScreen.classList.add('hidden');
      runtime.render();
    }

    function closeUserSelectionWithoutChanges() {
      if (!state.userSelectionClosable) return;
      if (state.selectionReturnState) {
        state.user = state.selectionReturnState.user;
        state.parentMode = state.selectionReturnState.parentMode;
        state.parentPin = state.selectionReturnState.parentPin;
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
          if (shouldToast) actions.toast(tr('users.switchedParentToast'), 'success');
          state.pendingParentSwitchToast = false;
          return;
        }
        openParentModal();
        return;
      }
      await switchUser(selection, {
        silent: !shouldToast,
        toastKey: 'users.switchedLoginToast',
        forceExitParentMode: true
      });
      hideUserSelection();
    }

    async function switchUser(key, options) {
      const opts = options || {};
      const forceExitParentMode = !!opts.forceExitParentMode;
      const sameUser = key === state.user;
      if (!key || (sameUser && !(forceExitParentMode && state.parentMode))) {
        closeUserPopover();
        return;
      }
      closeUserPopover();
      const keepParentMode = !!opts.keepParentMode && state.parentMode && !!state.parentPin;
      if (!sameUser) {
        state.user = key;
        store.setUser(key);
      }
      if (!keepParentMode) {
        state.parentMode = false;
        state.parentPin = null;
        store.clearParentMode();
      }
      data.clearDataCache();
      state.tasks = [];
      state.history = [];
      runtime.render();
      if (!opts.silent) {
        actions.toast(tr(opts.toastKey || 'users.switchedToast', { name: labelOf(key) }), 'success');
      }
      await data.loadData(true);
    }

    function openParentModal() {
      els.parentPin.value = '';
      els.parentError.classList.add('hidden');
      els.parentModal.classList.remove('hidden');
      setTimeout(function () { els.parentPin.focus(); }, 50);
    }

    async function tryAutoLoginParent() {
      if (state.parentMode) return true;
      const savedPin = store.getParentPin();
      if (!savedPin) return false;
      try {
        await data.api('verifyPin', { pin: savedPin });
        state.parentPin = savedPin;
        state.parentMode = true;
        store.setParentMode(true);
        runtime.render();
        return true;
      } catch (_err) {
        store.clearParentPin();
        store.clearParentMode();
        state.parentPin = null;
        return false;
      }
    }

    async function submitParentLogin() {
      const pin = els.parentPin.value;
      if (!pin) {
        els.parentError.textContent = tr('parent.needPin');
        els.parentError.classList.remove('hidden');
        return;
      }
      els.parentSubmit.disabled = true;
      const original = els.parentSubmit.textContent;
      els.parentSubmit.textContent = tr('parent.checking');
      try {
        await data.api('verifyPin', { pin: pin });
        state.parentPin = pin;
        state.parentMode = true;
        store.setParentPin(pin);
        store.setParentMode(true);
        els.parentModal.classList.add('hidden');
        hideUserSelection();
        runtime.render();
        if (state.pendingParentSwitchToast) {
          actions.toast(tr('users.switchedParentToast'), 'success');
        }
      } catch (err) {
        state.parentPin = null;
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

    const data = window.LESSERPAY_CONTROLLER_DATA.create({
      CONFIG: deps.CONFIG,
      store: store,
      state: state,
      tr: tr,
      runtime: runtime,
      setStatus: deps.setStatus,
      reconcileActiveUser: reconcileActiveUser,
      userKeys: userKeys,
      showUserSelection: showUserSelection,
      openParentModal: openParentModal,
      tryAutoLoginParent: tryAutoLoginParent,
      toast: function (msg, kind) { actions.toast(msg, kind); }
    });

    const actions = window.LESSERPAY_CONTROLLER_ACTIONS.create({
      state: state,
      els: els,
      tr: tr,
      api: data.api,
      loadData: data.loadData,
      clearDataCache: data.clearDataCache
    });

    return {
      labelOf: labelOf,
      toggleUserPopover: toggleUserPopover,
      closeUserPopover: closeUserPopover,
      closeUserSelectionWithoutChanges: closeUserSelectionWithoutChanges,
      submitParentLogin: submitParentLogin,
      closeParentModal: closeParentModal,
      openCashoutModal: actions.openCashoutModal,
      submitCashout: actions.submitCashout,
      loadData: data.loadData,
      bootstrap: data.bootstrap,
      onTaskAction: actions.onTaskAction,
      enablePush: data.enablePush,
      disablePush: data.disablePush,
      isPushEnabled: data.isPushEnabled,
      isPushSupported: data.isPushSupported,
      pushPermission: data.pushPermission
    };
  }

  window.LESSERPAY_CONTROLLER = { create: create };
})();

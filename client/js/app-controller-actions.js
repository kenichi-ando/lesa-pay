(function () {
  'use strict';

  function create(deps) {
    const state = deps.state;
    const els = deps.els;
    const tr = deps.tr;

    function toast(msg, kind) {
      const kindName = kind || '';
      els.toast.textContent = msg;
      els.toast.className = 'toast' + (kindName ? ' toast-' + kindName : '');
      els.toast.classList.remove('hidden');
      clearTimeout(toast._t);
      toast._t = setTimeout(function () {
        els.toast.classList.add('hidden');
      }, 2800);
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
          await deps.api('applyTask', { taskId: id });
          toast(tr('tasks.toastApplied'), 'success');
          deps.clearDataCache();
          await deps.loadData(true);
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
          await deps.api('approveTask', { taskId: id, password: state.parentPassword });
          toast(tr('tasks.toastApproved'), 'success');
          deps.clearDataCache();
          await deps.loadData(true);
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
          await deps.api('rejectTask', { taskId: id, password: state.parentPassword });
          toast(tr('tasks.toastRejected'));
          deps.clearDataCache();
          await deps.loadData(true);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      }
    }

    function openCashoutModal() {
      const total = state.history.reduce(function (s, h) { return s + (Number(h.points) || 0); }, 0);
      els.cashoutAmount.value = total > 0 ? String(total) : '';
      els.cashoutBalance.textContent = tr('cashout.balance', { total: total.toLocaleString() });
      els.cashoutError.classList.add('hidden');
      els.cashoutModal.classList.remove('hidden');
      setTimeout(function () { els.cashoutAmount.focus(); }, 50);
    }

    async function submitCashout() {
      const amount = parseInt(els.cashoutAmount.value, 10);
      if (!amount || amount <= 0) {
        els.cashoutError.textContent = tr('cashout.invalid');
        els.cashoutError.classList.remove('hidden');
        return;
      }
      const total = state.history.reduce(function (s, h) { return s + (Number(h.points) || 0); }, 0);
      if (amount > total) {
        els.cashoutError.textContent = tr('cashout.insufficient', { total: total });
        els.cashoutError.classList.remove('hidden');
        return;
      }
      if (!confirm(tr('cashout.confirm', { amount: amount }))) return;
      els.cashoutSubmit.disabled = true;
      els.cashoutSubmit.textContent = tr('cashout.processing');
      try {
        await deps.api('cashout', { amount: amount, password: state.parentPassword });
        els.cashoutModal.classList.add('hidden');
        toast(tr('cashout.toast', { amount: amount }), 'success');
        deps.clearDataCache();
        await deps.loadData(true);
      } catch (err) {
        els.cashoutError.textContent = err.message;
        els.cashoutError.classList.remove('hidden');
      } finally {
        els.cashoutSubmit.disabled = false;
        els.cashoutSubmit.textContent = tr('cashout.submit');
      }
    }

    return {
      toast: toast,
      onTaskAction: onTaskAction,
      openCashoutModal: openCashoutModal,
      submitCashout: submitCashout
    };
  }

  window.LESSERPAY_CONTROLLER_ACTIONS = { create: create };
})();

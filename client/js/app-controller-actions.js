(function () {
  'use strict';

  function create(deps) {
    const state = deps.state;
    const els = deps.els;
    const tr = deps.tr;
    const sound = window.LESSERPAY_SOUND || { play: function () {} };

    function flashRow(btn) {
      const row = btn && btn.closest ? btn.closest('.task-item') : null;
      if (!row) return;
      row.classList.remove('is-flash');
      // force reflow so the animation restarts on repeated triggers
      void row.offsetWidth;
      row.classList.add('is-flash');
      setTimeout(function () { row.classList.remove('is-flash'); }, 1000);
    }

    function popBalance() {
      const node = document.querySelector('.balance-number');
      if (node) {
        node.classList.remove('is-pop');
        void node.offsetWidth;
        node.classList.add('is-pop');
        setTimeout(function () { node.classList.remove('is-pop'); }, 800);
      }
      const card = document.querySelector('.balance-card');
      if (card) {
        card.classList.remove('is-glow');
        void card.offsetWidth;
        card.classList.add('is-glow');
        setTimeout(function () { card.classList.remove('is-glow'); }, 1000);
      }
    }

    function cheerLogo() {
      const node = document.querySelector('.app-logo');
      if (!node) return;
      node.classList.remove('is-cheer');
      void node.offsetWidth;
      node.classList.add('is-cheer');
      setTimeout(function () { node.classList.remove('is-cheer'); }, 700);
    }

    function confettiBurst(originEl) {
      if (!originEl) return;
      const rect = originEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const layer = document.createElement('div');
      layer.className = 'confetti-burst';
      layer.style.left = cx + 'px';
      layer.style.top = cy + 'px';
      const emojis = ['✨', '🎉', '⭐', '🎊', '💫', '🎈', '🌟', '🐾'];
      const N = 24;
      for (let i = 0; i < N; i++) {
        const span = document.createElement('span');
        span.className = 'confetti-piece';
        span.textContent = emojis[i % emojis.length];
        const angle = (Math.PI * 2 * i) / N + Math.random() * 0.4;
        const dist = 120 + Math.random() * 80;
        span.style.setProperty('--cx', Math.cos(angle) * dist + 'px');
        span.style.setProperty('--cy', Math.sin(angle) * dist + 'px');
        span.style.setProperty('--cr', (Math.random() * 720 - 360) + 'deg');
        span.style.animationDelay = (Math.random() * 80) + 'ms';
        layer.appendChild(span);
      }
      document.body.appendChild(layer);
      setTimeout(function () { layer.remove(); }, 1700);
    }

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
          sound.play('apply');
          flashRow(btn);
          toast(tr('tasks.toastApplied'), 'success');
          deps.clearDataCache();
          await deps.loadData(true);
        } catch (err) {
          sound.play('error');
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
          await deps.api('approveTask', { taskId: id, pin: state.parentPin });
          sound.play('approve');
          flashRow(btn);
          confettiBurst(btn);
          cheerLogo();
          popBalance();
          toast(tr('tasks.toastApproved'), 'success');
          deps.clearDataCache();
          await deps.loadData(true);
        } catch (err) {
          sound.play('error');
          toast(err.message, 'error');
          btn.disabled = false;
        }
        return;
      }

      if (action === 'reject') {
        if (!confirm(tr('tasks.confirmReject'))) return;
        btn.disabled = true;
        try {
          await deps.api('rejectTask', { taskId: id, pin: state.parentPin });
          sound.play('reject');
          flashRow(btn);
          toast(tr('tasks.toastRejected'));
          deps.clearDataCache();
          await deps.loadData(true);
        } catch (err) {
          sound.play('error');
          toast(err.message, 'error');
          btn.disabled = false;
        }
        return;
      }

      if (action === 'withdraw') {
        if (!confirm(tr('tasks.confirmWithdraw'))) return;
        btn.disabled = true;
        try {
          await deps.api('withdrawTask', { taskId: id });
          sound.play('reject');
          flashRow(btn);
          toast(tr('tasks.toastWithdrawn'));
          deps.clearDataCache();
          await deps.loadData(true);
        } catch (err) {
          sound.play('error');
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
        await deps.api('cashout', { amount: amount, pin: state.parentPin });
        els.cashoutModal.classList.add('hidden');
        sound.play('cashout');
        confettiBurst(document.querySelector('.balance-number'));
        popBalance();
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

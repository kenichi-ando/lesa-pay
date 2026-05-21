(function () {
  'use strict';

  function create(deps) {
    const state = deps.state;
    const els = deps.els;
    const tr = deps.tr;
    const getStatus = deps.getStatus;
    const escapeHtml = deps.escapeHtml;
    const formatMinutes = deps.formatMinutes;
    const formatDate = deps.formatDate;
    const isExpired = deps.isExpired;
    const onTaskAction = deps.onTaskAction;

    function formatRewards(task) {
      const status = getStatus();
      const sub = Number(task.submitReward) || 0;
      const com = Number(task.completeReward) || Number(task.points) || 0;
      const showSub = sub > 0 && task.status === status.PENDING;
      if (showSub && com > 0) {
        return '<span class="task-points">' + escapeHtml(tr('tasks.rewardBoth', {
          submit: sub.toLocaleString(),
          complete: com.toLocaleString()
        })) + '</span>';
      }
      if (com > 0) {
        return '<span class="task-points">' + escapeHtml(tr('tasks.rewardCompleteOnly', {
          complete: com.toLocaleString()
        })) + '</span>';
      }
      if (showSub) {
        return '<span class="task-points">' + escapeHtml(tr('tasks.rewardSubmitOnly', {
          submit: sub.toLocaleString()
        })) + '</span>';
      }
      return '';
    }

    function taskItemHtml(task) {
      const status = getStatus();
      const statusClass =
        task.status === status.SUBMITTED ? 'status-applied' :
        task.status === status.APPROVED ? 'status-approved' :
        task.status === status.RETURNED ? 'status-returned' : 'status-pending';

      const expired = isExpired(task.expiry);
      const expiryLabel = task.expiry
        ? tr('tasks.expiryLabel', { date: formatDate(task.expiry) }) + (expired ? ' ⚠️' : '')
        : '';

      let actionHtml = '';
      if (state.parentMode && task.status === status.SUBMITTED) {
        actionHtml = '\n        <div class="task-action-group">\n' +
          '          <button class="task-btn approve-btn" data-task-id="' + escapeHtml(task.id) + '" data-action="approve">' + escapeHtml(tr('tasks.approve')) + '</button>\n' +
          '          <button class="task-btn reject-btn" data-task-id="' + escapeHtml(task.id) + '" data-action="reject">' + escapeHtml(tr('tasks.reject')) + '</button>\n' +
          '        </div>\n      ';
      } else if (state.parentMode && (task.status === status.PENDING || task.status === status.RETURNED)) {
        actionHtml = '';
      } else if (task.status === status.PENDING) {
        actionHtml = '<button class="task-btn" data-task-id="' + escapeHtml(task.id) + '" data-action="apply" ' + (expired ? 'disabled' : '') + '>' + escapeHtml(tr('tasks.apply')) + '</button>';
      } else if (task.status === status.RETURNED) {
        actionHtml = '<button class="task-btn resubmit-btn" data-task-id="' + escapeHtml(task.id) + '" data-action="apply" ' + (expired ? 'disabled' : '') + '>' + escapeHtml(tr('tasks.resubmit')) + '</button>';
      } else if (task.status === status.SUBMITTED) {
        actionHtml = '<button class="task-btn withdraw-btn" data-task-id="' + escapeHtml(task.id) + '" data-action="withdraw" aria-label="' + escapeHtml(tr('tasks.withdraw')) + '">' + escapeHtml(tr('tasks.appliedBadge')) + '</button>';
      } else if (task.status === status.APPROVED) {
        actionHtml = '<span class="task-status-badge">' + escapeHtml(tr('tasks.approvedBadge')) + '</span>';
      }

      return '\n      <div class="task-item ' + statusClass + '">\n' +
        '        <div class="task-info">\n' +
        '          <div class="task-title">' + escapeHtml(task.title) + '</div>\n' +
        '          <div class="task-footer">\n' +
        '            ' + formatRewards(task) + '\n' +
        '            ' + (task.minutes ? '<span class="task-minutes">⏱ ' + escapeHtml(formatMinutes(task.minutes)) + '</span>' : '') + '\n' +
        '            ' + (expiryLabel ? '<span>' + expiryLabel + '</span>' : '') + '\n' +
        '          </div>\n' +
        '        </div>\n' +
        '        <div class="task-action">' + actionHtml + '</div>\n' +
        '      </div>\n    ';
    }

    function renderTabs() {
      const status = getStatus();
      const tab = state.activeTab;
      els.tabTasks.classList.toggle('is-active', tab === 'tasks');
      els.tabHistory.classList.toggle('is-active', tab === 'history');
      els.tabTasks.setAttribute('aria-selected', tab === 'tasks');
      els.tabHistory.setAttribute('aria-selected', tab === 'history');
      els.panelTasks.classList.toggle('hidden', tab !== 'tasks');
      els.panelHistory.classList.toggle('hidden', tab !== 'history');

      const targetStatus = state.parentMode ? status.SUBMITTED : status.RETURNED;
      const actionCount = state.tasks.filter(function (t) { return t.status === targetStatus; }).length;
      if (actionCount > 0) {
        els.tabTasksBadge.textContent = String(actionCount);
        els.tabTasksBadge.classList.remove('hidden');
      } else {
        els.tabTasksBadge.classList.add('hidden');
      }
    }

    function renderBalance() {
      const total = state.history.reduce(function (sum, h) { return sum + (Number(h.points) || 0); }, 0);
      els.balance.textContent = total.toLocaleString();
    }

    function renderTasks() {
      const status = getStatus();
      if (state.loading && state.tasks.length === 0) {
        els.tasksList.innerHTML = '<div class="empty-state is-loading">' + escapeHtml(tr('tasks.loading')) + '</div>';
        return;
      }
      const visible = state.tasks.filter(function (t) { return t.status !== status.APPROVED; });
      if (visible.length === 0) {
        els.tasksList.innerHTML = '<div class="empty-state">' + escapeHtml(tr('tasks.empty')) + '</div>';
        return;
      }

      const groups = new Map();
      visible.forEach(function (t) {
        const key = t.category || tr('tasks.otherGroup');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      });

      const sortedKeys = Array.from(groups.keys());
      els.tasksList.innerHTML = sortedKeys.map(function (key) {
        const items = groups.get(key);
        const pendingCount = items.filter(function (t) { return t.status === status.SUBMITTED; }).length;
        const pendingBadge = pendingCount > 0 ? '<span class="task-group-badge">' + escapeHtml(tr('tasks.pendingCount', { n: pendingCount })) + '</span>' : '';
        const totalMinutes = items
          .filter(function (t) { return t.status !== status.APPROVED && t.status !== status.SUBMITTED; })
          .reduce(function (sum, t) { return sum + (Number(t.minutes) || 0); }, 0);
        const timeBadge = totalMinutes > 0 ? '<span class="task-group-time">⏱ ' + escapeHtml(formatMinutes(totalMinutes)) + '</span>' : '';
        return '\n        <div class="task-group">\n' +
          '          <h3 class="task-group-title">' + escapeHtml(key) + timeBadge + pendingBadge + '</h3>\n' +
          '          <div class="task-group-items">\n' +
          '            ' + items.map(taskItemHtml).join('') + '\n' +
          '          </div>\n' +
          '        </div>\n      ';
      }).join('');

      els.tasksList.querySelectorAll('[data-task-id]').forEach(function (btn) {
        btn.addEventListener('click', onTaskAction);
      });
    }

    function renderHistory() {
      if (state.loading && state.history.length === 0) {
        els.historyList.innerHTML = '<div class="empty-state is-loading">' + escapeHtml(tr('history.loading')) + '</div>';
        return;
      }
      if (state.history.length === 0) {
        els.historyList.innerHTML = '<div class="empty-state">' + escapeHtml(tr('history.empty')) + '</div>';
        return;
      }
      const sorted = state.history.slice().sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      });
      const display = sorted.slice(0, 100);
      els.historyList.innerHTML = display.map(function (h) {
        const pts = Number(h.points) || 0;
        const sign = pts >= 0 ? '+' : '';
        const cls = pts >= 0 ? 'positive' : 'negative';
        return '\n        <div class="history-item">\n' +
          '          <div class="history-info">\n' +
          '            <div class="history-content">' + escapeHtml(h.content || '') + '</div>\n' +
          '            <div class="history-date">' + escapeHtml(h.date || '') + '</div>\n' +
          '          </div>\n' +
          '          <div class="history-points ' + cls + '">' + sign + pts.toLocaleString() + '</div>\n' +
          '        </div>\n      ';
      }).join('');
    }

    function render() {
      const total = state.history.reduce(function (sum, h) { return sum + (Number(h.points) || 0); }, 0);
      els.cashoutBtn.classList.toggle('hidden', !state.parentMode || total <= 0);
      if (state.user && !state.needsUserSelection) {
        const key = state.parentMode ? 'header.currentParent' : 'header.currentKid';
        els.userLabel.textContent = tr(key, { name: deps.labelOf(state.user) });
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

    return {
      render: render,
      renderTabs: renderTabs,
      renderBalance: renderBalance,
      renderTasks: renderTasks,
      renderHistory: renderHistory
    };
  }

  window.LESSERPAY_RENDER = { create: create };
})();

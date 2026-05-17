/**
 * LesaPay - Google Apps Script backend
 *
 * Manages multiple children in a single spreadsheet.
 * Each child has two sheets: 「課題_<name>」 and 「履歴_<name>」.
 * The client sends its own <name> in the `user` parameter on every request.
 *
 * Deployment:
 *  1. Create a spreadsheet
 *  2. Paste this code into a GAS project
 *  3. Project Settings → Script Properties:
 *       SHEET_ID        : Spreadsheet ID
 *       PARENT_PASSWORD : Parent password
 *       LINE_TOKEN      : (optional) LINE Messaging API channel access token.
 *                         Skip notifications if unset; broadcast to all friends if set.
 *       APP_URL         : (optional) App URL (e.g. https://lesa-pay-v1.web.app/)
 *                         If set, LINE notifications will include a "open in parent mode" link.
 *  4. Run setupSheets("ライト") with each child name to create the two sheets
 *  5. Deploy → Web app (Execute as: me / Access: anyone)
 *
 * Sheet layout:
 *  - 「課題_<name>」  : A=ID, B=Status, C=Subject, D=Category, E=Title, F=SubmitReward, G=CompleteReward, H=Minutes, I=Expiry
 *  - 「履歴_<name>」  : A=Date, B=Content, C=Points
 *
 * Status values (column B):
 *  - 空 / 未完了 : Not yet submitted (empty cells are auto-filled with 未完了 on read)
 *  - 申請中      : Child has submitted, waiting for parent approval
 *  - 差し戻し    : Parent rejected; submit reward is NOT granted again on resubmit
 *  - 承認済み    : Approved
 *
 * Design principles:
 *  - All actions go through the ACTIONS table (adding a new action = 1 row + handler)
 *  - State transition validation lives in GAS (do not trust the client)
 *  - Column indices are centralized in TASK_COL constants (column reorders stay safe)
 */

// ====================================================================
// Constants
// ====================================================================

// Task sheet columns (0-based). Add 1 when calling 1-based getRange.
const TASK_COL = {
  ID:              0,
  STATUS:          1,
  SUBJECT:         2,
  CATEGORY:        3,
  TITLE:           4,
  SUBMIT_REWARD:   5,
  COMPLETE_REWARD: 6,
  MINUTES:         7,
  EXPIRY:          8
};
const TASK_COL_COUNT = 9;

// History sheet columns
const HISTORY_COL = { DATE: 0, CONTENT: 1, POINTS: 2 };
const HISTORY_COL_COUNT = 3;

// Status values
const STATUS = {
  PENDING:    '未完了',
  APPLIED:    '申請中',
  REJECTED:   '差し戻し',
  APPROVED:   '承認済み'
};

const TASK_HEADERS    = ['ID', '状態', '科目', '分類', '項目', '提出報酬', '完了報酬', '時間', '期限'];
const HISTORY_HEADERS = ['日時', '内容', 'ポイント'];

// ====================================================================
// Sheet name + user validation
// ====================================================================

function tasksSheetName(user)   { return '課題_' + user; }
function historySheetName(user) { return '履歴_' + user; }

function isValidUser(user) {
  // Accept any string. Whether the sheet actually exists is checked via getSheetByName.
  return typeof user === 'string' && user.length > 0 && user.length <= 50;
}

// ====================================================================
// Action table (action name → handler + metadata)
//
// requireUser : true if the user parameter is required (sheet-bound action)
// handler     : takes (req) only
//
// To add a new action: add 1 row here + implement the handler function.
// Auth and state-transition validation are completed inside each handler
// (the client is not trusted).
// ====================================================================

const ACTIONS = {
  getData:        { requireUser: true,  handler: (req) => handleGetData(req.user) },
  applyTask:      { requireUser: true,  handler: (req) => handleApplyTask(req.user, req.taskId) },
  verifyPassword: { requireUser: false, handler: (req) => handleVerifyPassword(req.password) },
  approveTask:    { requireUser: true,  handler: (req) => handleApproveTask(req.user, req.taskId, req.password) },
  rejectTask:     { requireUser: true,  handler: (req) => handleRejectTask(req.user, req.taskId, req.password) },
  cashout:        { requireUser: true,  handler: (req) => handleCashout(req.user, req.amount, req.password) }
};

// ====================================================================
// Entry points
// ====================================================================

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const def = ACTIONS[req.action];
    if (!def) throw new Error('未対応のアクション: ' + req.action);
    if (def.requireUser && !isValidUser(req.user)) {
      throw new Error('不正な user パラメータ: ' + req.user);
    }
    const result = def.handler(req);
    return jsonOut({ ok: true, ...result });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message || String(err) });
  }
}

function doGet() {
  return jsonOut({ ok: true, message: 'LesaPay GAS API is running' });
}

// ====================================================================
// Common utilities
// ====================================================================

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

function checkPassword(password) {
  const expected = PropertiesService.getScriptProperties().getProperty('PARENT_PASSWORD');
  if (!expected) throw new Error('PARENT_PASSWORD が未設定です');
  if (password !== expected) throw new Error('パスワードが違います');
}

// Send a notification via LINE Messaging API broadcast (to everyone who friended the official account).
// Skip silently if LINE_TOKEN is not set. Failures are logged but never break the app flow.
function notify(subject, body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_TOKEN');
  if (!token) return;
  const appUrl = props.getProperty('APP_URL');
  let message = '【' + subject + '】\n' + body;
  if (appUrl) {
    // Opening with ?parent=1 makes the frontend show the parent login dialog automatically.
    const url = appUrl + (appUrl.indexOf('?') >= 0 ? '&' : '?') + 'parent=1';
    message += '\n\n👨‍👩‍👧 保護者モードで開く:\n' + url;
  }
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({
        messages: [{ type: 'text', text: message }]
      }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code !== 200) {
      Logger.log('LINE送信失敗 (' + code + '): ' + res.getContentText());
    }
  } catch (err) {
    Logger.log('LINE送信失敗: ' + err.message);
  }
}

// Get the task sheet (throws if missing).
function getTaskSheet(ss, user) {
  const name = tasksSheetName(user);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シートがありません: ' + name);
  return sheet;
}

// Get the history sheet (throws if missing).
function getHistorySheet(ss, user) {
  const name = historySheetName(user);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シートがありません: ' + name);
  return sheet;
}

// Common wrapper that takes a script lock and runs `fn`.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Locate the row matching taskId in the task sheet and run `fn` against it.
// fn(rowValues, rowIndex, sheet) is invoked; its return value is propagated.
// Throws if no row matches.
function findTaskRow(sheet, taskId, fn) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('課題が見つかりません');
  const values = sheet.getRange(2, 1, lastRow - 1, TASK_COL_COUNT).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][TASK_COL.ID]) === String(taskId)) {
      return fn(values[i], i + 2, sheet); // i + 2 is the 1-based row index
    }
  }
  throw new Error('該当する課題が見つかりません');
}

// Update the status (column B) of a task row.
function setTaskStatus(sheet, rowIndex, status) {
  sheet.getRange(rowIndex, TASK_COL.STATUS + 1).setValue(status);
}

// ====================================================================
// Handlers
// ====================================================================

function handleGetData(user) {
  const ss = getSpreadsheet();
  // C-4: reject typo'd user names (sheet not found) at setup time.
  if (!ss.getSheetByName(tasksSheetName(user)) || !ss.getSheetByName(historySheetName(user))) {
    throw new Error('シートが見つかりません: 課題_' + user + ' / 履歴_' + user);
  }
  return {
    tasks:   readTasks(ss, tasksSheetName(user)),
    history: readHistory(ss, historySheetName(user))
  };
}

function handleApplyTask(user, taskId) {
  if (!taskId) throw new Error('taskId が未指定');
  const ss = getSpreadsheet();
  const sheet = getTaskSheet(ss, user);

  const notifyPayload = withLock(() => {
    return findTaskRow(sheet, taskId, (row, rowIndex) => {
      const status = row[TASK_COL.STATUS] || STATUS.PENDING;
      if (status === STATUS.APPLIED)  throw new Error('すでに申請中です');
      if (status === STATUS.APPROVED) throw new Error('すでに承認済みです');

      const expiry = row[TASK_COL.EXPIRY];
      if (expiry !== '' && expiry != null) {
        const d = isDateLike(expiry) ? new Date(expiry.getTime()) : new Date(expiry);
        if (!isNaN(d.getTime()) && d < truncDate(new Date())) {
          throw new Error('期限切れです');
        }
      }

      const submitReward   = Number(row[TASK_COL.SUBMIT_REWARD])   || 0;
      const completeReward = Number(row[TASK_COL.COMPLETE_REWARD]) || 0;
      const subject        = String(row[TASK_COL.SUBJECT] || '');
      const title          = String(row[TASK_COL.TITLE]   || '');
      // Grant the submit reward only on the first submission (未完了→申請中).
      // Skip it on resubmit from 差し戻し.
      const isFirstSubmit  = status !== STATUS.REJECTED;

      if (isFirstSubmit && submitReward > 0) {
        const histSheet = getHistorySheet(ss, user);
        const content = (subject ? subject + ' ' : '') + title + ' (提出)';
        histSheet.appendRow([formatDateTime(new Date()), content, submitReward]);
        SpreadsheetApp.flush();
      }
      setTaskStatus(sheet, rowIndex, STATUS.APPLIED);

      return {
        subject: subject,
        title: title,
        completeReward: completeReward,
        submitReward: isFirstSubmit ? submitReward : 0
      };
    });
  });

  // Notify after releasing the lock so a slow notification does not extend the lock.
  notify(user + 'から完了報告', buildApplyNotifyBody(user, notifyPayload));
  return { taskId };
}

function buildApplyNotifyBody(user, p) {
  let body = user + ' が「' + (p.subject ? p.subject + ' ' : '') + p.title + '」を完了報告しました。\n';
  if (p.submitReward > 0) {
    body += '提出報酬: ' + p.submitReward + ' pt (付与済み)\n';
  }
  body += '完了報酬: ' + p.completeReward + ' pt (承認後に付与)\n\nアプリで承認してください。';
  return body;
}

function handleVerifyPassword(password) {
  checkPassword(password);
  return { verified: true };
}

function handleApproveTask(user, taskId, password) {
  checkPassword(password);
  if (!taskId) throw new Error('taskId が未指定');

  const ss = getSpreadsheet();
  const taskSheet = getTaskSheet(ss, user);
  const histSheet = getHistorySheet(ss, user);

  return withLock(() => {
    return findTaskRow(taskSheet, taskId, (row, rowIndex) => {
      const status = row[TASK_COL.STATUS] || STATUS.PENDING;
      // C-1: only 申請中 tasks can be approved.
      if (status === STATUS.APPROVED) throw new Error('すでに承認済みです');
      if (status !== STATUS.APPLIED)  throw new Error('申請中の課題ではありません (現在: ' + status + ')');

      const subject = String(row[TASK_COL.SUBJECT] || '');
      const title   = String(row[TASK_COL.TITLE]   || '');
      const points  = Number(row[TASK_COL.COMPLETE_REWARD]) || 0;
      const content = subject ? subject + ' ' + title : title;

      // H-1: append history → flush → update status, to avoid a half-committed state on partial failure.
      histSheet.appendRow([formatDateTime(new Date()), content, points]);
      SpreadsheetApp.flush();
      setTaskStatus(taskSheet, rowIndex, STATUS.APPROVED);

      return { taskId, points };
    });
  });
}

function handleRejectTask(user, taskId, password) {
  checkPassword(password);
  if (!taskId) throw new Error('taskId が未指定');

  const sheet = getTaskSheet(getSpreadsheet(), user);

  return withLock(() => {
    return findTaskRow(sheet, taskId, (row, rowIndex) => {
      const status = row[TASK_COL.STATUS] || STATUS.PENDING;
      // C-2: prevent rejecting an already-approved task (history already credited; stop double-pay).
      if (status === STATUS.APPROVED) throw new Error('承認済みの課題は訂正依頼できません');
      // Move to 差し戻し (marker that suppresses the submit reward on resubmit).
      setTaskStatus(sheet, rowIndex, STATUS.REJECTED);
      return { taskId };
    });
  });
}

function handleCashout(user, amount, password) {
  checkPassword(password);
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new Error('金額が不正です');

  const ss = getSpreadsheet();
  const sheet = getHistorySheet(ss, user);
  const sheetName = historySheetName(user);

  const result = withLock(() => {
    const total = readHistory(ss, sheetName)
      .reduce((s, h) => s + (Number(h.points) || 0), 0);
    if (amt > total) throw new Error('残高不足です (現在 ' + total + ' pt)');
    sheet.appendRow([formatDateTime(new Date()), 'ポイント消費', -amt]);
    return { amount: amt, balance: total - amt };
  });

  notify(
    user + 'のポイント消費',
    user + ' が ' + amt + ' pt を使いました。\n残高: ' + result.balance + ' pt'
  );
  return result;
}

// ====================================================================
// Sheet readers
// ====================================================================

function generateTaskId() {
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 6);
  return 'T' + ts + '_' + rand;
}

function readTasks(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, TASK_COL_COUNT).getValues();

  // Auto-fill missing IDs and default status (empty cells become 未完了).
  let dirty = false;
  for (let i = 0; i < rows.length; i++) {
    const hasTitle = rows[i][TASK_COL.TITLE]  !== '' && rows[i][TASK_COL.TITLE]  != null;
    const hasId    = rows[i][TASK_COL.ID]     !== '' && rows[i][TASK_COL.ID]     != null;
    const hasState = rows[i][TASK_COL.STATUS] !== '' && rows[i][TASK_COL.STATUS] != null;
    if (hasTitle && !hasId) {
      const id = generateTaskId();
      rows[i][TASK_COL.ID] = id;
      sheet.getRange(i + 2, TASK_COL.ID + 1).setValue(id);
      dirty = true;
    }
    if (hasTitle && !hasState) {
      rows[i][TASK_COL.STATUS] = STATUS.PENDING;
      sheet.getRange(i + 2, TASK_COL.STATUS + 1).setValue(STATUS.PENDING);
      dirty = true;
    }
  }
  if (dirty) SpreadsheetApp.flush();

  return rows
    .filter((r) => r[TASK_COL.ID] !== '' && r[TASK_COL.TITLE] !== '')
    .map((r) => ({
      id:             String(r[TASK_COL.ID]),
      status:         String(r[TASK_COL.STATUS] || STATUS.PENDING),
      subject:        String(r[TASK_COL.SUBJECT]  || ''),
      category:       String(r[TASK_COL.CATEGORY] || ''),
      title:          String(r[TASK_COL.TITLE]    || ''),
      submitReward:   Number(r[TASK_COL.SUBMIT_REWARD])   || 0,
      completeReward: Number(r[TASK_COL.COMPLETE_REWARD]) || 0,
      points:         Number(r[TASK_COL.COMPLETE_REWARD]) || 0, // back-compat: legacy `points` field
      minutes:        Number(r[TASK_COL.MINUTES]) || 0,
      expiry:         toDateString(r[TASK_COL.EXPIRY])
    }));
}

function readHistory(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, HISTORY_COL_COUNT).getValues();
  return rows
    .filter((r) => r[HISTORY_COL.DATE] !== '' || r[HISTORY_COL.CONTENT] !== '' || r[HISTORY_COL.POINTS] !== '')
    .map((r) => ({
      date:    toDateTimeString(r[HISTORY_COL.DATE]),
      content: String(r[HISTORY_COL.CONTENT] || ''),
      points:  Number(r[HISTORY_COL.POINTS]) || 0
    }));
}

// ====================================================================
// Date utilities
// ====================================================================

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

function formatDateTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

function isDateLike(v) {
  if (v == null) return false;
  if (v instanceof Date) return true;
  return typeof v === 'object' && typeof v.getTime === 'function' && !isNaN(v.getTime());
}

function toDateString(v) {
  if (v === '' || v == null) return '';
  if (isDateLike(v)) return formatDate(new Date(v.getTime()));
  const parsed = new Date(v);
  if (!isNaN(parsed.getTime())) return formatDate(parsed);
  return String(v);
}

function toDateTimeString(v) {
  if (v === '' || v == null) return '';
  if (isDateLike(v)) return formatDateTime(new Date(v.getTime()));
  const parsed = new Date(v);
  if (!isNaN(parsed.getTime())) return formatDateTime(parsed);
  return String(v);
}

function truncDate(d) {
  d.setHours(0, 0, 0, 0);
  return d;
}

// ====================================================================
// Initial setup
// ====================================================================

/**
 * Create the two sheets for one child. Call from the GAS editor via a throwaway wrapper:
 *   function tmp() { setupSheets('ライト'); }
 */
function setupSheets(user) {
  if (!user) throw new Error('user が未指定。例: setupSheets("ライト")');
  const ss = getSpreadsheet();
  ensureSheet(ss, tasksSheetName(user),   TASK_HEADERS);
  ensureSheet(ss, historySheetName(user), HISTORY_HEADERS);
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

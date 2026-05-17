/**
 * LesaPay - Google Apps Script バックエンド
 *
 * 1スプレッドシートで複数の子を管理。
 * 子ごとに「課題_<名前>」「履歴_<名前>」の2枚を作る。
 * クライアントは自分の <名前> を毎回 user パラメータで送る。
 *
 * デプロイ手順:
 *  1. スプレッドシートを1つ作成
 *  2. このコードをGASにコピー
 *  3. プロジェクトの設定 → スクリプトプロパティ:
 *       SHEET_ID        : スプレッドシートのID
 *       PARENT_PASSWORD : 保護者用パスワード
 *  4. setupSheets("ライト") のように子の名前を渡して実行 → 2シート自動作成
 *  5. デプロイ → ウェブアプリ (実行: 自分 / アクセス: 全員)
 *
 * シート構成:
 *  - 「課題_<名前>」 : A=ID, B=科目, C=分類, D=項目, E=報酬, F=状態, G=期限
 *  - 「履歴_<名前>」 : A=日時, B=内容, C=ポイント
 */

function tasksSheetName(user)   { return '課題_' + user; }
function historySheetName(user) { return '履歴_' + user; }

function isValidUser(user) {
  // 任意の文字列を許可。シートが実在するかは getSheetByName で判定。
  return typeof user === 'string' && user.length > 0 && user.length <= 50;
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const action = req.action;
    const user = req.user;

    // user 不要なアクション
    const userlessActions = { verifyPassword: true };
    if (!userlessActions[action] && !isValidUser(user)) {
      throw new Error('不正な user パラメータ: ' + user);
    }

    let result;
    switch (action) {
      case 'getData':         result = handleGetData(user); break;
      case 'applyTask':       result = handleApplyTask(user, req.taskId); break;
      case 'verifyPassword':  result = handleVerifyPassword(req.password); break;
      case 'approveTask':     result = handleApproveTask(user, req.taskId, req.password); break;
      case 'rejectTask':      result = handleRejectTask(user, req.taskId, req.password); break;
      case 'cashout':         result = handleCashout(user, req.amount, req.password); break;
      default: throw new Error('未対応のアクション: ' + action);
    }
    return jsonOut({ ok: true, ...result });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message || String(err) });
  }
}

function doGet() {
  return jsonOut({ ok: true, message: 'LesaPay GAS API is running' });
}

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

// 通知メールを送信。NOTIFY_EMAILS (カンマ区切り) が未設定ならスキップ。
// メール送信失敗はアプリ動作を止めないようログだけ残す。
function notify(subject, body) {
  const raw = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAILS');
  if (!raw) return;
  const recipients = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (recipients.length === 0) return;
  try {
    MailApp.sendEmail({
      to: recipients.join(','),
      subject: '[LesaPay] ' + subject,
      body: body
    });
  } catch (err) {
    Logger.log('メール送信失敗: ' + err.message);
  }
}

// ---------- handlers ----------

function handleGetData(user) {
  const ss = getSpreadsheet();
  // C-4: シートが存在しない user (タイポ等) はセットアップ時に弾く
  const taskSheet = ss.getSheetByName(tasksSheetName(user));
  const historySheet = ss.getSheetByName(historySheetName(user));
  if (!taskSheet || !historySheet) {
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
  const sheetName = tasksSheetName(user);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('シートがありません: ' + sheetName);

  let notifyPayload = null;
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('課題が見つかりません');
    const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]) === String(taskId)) {
        const status = values[i][5];
        if (status === '申請中') throw new Error('すでに申請中です');
        if (status === '承認済み') throw new Error('すでに承認済みです');
        const expiry = values[i][6];
        if (expiry !== '' && expiry != null) {
          const expiryDate = isDateLike(expiry) ? new Date(expiry.getTime()) : new Date(expiry);
          if (!isNaN(expiryDate.getTime()) && expiryDate < truncDate(new Date())) {
            throw new Error('期限切れです');
          }
        }
        sheet.getRange(i + 2, 6).setValue('申請中');
        notifyPayload = {
          subject: String(values[i][1] || ''),
          title:   String(values[i][3] || ''),
          points:  Number(values[i][4]) || 0
        };
        break;
      }
    }
    if (!notifyPayload) throw new Error('該当する課題が見つかりません');
  } finally {
    lock.releaseLock();
  }

  // ロック解放後に通知 (メール送信が遅くてもロックを長引かせない)
  notify(
    user + 'から完了報告',
    user + ' が「' + (notifyPayload.subject ? notifyPayload.subject + ' ' : '') + notifyPayload.title + '」(' + notifyPayload.points + 'pt) を完了報告しました。\n\nアプリで承認してください。'
  );
  return { taskId };
}

function handleVerifyPassword(password) {
  checkPassword(password);
  return { verified: true };
}

function handleApproveTask(user, taskId, password) {
  checkPassword(password);
  if (!taskId) throw new Error('taskId が未指定');

  const ss = getSpreadsheet();
  const taskSheetName = tasksSheetName(user);
  const taskSheet = ss.getSheetByName(taskSheetName);
  if (!taskSheet) throw new Error('シートがありません: ' + taskSheetName);
  const historyName = historySheetName(user);
  const historySheet = ss.getSheetByName(historyName);
  if (!historySheet) throw new Error('シートがありません: ' + historyName);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const lastRow = taskSheet.getLastRow();
    if (lastRow < 2) throw new Error('課題が見つかりません');
    const values = taskSheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]) === String(taskId)) {
        const status = values[i][5];
        // C-1: 申請中の課題のみ承認可能
        if (status === '承認済み') throw new Error('すでに承認済みです');
        if (status !== '申請中') throw new Error('申請中の課題ではありません (現在: ' + (status || '未完了') + ')');
        // H-1: 履歴追加→flush→状態更新の順で部分失敗を防ぐ
        const subject = String(values[i][1] || '');
        const title   = String(values[i][3] || '');
        const points  = Number(values[i][4]) || 0;
        const content = subject ? subject + ' ' + title : title;
        historySheet.appendRow([formatDateTime(new Date()), content, points]);
        SpreadsheetApp.flush();
        taskSheet.getRange(i + 2, 6).setValue('承認済み');
        return { taskId, points };
      }
    }
    throw new Error('該当する課題が見つかりません');
  } finally {
    lock.releaseLock();
  }
}

function handleRejectTask(user, taskId, password) {
  checkPassword(password);
  if (!taskId) throw new Error('taskId が未指定');

  const ss = getSpreadsheet();
  const sheetName = tasksSheetName(user);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('シートがありません: ' + sheetName);

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('課題が見つかりません');
    const values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]) === String(taskId)) {
        const status = values[i][5];
        // C-2: 承認済みの却下を防ぐ (履歴に既に記録されているため二重取り防止)
        if (status === '承認済み') {
          throw new Error('承認済みの課題は却下できません');
        }
        sheet.getRange(i + 2, 6).setValue('未完了');
        return { taskId };
      }
    }
    throw new Error('該当する課題が見つかりません');
  } finally {
    lock.releaseLock();
  }
}

function handleCashout(user, amount, password) {
  checkPassword(password);
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new Error('金額が不正です');

  const ss = getSpreadsheet();
  const sheetName = historySheetName(user);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('シートがありません: ' + sheetName);

  let result;
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const total = readHistory(ss, sheetName)
      .reduce((s, h) => s + (Number(h.points) || 0), 0);
    if (amt > total) throw new Error('残高不足です (現在 ' + total + ' pt)');
    sheet.appendRow([formatDateTime(new Date()), 'お小遣い換金', -amt]);
    result = { amount: amt, balance: total - amt };
  } finally {
    lock.releaseLock();
  }

  notify(
    user + 'の換金完了',
    user + ' が ' + amt + ' pt を換金しました。\n残高: ' + result.balance + ' pt'
  );
  return result;
}

// ---------- sheet readers ----------

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
  const range = sheet.getRange(2, 1, lastRow - 1, 7);
  const rows = range.getValues();

  let dirty = false;
  for (let i = 0; i < rows.length; i++) {
    const hasTitle = rows[i][3] !== '' && rows[i][3] != null;
    const hasId = rows[i][0] !== '' && rows[i][0] != null;
    if (hasTitle && !hasId) {
      const id = generateTaskId();
      rows[i][0] = id;
      sheet.getRange(i + 2, 1).setValue(id);
      dirty = true;
    }
  }
  if (dirty) SpreadsheetApp.flush();

  return rows
    .filter((r) => r[0] !== '' && r[3] !== '')
    .map((r) => ({
      id: String(r[0]),
      subject: String(r[1] || ''),
      category: String(r[2] || ''),
      title: String(r[3] || ''),
      points: Number(r[4]) || 0,
      status: String(r[5] || '未完了'),
      expiry: toDateString(r[6])
    }));
}

function readHistory(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  return rows
    .filter((r) => r[0] !== '' || r[1] !== '' || r[2] !== '')
    .map((r) => ({
      date: toDateTimeString(r[0]),
      content: String(r[1] || ''),
      points: Number(r[2]) || 0
    }));
}

// ---------- utils ----------

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

// ---------- 初期セットアップ ----------

/**
 * 子ども1人分のシートを作成。GASエディタで関数を選んで実行。
 * 引数を直接渡せない場合は、下の setupSheetsLight / setupSheetsTiara のように
 * ラッパー関数を作って実行する。
 */
function setupSheets(user) {
  if (!user) throw new Error('user が未指定。例: setupSheets("ライト")');
  const ss = getSpreadsheet();
  const taskHeaders = ['ID', '科目', '分類', '項目', '報酬', '状態', '期限'];
  const historyHeaders = ['日時', '内容', 'ポイント'];
  ensureSheet(ss, tasksSheetName(user), taskHeaders);
  ensureSheet(ss, historySheetName(user), historyHeaders);
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

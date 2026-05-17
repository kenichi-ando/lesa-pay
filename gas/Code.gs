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
 *       NOTIFY_EMAILS   : (任意) 通知メール先 (カンマ区切り)
 *  4. setupSheets("ライト") のように子の名前を渡して実行 → 2シート自動作成
 *  5. デプロイ → ウェブアプリ (実行: 自分 / アクセス: 全員)
 *
 * シート構成:
 *  - 「課題_<名前>」  : A=ID, B=状態, C=科目, D=分類, E=項目, F=提出報酬, G=完了報酬, H=時間(分), I=期限
 *  - 「履歴_<名前>」  : A=日時, B=内容, C=ポイント
 *
 * 状態 (B列) の値:
 *  - 空 / 未完了 : 未提出 (空欄は読み込み時に「未完了」を自動セット)
 *  - 申請中      : 子が完了報告済み、親の承認待ち
 *  - 差し戻し    : 親が訂正依頼。再提出時に提出報酬は付与されない
 *  - 承認済み    : 完了
 *
 * 設計原則:
 *  - 全アクションを ACTIONS テーブルにマップ (新規追加は1行 + ハンドラ)
 *  - 状態遷移バリデーションは GAS で完結 (クライアントを信頼しない)
 *  - 列インデックスは TASK_COL 定数に集約 (列順変更に強い)
 */

// ====================================================================
// 定数
// ====================================================================

// 課題シートの列 (0-based)。1-based が必要な場合は +1 する。
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

// 履歴シートの列
const HISTORY_COL = { DATE: 0, CONTENT: 1, POINTS: 2 };
const HISTORY_COL_COUNT = 3;

// 状態
const STATUS = {
  PENDING:    '未完了',
  APPLIED:    '申請中',
  REJECTED:   '差し戻し',
  APPROVED:   '承認済み'
};

const TASK_HEADERS    = ['ID', '状態', '科目', '分類', '項目', '提出報酬', '完了報酬', '時間', '期限'];
const HISTORY_HEADERS = ['日時', '内容', 'ポイント'];

// ====================================================================
// シート名・ユーザバリデーション
// ====================================================================

function tasksSheetName(user)   { return '課題_' + user; }
function historySheetName(user) { return '履歴_' + user; }

function isValidUser(user) {
  // 任意の文字列を許可。シートが実在するかは getSheetByName で判定。
  return typeof user === 'string' && user.length > 0 && user.length <= 50;
}

// ====================================================================
// アクション定義 (アクション名 → ハンドラ + メタ情報)
//
// requireUser    : true なら user パラメータ必須 (シート紐付き)
// handler        : 引数は (req) のみ
//
// 新しいアクション追加: 1 行 + 対応する handle... 関数を実装するだけ。
// 認証・状態遷移バリデーションは各ハンドラで完結させる (クライアント不信)。
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
// エントリポイント
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
// 共通ユーティリティ
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

// 通知メールを送信。NOTIFY_EMAILS (カンマ区切り) が未設定ならスキップ。
// 送信失敗はログだけ残してアプリ動作は止めない。
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

// 課題シートを取得 (なければエラー)
function getTaskSheet(ss, user) {
  const name = tasksSheetName(user);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シートがありません: ' + name);
  return sheet;
}

// 履歴シートを取得 (なければエラー)
function getHistorySheet(ss, user) {
  const name = historySheetName(user);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シートがありません: ' + name);
  return sheet;
}

// ロックを取って fn を実行する共通ラッパー。
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 課題シートで taskId に一致する行を見つけて、コールバックで操作する共通処理。
// fn(rowValues, rowIndex, sheet) を呼び出す。fn の戻り値が呼び出し元に渡される。
// 該当行が無ければエラー。
function findTaskRow(sheet, taskId, fn) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('課題が見つかりません');
  const values = sheet.getRange(2, 1, lastRow - 1, TASK_COL_COUNT).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][TASK_COL.ID]) === String(taskId)) {
      return fn(values[i], i + 2, sheet); // i + 2 は 1-based 行番号
    }
  }
  throw new Error('該当する課題が見つかりません');
}

// 課題行の状態 (B列) を更新。
function setTaskStatus(sheet, rowIndex, status) {
  sheet.getRange(rowIndex, TASK_COL.STATUS + 1).setValue(status);
}

// ====================================================================
// ハンドラ
// ====================================================================

function handleGetData(user) {
  const ss = getSpreadsheet();
  // C-4: シートが存在しない user (タイポ等) はセットアップ時に弾く
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
      // 1回目の提出 (未完了→申請中) のみ提出報酬を付与。差し戻し→申請中はスキップ。
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

  // ロック解放後に通知 (メール送信が遅くてもロックを長引かせない)
  notify(user + 'から完了報告', buildApplyMailBody(user, notifyPayload));
  return { taskId };
}

function buildApplyMailBody(user, p) {
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
      // C-1: 申請中の課題のみ承認可能
      if (status === STATUS.APPROVED) throw new Error('すでに承認済みです');
      if (status !== STATUS.APPLIED)  throw new Error('申請中の課題ではありません (現在: ' + status + ')');

      const subject = String(row[TASK_COL.SUBJECT] || '');
      const title   = String(row[TASK_COL.TITLE]   || '');
      const points  = Number(row[TASK_COL.COMPLETE_REWARD]) || 0;
      const content = subject ? subject + ' ' + title : title;

      // H-1: 履歴追加→flush→状態更新の順で部分失敗を防ぐ
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
      // C-2: 承認済みの差し戻しを防ぐ (履歴に既に記録されているため二重取り防止)
      if (status === STATUS.APPROVED) throw new Error('承認済みの課題は訂正依頼できません');
      // 「差し戻し」状態にする (=再提出時に提出報酬を付与しないマーカー)
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
// シート読み取り
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

  // ID 自動採番 + 状態の初期値 (空欄は「未完了」)
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
      points:         Number(r[TASK_COL.COMPLETE_REWARD]) || 0, // 互換: 旧 points
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
// 日時ユーティリティ
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
// 初期セットアップ
// ====================================================================

/**
 * 子ども1人分のシートを作成。GASエディタから tmp() のような使い捨て関数で呼ぶ:
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

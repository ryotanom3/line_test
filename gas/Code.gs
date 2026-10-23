/**
 * LIFF x LINE 連携 ホットモック (GAS / スプレッドシート結合スクリプト)
 *
 * スクリプトプロパティ:
 *   LOGIN_CHANNEL_ID : LINEログインチャネルのチャネルID (IDトークン検証の client_id)
 *   MESSAGING_TOKEN  : Messaging API のチャネルアクセストークン(長期)
 *   ADMIN_KEY        : 管理画面用の合言葉(任意の文字列)
 *   LIFF_ID          : LIFF ID
 *   PAGES_BASE_URL   : GitHub Pages のURL (例 https://xxx.github.io/repo) ※末尾スラッシュなし
 */

const TABLES = {
  companies: ['code', 'name', 'enabled', 'richmenu_id'],
  line_users: ['line_user_id', 'display_name', 'followed', 'active_company', 'created_at'],
  // LINE ⇔ サービスユーザーの紐付けは「企業所属」単位で持つ(複数企業所属のため)
  memberships: ['line_user_id', 'company_code', 'service_user_id', 'joined_at', 'linked_at'],
  // 既存の利用登録導線(サービス側)の代役。本番では既存DBを使う。
  service_users: ['service_user_id', 'company_code', 'employee_no', 'created_at'],
  link_tokens: ['token', 'service_user_id', 'expires_at', 'used'],
  send_log: ['at', 'company_code', 'text', 'target_count', 'result'],
};

/** 初回に1回実行: シート作成 + サンプル企業投入 */
function setup() {
  Object.keys(TABLES).forEach(function (name) {
    var sh = sheet_(name, true);
    if (sh.getLastRow() === 0) sh.appendRow(TABLES[name]);
  });
  if (rows_('companies').length === 0) {
    append_('companies', { code: 'acme', name: 'ACME株式会社', enabled: true, richmenu_id: '' });
    append_('companies', { code: 'globex', name: 'グローバックス株式会社', enabled: true, richmenu_id: '' });
  }
}

// ---------------------------------------------------------------- entry
function doGet() {
  return json_({ ok: true, message: 'LIFF mock API' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // LINE Webhook (署名検証はGASでヘッダーが読めないため省略。本番(AWS)では必須)
    if (body.events) return json_(handleWebhook_(body));
    var res = route_(body);
    return json_({ ok: true, data: res });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function route_(b) {
  switch (b.action) {
    // ---- LIFF (公開)
    case 'companyInfo': return companyInfo_(b.code);
    case 'join': return withLock_(function () { return join_(b); });
    case 'me': return me_(verifyIdToken_(b.idToken));
    case 'switchCompany': return withLock_(function () { return switchCompany_(b); });
    case 'link': return withLock_(function () { return link_(b); });
  }
  // ---- 管理 (ADMIN_KEY 必須)
  requireAdmin_(b.adminKey);
  switch (b.action) {
    case 'adminOverview': return adminOverview_();
    case 'upsertCompany': return upsertCompany_(b);
    case 'setupRichMenu': return setupRichMenu_(b.code);
    case 'createServiceUser': return createServiceUser_(b);
    case 'broadcast': return broadcast_(b);
    case 'relinkMenu': return applyRichMenu_(b.lineUserId);
  }
  throw new Error('unknown action: ' + b.action);
}

// ---------------------------------------------------------------- LIFF API
function companyInfo_(code) {
  var c = findCompany_(code);
  if (!c || !isTrue_(c.enabled)) throw new Error('無効な企業コードです');
  return { code: c.code, name: c.name };
}

/** 企業URL(?company=xxx)経由のログイン: 所属追加 + アクティブ企業に設定 */
function join_(b) {
  var p = verifyIdToken_(b.idToken);
  var c = companyInfo_(b.companyCode);
  upsertLineUser_(p, c.code);
  addMembership_(p.sub, c.code);
  setActive_(p.sub, c.code);
  applyRichMenu_(p.sub);
  return me_(p);
}

function me_(p) {
  var user = findBy_('line_users', 'line_user_id', p.sub);
  var ms = rows_('memberships').filter(function (m) { return m.line_user_id === p.sub; });
  return {
    displayName: p.name || '',
    activeCompany: user ? user.active_company : '',
    companies: ms.map(function (m) {
      var c = findCompany_(m.company_code) || {};
      return { code: m.company_code, name: c.name || m.company_code, linked: !!m.service_user_id };
    }),
  };
}

function switchCompany_(b) {
  var p = verifyIdToken_(b.idToken);
  var ok = rows_('memberships').some(function (m) {
    return m.line_user_id === p.sub && m.company_code === b.companyCode;
  });
  if (!ok) throw new Error('その企業には所属していません');
  setActive_(p.sub, b.companyCode);
  applyRichMenu_(p.sub);
  return me_(p);
}

/**
 * サービス側で利用登録(=サービスユーザーID発行)した後、
 * ワンタイム連携URL (LIFF ?link=TOKEN) を開いてもらい、LINE ⇔ サービスユーザーIDを紐付ける。
 */
function link_(b) {
  var p = verifyIdToken_(b.idToken);
  var t = findBy_('link_tokens', 'token', b.linkToken);
  if (!t || isTrue_(t.used)) throw new Error('連携コードが無効、または使用済みです');
  if (new Date(t.expires_at).getTime() < Date.now()) throw new Error('連携コードの有効期限切れです');
  var su = findBy_('service_users', 'service_user_id', t.service_user_id);
  if (!su) throw new Error('サービスユーザーが見つかりません');

  upsertLineUser_(p, su.company_code);
  addMembership_(p.sub, su.company_code);
  var m = rows_('memberships').filter(function (r) {
    return r.line_user_id === p.sub && r.company_code === su.company_code;
  })[0];
  if (m.service_user_id && m.service_user_id !== su.service_user_id) {
    throw new Error('このLINEアカウントは、この企業で別のユーザーに紐付け済みです');
  }
  update_('memberships', m._row, { service_user_id: su.service_user_id, linked_at: now_() });
  update_('link_tokens', t._row, { used: true });
  setActive_(p.sub, su.company_code);
  applyRichMenu_(p.sub);
  var res = me_(p);
  res.linkedCompany = su.company_code;
  return res;
}

// ---------------------------------------------------------------- Webhook
function handleWebhook_(body) {
  body.events.forEach(function (ev) {
    var uid = ev.source && ev.source.userId;
    if (!uid) return;
    var u = findBy_('line_users', 'line_user_id', uid);
    if (ev.type === 'follow') {
      if (u) update_('line_users', u._row, { followed: true });
      applyRichMenu_(uid); // ブロック解除・再追加でメニューを復元
    } else if (ev.type === 'unfollow') {
      if (u) update_('line_users', u._row, { followed: false });
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------- 管理API
function adminOverview_() {
  var companies = rows_('companies');
  var ms = rows_('memberships');
  var users = rows_('line_users');
  return {
    liffId: prop_('LIFF_ID'),
    companies: companies.map(function (c) {
      var mem = ms.filter(function (m) { return m.company_code === c.code; });
      return {
        code: c.code, name: c.name, enabled: isTrue_(c.enabled), richmenuId: c.richmenu_id,
        members: mem.length,
        linked: mem.filter(function (m) { return m.service_user_id; }).length,
      };
    }),
    members: ms.map(function (m) {
      var u = users.filter(function (x) { return x.line_user_id === m.line_user_id; })[0] || {};
      return {
        lineUserId: m.line_user_id, displayName: u.display_name, followed: isTrue_(u.followed),
        company: m.company_code, active: u.active_company === m.company_code,
        serviceUserId: m.service_user_id,
      };
    }),
    serviceUsers: rows_('service_users'),
    sendLog: rows_('send_log').slice(-10).reverse(),
  };
}

function upsertCompany_(b) {
  if (!/^[a-z0-9_-]{2,32}$/.test(b.code || '')) throw new Error('企業コードは英小文字/数字/-/_ 2〜32文字');
  var c = findCompany_(b.code);
  if (c) {
    update_('companies', c._row, { name: b.name, enabled: !!b.enabled });
  } else {
    append_('companies', { code: b.code, name: b.name, enabled: b.enabled !== false, richmenu_id: '' });
  }
  return adminOverview_();
}

/** 既存サービスの「利用登録」の代役: サービスユーザーIDを発行し、連携URLを返す */
function createServiceUser_(b) {
  var c = companyInfo_(b.companyCode);
  var suid = 'SU' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  append_('service_users', {
    service_user_id: suid, company_code: c.code, employee_no: b.employeeNo || '', created_at: now_(),
  });
  var token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  append_('link_tokens', {
    token: token, service_user_id: suid,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), used: false,
  });
  return { serviceUserId: suid, linkUrl: 'https://liff.line.me/' + prop_('LIFF_ID') + '?link=' + token };
}

/** 企業向けナローキャスト (multicast: 1リクエスト最大500ID) */
function broadcast_(b) {
  var c = companyInfo_(b.companyCode);
  if (!b.text) throw new Error('本文が空です');
  var ids = rows_('memberships')
    .filter(function (m) { return m.company_code === c.code; })
    .map(function (m) { return m.line_user_id; });
  if (ids.length === 0) throw new Error('配信対象がいません');
  var results = [];
  for (var i = 0; i < ids.length; i += 500) {
    var r = line_('post', '/v2/bot/message/multicast', {
      to: ids.slice(i, i + 500), messages: [{ type: 'text', text: b.text }],
    });
    results.push(r.code);
  }
  var summary = results.join(',');
  append_('send_log', { at: now_(), company_code: c.code, text: b.text, target_count: ids.length, result: summary });
  return { targets: ids.length, result: summary };
}

// ---------------------------------------------------------------- リッチメニュー
/** 企業ごとのリッチメニューを作成(画像は GitHub Pages の img/richmenu_<code>.png、無ければ default) */
function setupRichMenu_(code) {
  var c = findCompany_(code);
  if (!c) throw new Error('企業が見つかりません');
  var liffUrl = 'https://liff.line.me/' + prop_('LIFF_ID') + '?company=' + c.code;
  var created = line_('post', '/v2/bot/richmenu', {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'menu_' + c.code,
    chatBarText: c.name,
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: 'uri', label: 'マイページ', uri: liffUrl } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: 'message', label: 'ヘルプ', text: 'ヘルプ' } },
    ],
  });
  if (created.code !== 200) throw new Error('richmenu作成失敗: ' + created.body);
  var id = JSON.parse(created.body).richMenuId;

  var base = prop_('PAGES_BASE_URL') + '/img/';
  var img = UrlFetchApp.fetch(base + 'richmenu_' + c.code + '.png', { muteHttpExceptions: true });
  if (img.getResponseCode() !== 200) img = UrlFetchApp.fetch(base + 'richmenu_default.png');
  var up = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', {
    method: 'post', contentType: 'image/png', payload: img.getBlob().getBytes(),
    headers: { Authorization: 'Bearer ' + prop_('MESSAGING_TOKEN') }, muteHttpExceptions: true,
  });
  if (up.getResponseCode() !== 200) throw new Error('画像アップロード失敗: ' + up.getContentText());

  // 古いメニューは削除
  if (c.richmenu_id) line_('delete', '/v2/bot/richmenu/' + c.richmenu_id);
  update_('companies', c._row, { richmenu_id: id });
  // 既にこの企業をアクティブにしているユーザーへ反映 (メニュー作成前に登録済みの人向け)
  rows_('line_users').forEach(function (u) {
    if (u.active_company === c.code) applyRichMenu_(u.line_user_id);
  });
  return { richMenuId: id };
}

/** そのユーザーのアクティブ企業のメニューを紐付け(未設定なら解除)。失敗は握りつぶす(未友だち等) */
function applyRichMenu_(userId) {
  try {
    var u = findBy_('line_users', 'line_user_id', userId);
    var c = u && findCompany_(u.active_company);
    var r;
    if (c && c.richmenu_id) r = line_('post', '/v2/bot/user/' + userId + '/richmenu/' + c.richmenu_id);
    else r = line_('delete', '/v2/bot/user/' + userId + '/richmenu');
    if (r.code !== 200) console.warn('applyRichMenu failed', userId, r.code, r.body);
    return r;
  } catch (e) { console.warn(e); return { code: 0, body: String(e) }; }
}

// ---------------------------------------------------------------- LINE API
/** IDトークン検証 → { sub: LINEユーザーID, name, ... } */
function verifyIdToken_(idToken) {
  if (!idToken) throw new Error('idToken がありません');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop_('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('LINEトークン検証失敗: ' + res.getContentText());
  return JSON.parse(res.getContentText());
}

function line_(method, path, payload) {
  var opt = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('MESSAGING_TOKEN') },
  };
  if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
  var r = UrlFetchApp.fetch('https://api.line.me' + path, opt);
  return { code: r.getResponseCode(), body: r.getContentText() };
}

// ---------------------------------------------------------------- 内部ヘルパ
function requireAdmin_(key) {
  if (!key || key !== prop_('ADMIN_KEY')) throw new Error('管理キーが正しくありません');
}
function prop_(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('スクリプトプロパティ未設定: ' + k);
  return v;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function now_() { return new Date().toISOString(); }
function isTrue_(v) { return v === true || v === 'TRUE' || v === 'true'; }

function upsertLineUser_(p, activeCompany) {
  var u = findBy_('line_users', 'line_user_id', p.sub);
  if (u) { update_('line_users', u._row, { display_name: p.name || u.display_name }); return; }
  append_('line_users', {
    line_user_id: p.sub, display_name: p.name || '', followed: '', active_company: activeCompany, created_at: now_(),
  });
}
function addMembership_(uid, code) {
  var exists = rows_('memberships').some(function (m) { return m.line_user_id === uid && m.company_code === code; });
  if (!exists) append_('memberships', { line_user_id: uid, company_code: code, service_user_id: '', joined_at: now_(), linked_at: '' });
}
function setActive_(uid, code) {
  var u = findBy_('line_users', 'line_user_id', uid);
  update_('line_users', u._row, { active_company: code });
}
function findCompany_(code) { return findBy_('companies', 'code', code); }
function findBy_(table, col, val) {
  return rows_(table).filter(function (r) { return String(r[col]) === String(val); })[0] || null;
}

// ---- スプレッドシート簡易ORM
function sheet_(name, create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh && create) sh = ss.insertSheet(name);
  if (!sh) throw new Error('シートがありません。setup() を実行してください: ' + name);
  return sh;
}
function rows_(name) {
  var sh = sheet_(name);
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  return vals.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}
function append_(name, obj) {
  sheet_(name).appendRow(TABLES[name].map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}
function update_(name, rowNum, obj) {
  var sh = sheet_(name);
  Object.keys(obj).forEach(function (k) {
    sh.getRange(rowNum, TABLES[name].indexOf(k) + 1).setValue(obj[k]);
  });
}

/**
 * Financie — Google Apps Script pre appku Financie.
 *
 * 1) Automatický import platieb z Gmailu
 *    Appka si pri otvorení vypýta nové notifikácie banky a zaradí ich do inboxu.
 *    Gmail sa iba ČÍTA (nič sa nemaže, neoznačuje ani neposiela) a len maily od SENDERS.
 *
 * 2) Synchronizácia medzi zariadeniami (PC ↔ iPhone)
 *    Transakcie a naučené pravidlá sa ukladajú do Google Tabuľky „Financie – dáta“
 *    vo tvojom Google Drive. Funguje aj ako záloha; tabuľku si môžeš kedykoľvek otvoriť.
 *
 * Prístup je chránený tajným kľúčom (TOKEN).
 *
 * Nastavenie (raz):
 *  1. script.google.com → Nový projekt → vlož tento súbor namiesto Code.gs → Uložiť.
 *  2. Deploy → New deployment → ⚙️ Web app · Execute as: Me · Who has access: Anyone → Deploy.
 *  3. Vyber funkciu `setup` → Run → povoľ prístup. V protokole sa zobrazí kľúč.
 *  4. V appke: ⚙️ → Automatický import z Gmailu → vlož odkaz /exec?token=… → Pripojiť.
 *
 * Aktualizácia skriptu: vlož novú verziu → Uložiť → spusti `setup` (povolí nové oprávnenia)
 * → Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */

const SENDERS = [
  'info@servis.csob.sk',        // ČSOB notifikácie (Transakcia kartou, Pohyb na účte)
  // 'notifikacie@inabanka.sk', // ďalšie banky pridaj sem
];

const SUBJECT_FILTER = /(transakci|pohyb na |platb|kredit|debet)/i; // ignoruje marketing od banky
const MAX_THREADS = 100;
const FIRST_SYNC_DAYS = 31;
const SCRIPT_VERSION = 2;

/* =========================================================================
 *  Nastavenie
 * ========================================================================= */

/** Spusti ručne: vytvorí kľúč a tabuľku, overí oprávnenia, vypíše odkaz pre appku. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  // Overí prístup ku Gmailu aj k Tabuľkám (vyvolá povolenie, ak ešte nebolo udelené)
  const test = GmailApp.search(buildQuery(0), 0, 5).length;
  const db = getDb();
  Logger.log('Gmail OK — vlákien od banky za posledných %s dní (ukážka): %s', FIRST_SYNC_DAYS, test);
  Logger.log('Tabuľka so synchronizovanými dátami: %s', db.getUrl());

  const url = ScriptApp.getService().getUrl();
  if (url && /\/exec$/.test(url)) {
    Logger.log('ODKAZ PRE APPKU (skopíruj celý riadok):\n%s?token=%s', url, token);
  } else {
    Logger.log('KĽÚČ: ?token=%s', token);
    Logger.log('Odkaz pre appku = Web app URL z Deploy → Manage deployments (končí /exec) + ?token=… vyššie.');
  }
}

/** Nový kľúč — starý odkaz prestane fungovať (napr. ak si ho niekomu omylom poslal). */
function resetToken() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN');
  setup();
}

/* =========================================================================
 *  API pre appku
 * ========================================================================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = /^[A-Za-z_$][\w$]{0,63}$/.test(p.callback || '') ? p.callback : '';
  if (!authorized(p.token)) return json({ ok: false, error: 'unauthorized' }, cb);

  try {
    if (p.action === 'pull') return json(syncPull(p), cb);
    if (p.action === 'ping') return json({ ok: true, version: SCRIPT_VERSION }, cb);
    return json(gmailItems(p), cb);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, cb);
  }
}

/** POST (synchronizácia — odoslanie zmien). Telo je JSON ako text/plain. */
function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad-json' }); }
  if (!authorized(p.token)) return json({ ok: false, error: 'unauthorized' });
  try {
    if (p.action === 'push') return json(syncPush(p));
    return json({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function authorized(token) {
  const t = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return Boolean(t) && token === t;
}

/* =========================================================================
 *  Gmail
 * ========================================================================= */

function gmailItems(p) {
  const after = Math.max(0, parseInt(p.after || '0', 10) || 0); // unix sekundy
  const threads = GmailApp.search(buildQuery(after), 0, MAX_THREADS);
  const items = [];
  const senderRe = new RegExp(SENDERS.map(escapeRe).join('|'), 'i');

  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (after && m.getDate().getTime() / 1000 < after) return;
      if (!senderRe.test(m.getFrom())) return;
      if (!SUBJECT_FILTER.test(m.getSubject())) return;
      items.push({
        id: m.getId(),
        date: m.getDate().toISOString(),
        subject: m.getSubject(),
        text: cleanBody(m.getPlainBody()),
      });
    });
  });

  items.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { ok: true, now: Math.floor(Date.now() / 1000), items: items };
}

function buildQuery(after) {
  const from = 'from:(' + SENDERS.join(' OR ') + ')';
  return from + (after ? ' after:' + after : ' newer_than:' + FIRST_SYNC_DAYS + 'd');
}

/** Odstráni neviditeľné znaky, odkazy a pätičku (kontakty, adresa príjemcu). */
function cleanBody(text) {
  let t = String(text || '')
    .replace(/[­͏​-‍⁠﻿]/g, '')
    .replace(/<https?:[^>]*>/g, '')
    .replace(/\[https?:[^\]]*\]/g, '')
    .replace(/[^\S\n]+/g, ' ')   // všetky druhy medzier → jedna medzera
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  const cut = t.search(/Ak máte otázky|Tento e-mail je generovaný/i);
  if (cut > 0) t = t.slice(0, cut);
  return t.trim().slice(0, 4000);
}

/* =========================================================================
 *  Synchronizácia
 *
 *  Každý záznam má updatedAt (čas poslednej zmeny v zariadení). Pri konflikte
 *  vyhrá novšia zmena. Zmazané položky ostávajú ako "zmazané" riadky, aby sa
 *  zmazanie prenieslo aj do ostatných zariadení.
 *
 *  rev = poradové číslo zmeny na serveri. Zariadenie si pamätá posledné rev
 *  a pri ďalšej synchronizácii si stiahne len novšie zmeny.
 * ========================================================================= */

const DB_NAME = 'Financie – dáta';
const TX_SHEET = 'Transakcie';
const RULE_SHEET = 'Pravidlá';
const TX_HEAD = ['id', 'dátum', 'suma', 'obchodník', 'kategória', 'stav', 'poznámka', 'zdroj', 'zmazané', 'updatedAt', 'rev', 'json'];
const TX_UPDATED = 9, TX_REV = 10, TX_JSON = 11;
const RULE_HEAD = ['kľúč', 'kategória', 'zmazané', 'updatedAt', 'rev'];
const RULE_UPDATED = 3, RULE_REV = 4;

function getDb() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DB_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* zmazaná tabuľka → vytvor novú */ }
  }
  const ss = SpreadsheetApp.create(DB_NAME);
  const tx = ss.getSheets()[0];
  tx.setName(TX_SHEET);
  tx.getRange(1, 1, 1, TX_HEAD.length).setValues([TX_HEAD]).setFontWeight('bold');
  tx.setFrozenRows(1);
  tx.getRange('A:B').setNumberFormat('@'); // id a dátum ako text (Tabuľky by dátum prepísali)
  tx.getRange('D:I').setNumberFormat('@');
  const rules = ss.insertSheet(RULE_SHEET);
  rules.getRange(1, 1, 1, RULE_HEAD.length).setValues([RULE_HEAD]).setFontWeight('bold');
  rules.setFrozenRows(1);
  rules.getRange('A:C').setNumberFormat('@');
  props.setProperty('DB_ID', ss.getId());
  props.setProperty('REV', '0');
  return ss;
}

function syncPush(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const props = PropertiesService.getScriptProperties();
    const ss = getDb();
    const rev = Number(props.getProperty('REV') || 0) + 1;

    let changed = upsert(ss.getSheetByName(TX_SHEET), p.transactions || [], function (t) { return t.id; }, function (t) {
      return [
        String(t.id), t.date || '', t.deleted ? '' : Number(t.amount) || 0, t.merchant || '', t.category || '',
        t.deleted ? '' : (t.status === 'approved' ? 'schválené' : 'čaká'), t.note || '', t.source || '',
        t.deleted ? 'áno' : '', Number(t.updatedAt) || 0, rev, JSON.stringify(t),
      ];
    }, TX_UPDATED);

    changed += upsert(ss.getSheetByName(RULE_SHEET), p.rules || [], function (r) { return r.key; }, function (r) {
      return [String(r.key), r.deleted ? '' : r.category || '', r.deleted ? 'áno' : '', Number(r.updatedAt) || 0, rev];
    }, RULE_UPDATED);

    if (changed) props.setProperty('REV', String(rev));
    if (p.device && p.pushId) props.setProperty('ACK_' + String(p.device).slice(0, 64), String(p.pushId));
    return { ok: true, changed: changed, rev: Number(props.getProperty('REV') || 0) };
  } finally {
    lock.releaseLock();
  }
}

/** Vloží/aktualizuje záznamy podľa kľúča; staršia zmena (updatedAt) nikdy neprepíše novšiu. */
function upsert(sheet, records, keyOf, rowOf, updatedCol) {
  // Duplicitné kľúče v jednej dávke → nechaj najnovší
  const latest = {};
  records.forEach(function (r) {
    const k = String(keyOf(r) || '');
    if (!k) return;
    if (!latest[k] || Number(latest[k].updatedAt) < Number(r.updatedAt)) latest[k] = r;
  });

  const values = sheet.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < values.length; i++) index[String(values[i][0])] = i;

  const appends = [];
  let n = 0;
  Object.keys(latest).forEach(function (k) {
    const rec = latest[k];
    const row = rowOf(rec);
    if (k in index) {
      const i = index[k];
      if (Number(values[i][updatedCol]) >= Number(rec.updatedAt)) return; // server má novšie
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    } else {
      appends.push(row);
    }
    n++;
  });
  if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, appends[0].length).setValues(appends);
  return n;
}

function syncPull(p) {
  const props = PropertiesService.getScriptProperties();
  const ss = getDb();
  const since = Number(p.since || 0);
  const rev = Number(props.getProperty('REV') || 0);

  const transactions = [];
  ss.getSheetByName(TX_SHEET).getDataRange().getValues().slice(1).forEach(function (r) {
    if (Number(r[TX_REV]) <= since) return;
    try { transactions.push(JSON.parse(r[TX_JSON])); } catch (err) { /* poškodený riadok preskoč */ }
  });

  const rules = [];
  ss.getSheetByName(RULE_SHEET).getDataRange().getValues().slice(1).forEach(function (r) {
    if (Number(r[RULE_REV]) <= since) return;
    rules.push({ key: String(r[0]), category: r[1] || null, deleted: r[2] === 'áno', updatedAt: Number(r[RULE_UPDATED]) || 0 });
  });

  return {
    ok: true,
    version: SCRIPT_VERSION,
    rev: rev,
    ack: p.device ? props.getProperty('ACK_' + String(p.device).slice(0, 64)) || '' : '',
    sheetUrl: ss.getUrl(),
    transactions: transactions,
    rules: rules,
  };
}

/* =========================================================================
 *  Pomocné
 * ========================================================================= */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** JSON, alebo JSONP (callback) — JSONP funguje aj v appke na ploche iPhonu. */
function json(obj, callback) {
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

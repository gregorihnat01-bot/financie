/**
 * Financie — automatický import platieb z Gmailu.
 *
 * Beží vo TVOJOM Google účte. Appka Financie si pri otvorení vypýta nové
 * notifikácie banky, rozpozná v nich platby a zaradí ich do inboxu na schválenie.
 *
 * Skript Gmail iba ČÍTA (nič nemaže, neoznačuje, neposiela) a vracia len maily
 * od odosielateľov v SENDERS. Prístup je chránený tajným kľúčom (TOKEN).
 *
 * Nastavenie (raz, cca 5 minút):
 *  1. script.google.com → Nový projekt → vlož tento súbor namiesto Code.gs → Uložiť.
 *  2. Nasadiť → Nové nasadenie → ozubené koliesko → Webová aplikácia
 *       Spustiť ako: Ja   ·   Kto má prístup: Ktokoľvek   → Nasadiť → povoľ prístup.
 *  3. V lište hore vyber funkciu `setup` → Spustiť. V protokole sa zobrazí odkaz pre appku.
 *  4. V appke: ⚙️ → Automatický import z Gmailu → vlož odkaz → Uložiť.
 */

const SENDERS = [
  'info@servis.csob.sk',        // ČSOB notifikácie (Transakcia kartou, Pohyb na účte)
  // 'notifikacie@inabanka.sk', // ďalšie banky pridaj sem
];

const SUBJECT_FILTER = /(transakci|pohyb na |platb|kredit|debet)/i; // ignoruje marketing od banky
const MAX_THREADS = 100;
const FIRST_SYNC_DAYS = 31;

/* ---------- Spusti raz ručne: vytvorí tajný kľúč a vypíše odkaz pre appku ---------- */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  // Overí prístup ku Gmailu (vyvolá povolenie, ak ešte nebolo udelené)
  const test = GmailApp.search(buildQuery(0), 0, 5).length;
  const url = ScriptApp.getService().getUrl();
  Logger.log('Nájdených vlákien od banky za posledných %s dní (ukážka): %s', FIRST_SYNC_DAYS, test);
  if (url && /\/exec$/.test(url)) {
    Logger.log('ODKAZ PRE APPKU (skopíruj celý riadok):\n%s?token=%s', url, token);
  } else if (url) {
    Logger.log('ODKAZ PRE APPKU – časť 1 (kľúč), vlož do appky:\n%s?token=%s', url, token);
    Logger.log('Časť 2: Deploy → Manage deployments → skopíruj „Web app URL“ (končí /exec) a vlož ju do appky tiež.');
  } else {
    Logger.log('Najprv nasaď skript ako Webovú aplikáciu (krok 2), potom spusti setup znova.');
    Logger.log('TOKEN: %s', token);
  }
}

/** Nový kľúč — starý odkaz prestane fungovať (napr. ak si ho niekomu omylom poslal). */
function resetToken() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN');
  setup();
}

/* ---------- API pre appku ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || p.token !== token) return json({ ok: false, error: 'unauthorized' });

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
  return json({ ok: true, now: Math.floor(Date.now() / 1000), items: items });
}

/* ---------- Pomocné ---------- */
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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

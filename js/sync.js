/**
 * sync.js — synchronizácia medzi zariadeniami cez Google Apps Script (ten istý ako import z Gmailu).
 *
 *  1. PUSH: zmeny od poslednej synchronizácie sa pošlú POSTom (mode: 'no-cors' — odpoveď
 *     sa nedá prečítať, ale požiadavka nepotrebuje CORS, takže funguje aj v appke na ploche iPhonu).
 *  2. PULL: cez JSONP sa stiahnu zmeny z ostatných zariadení. Odpoveď obsahuje aj `ack` —
 *     ID posledného prijatého PUSHu z tohto zariadenia. Až keď sedí, zmeny sa považujú za uložené.
 *  3. Konflikty: novšia zmena (updatedAt) vyhráva — rieši store.applyRemote aj server.
 */

import { store, uid } from './store.js';

const settings = () => store.state.settings;

export const syncEnabled = () => Boolean(settings().syncEnabled && settings().gmailUrl && settings().gmailToken);

/**
 * JSONP: odpoveď sa načíta ako <script>, takže na ňu neplatia CORS pravidlá.
 * Ak skript nepozná ?callback= (stará verzia), zlyhá hneď ('jsonp-no-callback').
 */
export function jsonp(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const name = `__financieCb${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const el = document.createElement('script');
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[name];
      el.remove();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    window[name] = data => finish(resolve, data);
    el.onerror = () => finish(reject, new Error('jsonp-error'));
    el.onload = () => setTimeout(() => finish(reject, new Error('jsonp-no-callback')), 50);
    el.src = `${url}&callback=${name}`;
    document.head.appendChild(el);
  });
}

function scriptUrl(params) {
  const s = settings();
  const sep = s.gmailUrl.includes('?') ? '&' : '?';
  return `${s.gmailUrl}${sep}token=${encodeURIComponent(s.gmailToken)}${params}&_=${Date.now()}`;
}

function deviceId() {
  let id = settings().deviceId;
  if (!id) {
    id = uid();
    store.setSetting('deviceId', id);
  }
  return id;
}

const JSONP_ERRORS = {
  'jsonp-no-callback': 'Skript je stará verzia. Nasaď novú verziu (Deploy → New version).',
  'jsonp-error': 'Google vrátil chybovú stránku. Skontroluj odkaz v nastaveniach Gmailu.',
  timeout: 'Google neodpovedá. Skús to o chvíľu.',
};

async function pull() {
  let data;
  try {
    data = await jsonp(scriptUrl(`&action=pull&since=${settings().syncRev || 0}&device=${encodeURIComponent(deviceId())}`), 45000);
  } catch (e) {
    throw new Error(JSONP_ERRORS[e.message] || e.message);
  }
  if (!data?.ok) {
    throw new Error(data?.error === 'unauthorized' ? 'Nesprávny kľúč. Vlož odkaz z Apps Scriptu znova.' : data?.error || 'Chyba synchronizácie');
  }
  if (data.rev === undefined) {
    throw new Error('Skript ešte nevie synchronizovať. Vlož novú verziu Code.gs a nasaď ju (New version).');
  }
  return data;
}

let busy = null;
let again = false;

/**
 * Jedna synchronizácia: odošli zmeny → stiahni zmeny. Volania počas behu sa zlúčia do jedného ďalšieho.
 * @returns {Promise<{pushed:number, applied:number}|null>}
 */
export function syncNow({ manual = false } = {}) {
  if (!syncEnabled()) return Promise.resolve(null);
  if (busy) { again = true; return busy; }
  busy = run(manual).finally(() => {
    busy = null;
    if (again) { again = false; setTimeout(() => syncNow(), 300); }
  });
  return busy;
}

async function run(manual) {
  try {
    const since = settings().syncLastPushAt || 0;
    const changes = store.changesSince(since);
    let pushId = null;
    if (changes.count) {
      pushId = uid();
      await fetch(settings().gmailUrl, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({
          token: settings().gmailToken, action: 'push', device: deviceId(), pushId,
          transactions: changes.transactions, rules: changes.rules,
        }),
      });
    }
    const data = await pull();
    if (pushId && data.ack !== pushId) throw new Error('Google nepotvrdil uloženie zmien. Skúsim to znova pri ďalšej synchronizácii.');
    const applied = store.applyRemote(data);
    store.setSettings({
      syncRev: data.rev,
      ...(pushId ? { syncLastPushAt: changes.maxTs } : {}),
      syncLastOk: Date.now(),
      syncError: '',
      syncSheetUrl: data.sheetUrl || settings().syncSheetUrl || '',
    });
    return { pushed: changes.count, applied };
  } catch (e) {
    const msg = e instanceof TypeError ? (navigator.onLine ? 'Nepodarilo sa spojiť s Google.' : 'Si offline.') : e.message;
    store.setSetting('syncError', msg);
    if (manual) throw new Error(msg);
    return null;
  }
}

/* Automatické odoslanie po lokálnej zmene (s krátkym oneskorením, aby sa zmeny zlúčili). */
let timer = null;
export function scheduleSync(delay = 2500) {
  if (!syncEnabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delay);
}

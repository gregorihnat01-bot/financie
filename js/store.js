/**
 * store.js — bezpečný state management nad LocalStorage.
 *
 * Princípy:
 *  - Jediný zdroj pravdy je objekt `state`. Mení sa VÝHRADNE cez exportované akcie.
 *  - Každá akcia: zmení state → okamžite uloží do LocalStorage → notifikuje UI (emit).
 *    Vďaka tomu po schválení/zmene kategórie položka zmizne z inboxu v tom istom frame.
 *  - Čítanie z LocalStorage je obalené v try/catch a validuje štruktúru (poškodené dáta
 *    nezhodia appku, odložia sa ako záloha pod `financie.corrupt`).
 */

const STORAGE_KEY = 'financie.v2';
const SCHEMA_VERSION = 2;

/* ---------- Kategórie (pevné poradie = pevné farby; ID sa nemenia, aby staré dáta ostali platné) ---------- */
export const CATEGORIES = [
  { id: 'groceries', icon: '🛒', name: 'Potraviny & Domácnosť', short: 'Potraviny',   kind: 'variable', color: '#199e70' },
  { id: 'transport', icon: '🚗', name: 'Doprava & Palivo',      short: 'Doprava',     kind: 'variable', color: '#3987e5' },
  { id: 'fun',       icon: '🍔', name: 'Jedlo vonku & Zábava',  short: 'Zábava',      kind: 'variable', color: '#d95926' },
  { id: 'sport',     icon: '💪', name: 'Šport & Životný štýl',  short: 'Šport',       kind: 'variable', color: '#2aa1b3' },
  { id: 'shopping',  icon: '🛍️', name: 'Nákupy & Oblečenie',    short: 'Nákupy',      kind: 'variable', color: '#c75fd6' },
  { id: 'housing',   icon: '🏠', name: 'Bývanie, Účty & Úver',  short: 'Bývanie',     kind: 'fixed',    color: '#9085e9' },
  { id: 'subs',      icon: '📱', name: 'Predplatné & Služby',   short: 'Predplatné',  kind: 'fixed',    color: '#d55181' },
  { id: 'invest',    icon: '📈', name: 'Investície & Sporenie', short: 'Investície',  kind: 'invest',   color: '#c98500' },
  { id: 'income',    icon: '💼', name: 'Príjem / Mzda',         short: 'Príjem',      kind: 'income',   color: '#30d158' },
  { id: 'transfer',  icon: '🔄', name: 'Presun / Iné',          short: 'Presun',      kind: 'transfer', color: '#8e8e93' },
];
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

export const KIND_LABEL = {
  variable: 'Voľné výdavky',
  fixed: 'Fixné výdavky',
  invest: 'Investície',
  income: 'Príjem',
  transfer: 'Presun',
};

/* ---------- Heuristiky pre prvý návrh (kým neexistuje naučené pravidlo) ---------- */
const KEYWORDS = [
  ['groceries', ['lidl', 'tesco', 'kaufland', 'billa', 'coop', 'jednota', 'terno', 'fresh', 'albert', 'dm drogerie', 'dm ', 'teta', 'rossmann', 'ikea', 'hornbach', 'obi', 'potraviny', 'action']],
  ['transport', ['shell', 'omv', 'slovnaft', 'orlen', 'mol ', 'benzin', 'cerpacia', 'parking', 'parkov', 'bolt', 'uber', 'zssk', 'regiojet', 'leo express', 'dpb', 'imhd', 'mhd', 'dialnic', 'eznamka', 'dpmp', 'dpmk', 'dpmz', 'dopravny podnik', 'arriva', 'slovak lines', 'flixbus', 'vinet', 'autoservis', 'pneu']],
  ['fun', ['restaur', 'bistro', 'pizza', 'burger', 'mcdonald', 'kfc', 'starbucks', 'kaviar', 'cafe', 'coffee', 'kava', 'bar ', 'pub', 'wolt', 'foodora', 'bolt food', 'kino', 'cinema', 'cinemax', 'ticket', 'steam', 'playstation', 'xbox']],
  ['sport', ['fitness', 'fitko', 'gym', 'posilnov', 'decathlon', 'sportisimo', 'hervis', 'intersport', 'top4running', 'gymbeam', 'myprotein', 'nutrend', 'protein', 'strava', 'garmin', 'sauna', 'wellness', 'bazen', 'barber', 'kadern', 'holicstvo', 'holic ', 'dental', 'zubn', 'stomatolog']],
  ['shopping', ['zara', 'h&m', 'hm ', 'reserved', 'primark', 'bershka', 'pull&bear', 'mango', 'c&a', 'about you', 'aboutyou', 'zalando', 'answear', 'footshop', 'deichmann', 'ccc ', 'klarna', 'alza', 'datart', 'nay ', 'planeo', 'mall.sk', 'amazon', 'aliexpress', 'temu', 'shein', 'notino', 'pepco', 'kik']],
  ['housing', ['splatka', 'uver', 'spotrebny', 'pozicka', 'najom', 'najomne', 'hypo', 'zse', 'spp', 'vodaren', 'bvs', 'elektr', 'plyn', 'energ', 'sprava domu', 'bytove', 'fond oprav', 'poistenie', 'allianz', 'generali', 'kooperativa', 'union']],
  ['subs', ['netflix', 'spotify', 'apple.com', 'apple com', 'icloud', 'google', 'youtube', 'disney', 'hbo', 'max.com', 'amazon prime', 'orange', 'telekom', 'o2 ', 'swan', '4ka', 'chatgpt', 'openai', 'anthropic', 'claude', 'microsoft', 'adobe', 'patreon']],
  ['invest', ['xtb', 'trading 212', 'trading212', 'revolut invest', 'finax', 'portu', 'etf', 'sporenie', 'sporiaci', 'dds', 'doplnkov', 'nn ', 'investic', 'binance', 'coinbase', 'anycoin']],
  ['income', ['mzda', 'vyplata', 'plat ', 'salary', 'odmena', 'dividend', 'urok', 'vratka', 'refund', 'prijata platba']],
  ['transfer', ['ucet *', 'prevod', 'vlastny ucet', 'medzi uctami', 'vyber atm', 'bankomat', 'atm ', 'revolut top', 'top-up', 'dobitie']],
];

/* ---------- Pomocné funkcie ---------- */
export function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Normalizácia mena obchodníka → kľúč pravidla.
 * "LIDL DAKUJEME 0123 BRATISLAVA" aj "Lidl Ďakujeme 0456 Košice" → "lidl dakujeme"
 */
export function merchantKey(name) {
  const tokens = stripDiacritics(name)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*#_/\\|,.;:()\[\]{}"'`+-]/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !['sro', 's.r.o', 'as', 'a.s', 'sk', 'cz', 'spol'].includes(t));
  return tokens.slice(0, 2).join(' ') || stripDiacritics(name).toLowerCase().trim();
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/* ---------- State ---------- */
function emptyState() {
  return { version: SCHEMA_VERSION, transactions: [], rules: {}, settings: {} };
}

function sanitizeTx(t) {
  if (!t || typeof t !== 'object') return null;
  const amount = round2(t.amount);
  if (!Number.isFinite(amount)) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : todayISO();
  const category = CAT[t.category] ? t.category : null;
  return {
    id: String(t.id || uid()),
    date,
    amount,
    merchant: String(t.merchant || 'Neznáma platba').slice(0, 120),
    note: String(t.note || '').slice(0, 300),
    category,
    status: t.status === 'approved' && category ? 'approved' : 'pending',
    source: String(t.source || 'manual'),
    createdAt: Number(t.createdAt) || Date.now(),
    snoozedAt: Number(t.snoozedAt) || 0,
    oneOff: Boolean(t.oneOff), // ⭐ jednorazový výdavok (štítok nezávislý od kategórie)
  };
}

function sanitizeState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  if (Array.isArray(raw.transactions)) s.transactions = raw.transactions.map(sanitizeTx).filter(Boolean);
  if (raw.rules && typeof raw.rules === 'object') {
    for (const [k, v] of Object.entries(raw.rules)) if (CAT[v]) s.rules[k] = v;
  }
  if (raw.settings && typeof raw.settings === 'object') s.settings = { ...raw.settings };
  return s;
}

function load() {
  let text = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    return emptyState(); // súkromný režim / zablokované úložisko
  }
  if (!text) return emptyState();
  try {
    return sanitizeState(JSON.parse(text));
  } catch {
    try { localStorage.setItem('financie.corrupt', text); } catch {}
    return emptyState();
  }
}

let state = load();
const listeners = new Set();
let lastError = null;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastError = null;
    return true;
  } catch (e) {
    lastError = e?.name === 'QuotaExceededError' ? 'Úložisko je plné.' : 'Dáta sa nepodarilo uložiť.';
    return false;
  }
}

function emit(reason) {
  for (const fn of listeners) {
    try { fn(state, reason); } catch (e) { console.error(e); }
  }
}

/** Zmeň → ulož → vykresli. Vždy v tomto poradí, synchronne. */
function commit(reason) {
  persist();
  emit(reason);
}

// Synchronizácia medzi oknami/tabmi (napr. Safari + plocha)
window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) {
    state = load();
    emit('sync');
  }
});

/* ---------- Verejné API: čítanie ---------- */
export const store = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  get state() { return state; },
  get error() { return lastError; },

  get(id) { return state.transactions.find(t => t.id === id) || null; },

  pending() {
    return state.transactions
      .filter(t => t.status === 'pending')
      .sort((a, b) => (a.snoozedAt - b.snoozedAt) || (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
  },

  approved() { return state.transactions.filter(t => t.status === 'approved'); },

  /** Návrh kategórie: 1) naučené pravidlo, 2) kľúčové slová, 3) znamienko sumy. */
  suggest(tx) {
    const key = merchantKey(tx.merchant);
    if (state.rules[key]) return { category: state.rules[key], source: 'rule' };
    const hay = ' ' + stripDiacritics(`${tx.merchant} ${tx.note}`).toLowerCase() + ' ';
    for (const [cat, words] of KEYWORDS) {
      if (cat === 'income' && tx.amount < 0) continue;
      if (words.some(w => hay.includes(w))) return { category: cat, source: 'keyword' };
    }
    if (tx.amount > 0) return { category: 'income', source: 'guess' };
    return { category: 'groceries', source: 'guess' };
  },

  rules() {
    return Object.entries(state.rules).sort((a, b) => a[0].localeCompare(b[0]));
  },

  /* ---------- Akcie ---------- */

  /**
   * Pridá transakcie (z importu alebo ručne). Duplicity z importu (rovnaký dátum + suma + obchodník)
   * sa preskočia. Ak `category` príde a `approve` je true, položka ide rovno do štatistík.
   * @returns {{added:number, skipped:number, items:object[]}}
   */
  addTransactions(list, { dedupe = true } = {}) {
    const fp = t => `${t.date}|${round2(t.amount)}|${merchantKey(t.merchant)}`;
    const existing = new Set(dedupe ? state.transactions.map(fp) : []);
    const items = [];
    let skipped = 0;
    for (const raw of list) {
      // Import môže poslať vlastné stabilné ID (napr. platby z výpisu) → opakovaný import ich preskočí
      const t = sanitizeTx({ ...raw, id: raw.id || uid(), createdAt: Date.now() });
      if (!t) { skipped++; continue; }
      if (raw.id && state.transactions.some(x => x.id === raw.id)) { skipped++; continue; }
      if (dedupe && existing.has(fp(t))) { skipped++; continue; }
      existing.add(fp(t));
      items.push(t);
    }
    if (items.length) {
      state.transactions.push(...items);
      commit('add');
    }
    return { added: items.length, skipped, items };
  },

  /**
   * Schválenie / zmena kategórie. Jedna atomická operácia:
   *  1. nastaví kategóriu + status approved
   *  2. naučí pravidlo pre rovnaké meno obchodníka
   *  3. uloží do LocalStorage
   *  4. okamžite prekreslí UI (položka zmizne z inboxu)
   */
  approve(id, category, { learn = true } = {}) {
    if (!CAT[category]) return false;
    const t = state.transactions.find(x => x.id === id);
    if (!t) return false;
    t.category = category;
    t.status = 'approved';
    t.snoozedAt = 0;
    if (learn) state.rules[merchantKey(t.merchant)] = category;
    commit('approve');
    return true;
  },

  /** Hromadné schválenie (napr. všetky s naučeným pravidlom). */
  approveMany(pairs) {
    let n = 0;
    for (const [id, category] of pairs) {
      const t = state.transactions.find(x => x.id === id);
      if (!t || !CAT[category]) continue;
      t.category = category;
      t.status = 'approved';
      t.snoozedAt = 0;
      state.rules[merchantKey(t.merchant)] = category;
      n++;
    }
    if (n) commit('approve');
    return n;
  },

  /** Ostatné čakajúce od rovnakého obchodníka (pre ponuku "zaradiť aj ďalšie"). */
  pendingSameMerchant(tx) {
    const key = merchantKey(tx.merchant);
    return state.transactions.filter(t => t.status === 'pending' && t.id !== tx.id && merchantKey(t.merchant) === key);
  },

  update(id, patch) {
    const t = state.transactions.find(x => x.id === id);
    if (!t) return false;
    const next = sanitizeTx({ ...t, ...patch });
    if (!next) return false;
    Object.assign(t, next);
    if (patch.category && t.status === 'approved') state.rules[merchantKey(t.merchant)] = t.category;
    commit('update');
    return true;
  },

  snooze(id) {
    const t = state.transactions.find(x => x.id === id);
    if (!t) return;
    t.snoozedAt = Date.now();
    commit('snooze');
  },

  remove(id) {
    const i = state.transactions.findIndex(x => x.id === id);
    if (i < 0) return null;
    const [removed] = state.transactions.splice(i, 1);
    commit('remove');
    return removed;
  },

  restore(tx) {
    state.transactions.push(tx);
    commit('add');
  },

  deleteRule(key) {
    delete state.rules[key];
    commit('rules');
  },

  /** Nastaví (alebo s `null` zmaže) pravidlo — používa sa pri "Späť". */
  setRule(key, category) {
    if (category && CAT[category]) state.rules[key] = category;
    else delete state.rules[key];
    commit('rules');
  },

  setSetting(key, value) {
    state.settings[key] = value;
    commit('settings');
  },

  /** Viac nastavení naraz = jeden zápis a jedno prekreslenie. */
  setSettings(patch) {
    Object.assign(state.settings, patch);
    commit('settings');
  },

  exportJSON() {
    return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  },

  importJSON(text) {
    const parsed = JSON.parse(text); // nech vyhodí chybu, UI ju zobrazí
    if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('Súbor neobsahuje zálohu Financií.');
    state = sanitizeState(parsed);
    commit('reset');
    return state.transactions.length;
  },

  reset() {
    state = emptyState();
    commit('reset');
  },
};

/* ---------- Štatistiky ---------- */

/** Súhrn mesiaca 'YYYY-MM'. Výdavky sú kladné čísla (vratky ich znižujú), presuny sa nerátajú. */
export function monthStats(month) {
  const byCat = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  let count = 0;
  let oneOff = 0;
  for (const t of state.transactions) {
    if (t.status !== 'approved' || !t.date.startsWith(month)) continue;
    count++;
    const c = CAT[t.category];
    if (c.kind === 'income') byCat[c.id] += t.amount;
    else byCat[c.id] += -t.amount;
    if (t.oneOff && (c.kind === 'variable' || c.kind === 'fixed')) oneOff += -t.amount;
  }
  for (const k in byCat) byCat[k] = round2(byCat[k]);
  const sumKind = kind => round2(CATEGORIES.filter(c => c.kind === kind).reduce((s, c) => s + byCat[c.id], 0));
  const income = sumKind('income');
  const variable = sumKind('variable');
  const fixed = sumKind('fixed');
  const invest = sumKind('invest');
  const expenses = round2(variable + fixed);
  const balance = round2(income - expenses - invest);
  const pending = state.transactions.filter(t => t.status === 'pending' && t.date.startsWith(month)).length;
  return { month, byCat, income, variable, fixed, invest, expenses, balance, count, pending, oneOff: round2(oneOff),
    savingsRate: income > 0 ? (income - expenses) / income : null };
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------- Mini-dashboard (obrazovka Schváliť) ---------- */

const DISCRETIONARY = new Set(['fun', 'shopping']); // „zbytočné“ výdavky pre počítadlo dní bez míňania

/**
 * Štatistiky mesiaca pre widget: denná útrata, dni bez nákupov a zábavy, najväčší výdavok,
 * porovnanie s minulým mesiacom k rovnakému dňu a odporúčaný rozpočet.
 */
export function monthInsights(month = todayISO().slice(0, 7)) {
  const st = monthStats(month);
  const today = todayISO();
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const isCurrent = today.startsWith(month);
  const dayNow = isCurrent ? Number(today.slice(8, 10)) : daysInMonth;

  const daily = Array(daysInMonth).fill(0);
  const discretionaryDays = new Set();
  let variable = 0;
  let biggest = null;
  for (const t of state.transactions) {
    if (t.status !== 'approved' || !t.date.startsWith(month) || t.amount >= 0) continue;
    const c = CAT[t.category];
    if (c.kind !== 'variable' && c.kind !== 'fixed') continue;
    const day = Number(t.date.slice(8, 10));
    daily[day - 1] += -t.amount;
    if (c.kind === 'variable' && !t.oneOff) variable += -t.amount;
    if (DISCRETIONARY.has(t.category)) discretionaryDays.add(day);
    if (!biggest || t.amount < biggest.amount) biggest = t;
  }
  let noSpendDays = 0;
  for (let d = 1; d <= dayNow; d++) if (!discretionaryDays.has(d)) noSpendDays++;

  // Minulý mesiac k rovnakému dňu (bežné voľné výdavky, bez jednorazových)
  const prevMonth = shiftMonth(month, -1);
  let prevVariable = 0;
  let prevHasData = false;
  for (const t of state.transactions) {
    if (t.status !== 'approved' || !t.date.startsWith(prevMonth)) continue;
    prevHasData = true;
    const c = CAT[t.category];
    if (c.kind !== 'variable' || t.oneOff || t.amount >= 0) continue;
    if (Number(t.date.slice(8, 10)) <= dayNow) prevVariable += -t.amount;
  }

  // Odporúčaný rozpočet = priemer výdavkov za posledné 3 mesiace s dátami (bez jednorazových), zaokrúhlený na 50 €
  const past = [1, 2, 3].map(i => monthStats(shiftMonth(month, -i))).filter(s => s.count > 0);
  const suggestedBudget = past.length
    ? Math.max(50, Math.round(past.reduce((s, x) => s + x.expenses - x.oneOff, 0) / past.length / 50) * 50)
    : null;

  return {
    ...st,
    daysInMonth, dayNow, isCurrent,
    daysLeft: daysInMonth - dayNow + (isCurrent ? 1 : 0),
    todaySpent: isCurrent ? round2(daily[dayNow - 1]) : 0,
    daily: daily.map(round2),
    avgDaily: dayNow ? round2(variable / dayNow) : 0,
    noSpendDays,
    biggest,
    prevMonth,
    prevVariable: prevHasData ? round2(prevVariable) : null,
    variableNow: round2(variable),
    suggestedBudget,
  };
}

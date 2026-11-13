/**
 * export.js — export transakcií do Excelu (.xlsx) a CSV za zvolené obdobie.
 *
 * Excel: 3 hárky — Transakcie (s filtrom), Súhrn (cash-flow + kategórie), Po mesiacoch.
 *        Knižnica SheetJS sa načíta až pri prvom exporte (service worker ju potom drží offline).
 * CSV:   UTF-8 s BOM, oddeľovač ";" a desatinná čiarka → slovenský Excel ho otvorí správne.
 */

import { store, CATEGORIES, CAT, KIND_LABEL, todayISO } from './store.js';

const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
const MONTHS = ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december'];
const SOURCE = { eml: 'E-mail', gmail: 'Gmail', pdf: 'PDF výpis', text: 'Text', clipboard: 'Schránka', shortcut: 'Skratka', manual: 'Ručne', link: 'Odkaz', demo: 'Ukážka', excel: 'Excel', vypis: 'Výpis z banky' };

/* =========================================================================
 *  Obdobie
 * ========================================================================= */

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const skDate = s => { const [y, m, d] = s.split('-'); return `${+d}. ${+m}. ${y}`; };

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/**
 * @param {'week'|'month'|'year'|'all'} kind
 * @param {string} anchor  ľubovoľný dátum YYYY-MM-DD v rámci obdobia
 * @returns {{kind, from:string|null, to:string|null, label:string, file:string}}
 */
export function periodRange(kind, anchor = todayISO()) {
  const a = parseISO(anchor);
  if (kind === 'week') {
    const mon = new Date(a); mon.setDate(a.getDate() - ((a.getDay() + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const w = isoWeek(mon);
    return { kind, from: iso(mon), to: iso(sun), label: `${w}. týždeň · ${skDate(iso(mon))} – ${skDate(iso(sun))}`, file: `tyzden-${mon.getFullYear()}-${String(w).padStart(2, '0')}` };
  }
  if (kind === 'month') {
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    return { kind, from: iso(first), to: iso(last), label: `${MONTHS[a.getMonth()]} ${a.getFullYear()}`, file: `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}` };
  }
  if (kind === 'year') {
    return { kind, from: `${a.getFullYear()}-01-01`, to: `${a.getFullYear()}-12-31`, label: `rok ${a.getFullYear()}`, file: `${a.getFullYear()}` };
  }
  return { kind: 'all', from: null, to: null, label: 'celé obdobie', file: 'vsetko' };
}

/** Posun obdobia o ±1 (vracia nový anchor). */
export function shiftPeriod(kind, anchor, delta) {
  const a = parseISO(anchor);
  if (kind === 'week') a.setDate(a.getDate() + 7 * delta);
  else if (kind === 'month') a.setMonth(a.getMonth() + delta, 1);
  else if (kind === 'year') a.setFullYear(a.getFullYear() + delta, 0, 1);
  return iso(a);
}

/* =========================================================================
 *  Dáta
 * ========================================================================= */

/** Typ pohybu pre stĺpec „Typ“. */
function typeOf(t) {
  const c = t.category ? CAT[t.category] : null;
  if (c?.kind === 'transfer') return 'Presun';
  if (c?.kind === 'invest') return 'Investícia';
  return t.amount > 0 ? 'Príjem' : 'Výdavok';
}

export function collect(range, { includePending = true } = {}) {
  const tx = store.state.transactions
    .filter(t => (!range.from || t.date >= range.from) && (!range.to || t.date <= range.to))
    .filter(t => includePending || t.status === 'approved')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  const rows = tx.map(t => {
    const c = t.category ? CAT[t.category] : null;
    return {
      date: t.date,
      day: DAYS[parseISO(t.date).getDay()],
      merchant: t.merchant,
      category: c ? c.name : 'Nezaradené',
      group: c ? KIND_LABEL[c.kind] : '—',
      type: typeOf(t),
      amount: t.amount,
      expense: t.amount < 0 ? -t.amount : 0,
      income: t.amount > 0 ? t.amount : 0,
      status: t.status === 'approved' ? 'Schválené' : 'Čaká',
      oneOff: t.oneOff ? 'Áno' : '',
      note: t.note || '',
      source: SOURCE[t.source] || t.source,
    };
  });

  // Súhrn rovnako ako v Prehľade: len schválené, presuny sa nerátajú, vratky znižujú výdavok
  const byCat = Object.fromEntries(CATEGORIES.map(c => [c.id, { sum: 0, count: 0 }]));
  const byMonth = {};
  let oneOff = 0;
  for (const t of tx) {
    if (t.status !== 'approved') continue;
    const c = CAT[t.category];
    const v = c.kind === 'income' ? t.amount : -t.amount;
    if (t.oneOff && (c.kind === 'variable' || c.kind === 'fixed')) oneOff += v;
    byCat[c.id].sum += v;
    byCat[c.id].count++;
    const m = t.date.slice(0, 7);
    byMonth[m] ??= { income: 0, variable: 0, fixed: 0, invest: 0 };
    if (c.kind in byMonth[m]) byMonth[m][c.kind] += v;
  }
  const r2 = n => Math.round(n * 100) / 100;
  const sumKind = k => r2(CATEGORIES.filter(c => c.kind === k).reduce((s, c) => s + byCat[c.id].sum, 0));
  const income = sumKind('income'), variable = sumKind('variable'), fixed = sumKind('fixed'), invest = sumKind('invest');
  const expenses = r2(variable + fixed);
  return {
    range, rows,
    pending: tx.filter(t => t.status !== 'approved').length,
    summary: {
      income, variable, fixed, invest, expenses, oneOff: r2(oneOff),
      balance: r2(income - expenses - invest),
      savingsRate: income > 0 ? (income - expenses) / income : null,
      categories: CATEGORIES.map(c => ({ ...c, sum: r2(byCat[c.id].sum), count: byCat[c.id].count })).filter(c => c.count),
      months: Object.keys(byMonth).sort().map(m => {
        const x = byMonth[m];
        return { month: m, income: r2(x.income), variable: r2(x.variable), fixed: r2(x.fixed), invest: r2(x.invest), balance: r2(x.income - x.variable - x.fixed - x.invest) };
      }),
    },
  };
}

/* =========================================================================
 *  CSV (Excel SK: ";" + desatinná čiarka + UTF-8 BOM)
 * ========================================================================= */

const HEAD = ['Dátum', 'Deň', 'Obchodník', 'Kategória', 'Skupina', 'Typ', 'Suma (€)', 'Výdavok (€)', 'Príjem (€)', 'Stav', 'Jednorazový', 'Poznámka', 'Zdroj'];

const csvNum = n => (n === 0 ? '0' : n.toFixed(2).replace('.', ','));
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`; // ochrana pred vzorcami v Exceli
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(data) {
  const lines = [HEAD.join(';')];
  for (const r of data.rows) {
    lines.push([skDate(r.date), r.day, r.merchant, r.category, r.group, r.type, csvNum(r.amount), csvNum(r.expense), csvNum(r.income), r.status, r.oneOff, r.note, r.source].map(csvCell).join(';'));
  }
  return new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
}

/* =========================================================================
 *  Excel (.xlsx) cez SheetJS
 * ========================================================================= */

let xlsxPromise = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxPromise = null; reject(new Error('Excel knižnicu sa nepodarilo načítať (si offline?). Skús CSV.')); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

const EUR = '#,##0.00 "€";-#,##0.00 "€"';
const PCT = '0.0%';

/** Súčtový vzorec s vopred vypočítanou hodnotou (iPhone náhľad a Numbers vzorce neprepočítavajú). */
function putSum(ws, XLSX, r, c, fromRow, toRow, value) {
  const col = XLSX.utils.encode_col(c);
  ws[XLSX.utils.encode_cell({ r, c })] = { t: 'n', v: Math.round(value * 100) / 100, f: `SUM(${col}${fromRow}:${col}${toRow})`, z: EUR };
}

function setFormat(ws, XLSX, col, fmt, fromRow, toRow) {
  for (let r = fromRow; r <= toRow; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
    if (cell && typeof cell.v === 'number') cell.z = fmt;
  }
}

export async function buildXlsx(data) {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const { rows, summary, range } = data;

  /* Hárok 1: Transakcie */
  const aoa = [HEAD, ...rows.map(r => [parseISO(r.date), r.day, r.merchant, r.category, r.group, r.type, r.amount, r.expense || null, r.income || null, r.status, r.oneOff, r.note, r.source])];
  const last = aoa.length;
  aoa.push([], ['Spolu']);
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const sum = key => rows.reduce((t, r) => t + r[key], 0);
  putSum(ws, XLSX, last + 1, 6, 2, last, sum('amount'));
  putSum(ws, XLSX, last + 1, 7, 2, last, sum('expense'));
  putSum(ws, XLSX, last + 1, 8, 2, last, sum('income'));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: last + 1, c: HEAD.length - 1 } });
  for (let r = 1; r < last; r++) {
    const c = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (c) c.z = 'd. m. yyyy';
  }
  for (const col of [6, 7, 8]) setFormat(ws, XLSX, col, EUR, 1, last - 1);
  ws['!cols'] = [12, 10, 30, 24, 14, 11, 12, 12, 12, 11, 12, 28, 11].map(wch => ({ wch }));
  ws['!autofilter'] = { ref: `A1:M${Math.max(1, last)}` };
  XLSX.utils.book_append_sheet(wb, ws, 'Transakcie');

  /* Hárok 2: Súhrn */
  const sAoa = [
    ['Financie – prehľad', ''],
    ['Obdobie', range.label],
    ['Vytvorené', new Date().toLocaleString('sk-SK')],
    [],
    ['Cash-flow (len schválené platby, bez presunov)', ''],
    ['Príjmy', summary.income],
    ['Voľné výdavky', summary.variable],
    ['Fixné výdavky', summary.fixed],
    ['Výdavky spolu', summary.expenses],
    ['  z toho jednorazové (⭐)', summary.oneOff],
    ['Investície a sporenie', summary.invest],
    ['Zostatok (príjmy − výdavky − investície)', summary.balance],
    ['Miera sporenia (pred investíciami)', summary.savingsRate],
    [],
    ['Kategória', 'Skupina', 'Počet', 'Suma (€)', 'Podiel na výdavkoch'],
  ];
  const outTotal = summary.expenses + summary.invest;
  for (const c of summary.categories) {
    const share = c.kind === 'income' || c.kind === 'transfer' || !outTotal ? null : c.sum / outTotal;
    sAoa.push([`${c.icon} ${c.name}`, KIND_LABEL[c.kind], c.count, c.sum, share]);
  }
  if (data.pending) sAoa.push([], [`Pozor: ${data.pending} neschválených platieb nie je v súhrne započítaných.`]);
  const ss = XLSX.utils.aoa_to_sheet(sAoa);
  setFormat(ss, XLSX, 1, EUR, 5, 11);
  const rate = ss['B13']; if (rate && typeof rate.v === 'number') rate.z = PCT;
  setFormat(ss, XLSX, 3, EUR, 15, 15 + summary.categories.length);
  setFormat(ss, XLSX, 4, PCT, 15, 15 + summary.categories.length);
  ss['!cols'] = [{ wch: 42 }, { wch: 18 }, { wch: 8 }, { wch: 14 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ss, 'Súhrn');

  /* Hárok 3: Po mesiacoch (pri roku/celkovo, alebo ak obdobie zasahuje do viacerých mesiacov) */
  if (summary.months.length > 1 || range.kind === 'year' || range.kind === 'all') {
    const mAoa = [['Mesiac', 'Príjmy', 'Voľné výdavky', 'Fixné výdavky', 'Investície', 'Zostatok']];
    for (const m of summary.months) {
      const [y, mo] = m.month.split('-').map(Number);
      mAoa.push([`${MONTHS[mo - 1]} ${y}`, m.income, m.variable, m.fixed, m.invest, m.balance]);
    }
    const n = mAoa.length;
    mAoa.push(['Spolu']);
    const ms = XLSX.utils.aoa_to_sheet(mAoa);
    ['income', 'variable', 'fixed', 'invest', 'balance'].forEach((key, i) => {
      setFormat(ms, XLSX, i + 1, EUR, 1, n - 1);
      putSum(ms, XLSX, n, i + 1, 2, n, summary.months.reduce((t, m) => t + m[key], 0));
    });
    ms['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: n, c: 5 } });
    ms['!cols'] = [{ wch: 16 }, ...Array(5).fill({ wch: 15 })];
    XLSX.utils.book_append_sheet(wb, ms, 'Po mesiacoch');
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* =========================================================================
 *  Uloženie / zdieľanie
 * ========================================================================= */

/**
 * Na iPhone otvorí systémové zdieľanie (Uložiť do Súborov, Mail, AirDrop…),
 * inde stiahne súbor. Vracia 'shared' | 'downloaded' | 'cancelled'.
 */
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || navigator.standalone;
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // iné chyby → skús klasické stiahnutie
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return 'downloaded';
}

export function fileName(range, ext) {
  return `financie-${range.file}.${ext}`;
}

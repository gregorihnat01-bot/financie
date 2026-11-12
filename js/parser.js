/**
 * parser.js — extrakcia platieb z EML (bankové notifikácie), PDF (výpisy) a čistého textu.
 *
 * Výstup je vždy pole "surových" transakcií: { date, amount, merchant, note, source }
 * Záporná suma = výdavok, kladná = príjem. Store ich potom zaradí do inboxu.
 */

import { stripDiacritics, todayISO } from './store.js';

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

/* =========================================================================
 *  Vstupný bod
 * ========================================================================= */

export async function parseFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const text = await pdfToText(file);
    return extractTransactions(text, { source: 'pdf', statement: true });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const binary = bytesToBinary(bytes);
  if (name.endsWith('.eml') || file.type === 'message/rfc822' || looksLikeEml(binary)) {
    const mail = parseEml(binary);
    return extractTransactions(mail.text, { source: 'eml', fallbackDate: mail.date, subject: mail.subject });
  }
  return extractTransactions(new TextDecoder('utf-8').decode(bytes), { source: 'text' });
}

/** Text vložený zo schránky / zo Skratky. Rozpozná aj surový EML. */
export function parseText(text, source = 'text') {
  if (looksLikeEml(text)) {
    const mail = parseEml(utf8ToBinary(text));
    return extractTransactions(mail.text, { source, fallbackDate: mail.date, subject: mail.subject });
  }
  return extractTransactions(text, { source });
}

/* =========================================================================
 *  EML (RFC 822 / MIME)
 * ========================================================================= */

function looksLikeEml(s) {
  const head = s.slice(0, 4000);
  return /^(received|from|date|subject|mime-version|return-path|delivered-to|message-id):/im.test(head) &&
         /^content-type:/im.test(head) || /^mime-version:/im.test(head);
}

function bytesToBinary(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return out;
}

function binaryToBytes(bin) {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function utf8ToBinary(text) {
  return bytesToBinary(new TextEncoder().encode(text));
}

function decodeCharset(bin, charset = 'utf-8') {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^"|"$/g, '') || 'utf-8').decode(binaryToBytes(bin));
  } catch {
    return new TextDecoder('utf-8').decode(binaryToBytes(bin));
  }
}

function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeB64(s) {
  try { return atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); } catch { return ''; }
}

/** =?utf-8?B?...?= a =?utf-8?Q?...?= v hlavičkách */
function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, data) => {
    const bin = enc.toUpperCase() === 'B' ? decodeB64(data) : decodeQP(data.replace(/_/g, ' '));
    return decodeCharset(bin, cs);
  }).replace(/\?=\s+=\?/g, '?==?');
}

function splitHeadersBody(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function parseHeaders(head) {
  const headers = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!(k in headers)) headers[k] = line.slice(i + 1).trim();
    }
  }
  return headers;
}

function headerParam(value, param) {
  const m = new RegExp(`${param}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value || '');
  return m ? (m[2] ?? m[1]) : '';
}

/** Rekurzívne prejde MIME strom a zozbiera text/plain a text/html časti. */
function walkMime(raw, parts, depth = 0) {
  if (depth > 8) return;
  const { head, body } = splitHeadersBody(raw);
  const h = parseHeaders(head);
  const ctype = (h['content-type'] || 'text/plain').toLowerCase();
  const disposition = (h['content-disposition'] || '').toLowerCase();

  if (ctype.startsWith('multipart/')) {
    const boundary = headerParam(h['content-type'], 'boundary');
    if (!boundary) return;
    const chunks = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const chunk of chunks) if (chunk.trim()) walkMime(chunk, parts, depth + 1);
    return;
  }
  if (ctype.startsWith('message/rfc822')) { walkMime(body, parts, depth + 1); return; }
  if (!ctype.startsWith('text/') || disposition.startsWith('attachment')) return;

  const cte = (h['content-transfer-encoding'] || '').toLowerCase();
  let bin = body;
  if (cte === 'base64') bin = decodeB64(body);
  else if (cte === 'quoted-printable') bin = decodeQP(body);
  const text = decodeCharset(bin, headerParam(h['content-type'], 'charset') || 'utf-8');
  parts.push({ type: ctype.startsWith('text/html') ? 'html' : 'plain', text });
}

export function parseEml(binary) {
  const { head } = splitHeadersBody(binary);
  const h = parseHeaders(head);
  const parts = [];
  walkMime(binary, parts);
  const plain = parts.filter(p => p.type === 'plain').map(p => p.text).join('\n').trim();
  const html = parts.filter(p => p.type === 'html').map(p => htmlToText(p.text)).join('\n').trim();
  // Niektoré banky posielajú v plain časti len "zobrazte si HTML verziu" → zober dlhšiu.
  const text = plain.length >= html.length * 0.5 && plain ? plain : html || plain;

  const subject = decodeWords(decodeCharset(h.subject || '', 'utf-8'));
  let date = null;
  const d = h.date ? new Date(h.date) : null;
  if (d && !isNaN(d)) date = toISO(d);
  return { subject, date, text: `${subject}\n${text}` };
}

export function htmlToText(html) {
  const prepared = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' \t ');
  const doc = new DOMParser().parseFromString(prepared, 'text/html'); // neexekvuje skripty
  return (doc.body?.textContent || '').replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/* =========================================================================
 *  PDF (pdf.js sa načíta lenivo až pri prvom PDF)
 * ========================================================================= */

let pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  pdfjsPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${PDFJS_BASE}/pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsPromise = null; reject(new Error('PDF knižnicu sa nepodarilo načítať (si offline?).')); };
    document.head.appendChild(s);
  });
  return pdfjsPromise;
}

async function pdfToText(file) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Zoskup textové kúsky do riadkov podľa Y súradnice, zoraď podľa X.
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, items]) => lines.push(items.sort((a, b) => a.x - b.x).map(i => i.s).join('  ')));
  }
  return lines.join('\n');
}

/* =========================================================================
 *  Extrakcia transakcií z textu
 * ========================================================================= */

// Číslo: 1 234,56 | 1.234,56 | 1234.56 | -12,5 | 15  — (?!\d) bráni useknutiu čísla
const NUM = String.raw`[+\-−–]?\s?(?:\d{1,3}(?:[ \u00a0.']\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)`;
const CUR = String.raw`(?:EUR|€|CZK|Kč|USD|\$)`;
const RE_AMOUNT_CUR = new RegExp(String.raw`(${NUM})\s?${CUR}|${CUR}\s?(${NUM})`, 'gi');
const RE_DATE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/;

const AMOUNT_LABELS = /(suma|ciastka|vyska|amount|transakci[ae] na sumu|na sumu|zauctovan|platba vo vyske|vo vyske|hodnota)/;
const IGNORE_CONTEXT = /(zostatok|disponibiln|balance|limit|poplatok za vedenie|kurz)/;
const INCOME_WORDS = /(kredit|credit|prijat|pripisan|prichadz|incoming|zvysenie zostatku|vratk|refund|pripis)/;
const EXPENSE_WORDS = /(debet|debit|platba kartou|odchadz|vyber|znizenie zostatku|zaplatil|uhrad|nakup|outgoing|transakcia kartou|karta)/;

const MERCHANT_LABELS = [
  'obchodnik', 'u obchodnika', 'miesto transakcie', 'miesto', 'nazov protistrany', 'protistrana', 'prijemca',
  'prijimatel', 'platitel', 'odosielatel', 'od', 'merchant', 'beneficiary', 'popis transakcie', 'popis', 'detail',
];

export function parseAmount(str) {
  let s = String(str).replace(/[\s\u00a0\u202f']/g, '').replace(/[−–]/g, '-');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot > -1 && lastComma > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  } else if (lastDot > -1 && s.length - lastDot - 1 === 3) {
    s = s.replace(/\./g, ''); // 1.234 = tisíce
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(str) {
  const m = RE_DATE.exec(str);
  if (!m) return null;
  let y, mo, d;
  if (m[1]) [d, mo, y] = [m[1], m[2], m[3]];
  else if (m[4]) [y, mo, d] = [m[4], m[5], m[6]];
  else [d, mo, y] = [m[7], m[8], m[9]];
  const date = new Date(+y, +mo - 1, +d);
  if (isNaN(date) || date.getMonth() !== +mo - 1) return null;
  return toISO(date);
}

const norm = s => stripDiacritics(s).toLowerCase();

const RE_NEXT_LABEL = /\s+(d[aá]tum|dňa|suma|čiastka|zostatok|disponibiln\S*|čas|karta|číslo|variabiln\S*|referencia|IBAN|účet)\b.*$/i;

function cleanMerchant(s) {
  return String(s || '')
    .replace(new RegExp(RE_DATE.source, 'g'), ' ')
    .replace(RE_AMOUNT_CUR, ' ')
    .replace(RE_NEXT_LABEL, '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b(SK|CZ)\d{2}[\d ]{10,}\b/g, ' ')     // IBAN
    .replace(/\*{2,}\d{2,4}|\bx{2,}\d{4}\b/gi, ' ')  // maskované číslo karty
    .replace(/^[\s:\-–|,.]+|[\s:\-–|,.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

function findAmounts(text) {
  const out = [];
  RE_AMOUNT_CUR.lastIndex = 0;
  let m;
  while ((m = RE_AMOUNT_CUR.exec(text))) {
    const raw = m[1] ?? m[2];
    const value = parseAmount(raw);
    if (!Number.isFinite(value) || value === 0) continue;
    const before = norm(text.slice(Math.max(0, m.index - 60), m.index));
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    out.push({
      value,
      explicitSign: /^[+\-−–]/.test(raw.trim()),
      index: m.index,
      labeled: AMOUNT_LABELS.test(before.slice(-40)),
      ignored: IGNORE_CONTEXT.test(norm(text.slice(lineStart, m.index)) || before.slice(-30)),
    });
  }
  return out;
}

/**
 * Formát "popis na samostatnom riadku, hodnota pod ním" (napr. ČSOB):
 *   Suma
 *   22,14 EUR
 *   Miesto
 *   ANTHROPIC* CLAUDE SUB
 */
function labelValue(lines, labels) {
  for (const label of labels) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (norm(lines[i]).replace(/[:\s]+$/, '') === label) return lines[i + 1].trim();
    }
  }
  return '';
}

const OWN_LINE_MERCHANT = ['miesto', 'miesto transakcie', 'obchodnik', 'nazov obchodnika', 'nazov protistrany', 'protistrana', 'prijemca', 'platitel', 'protiucet'];

function findMerchant(lines) {
  const own = labelValue(lines, OWN_LINE_MERCHANT);
  if (own) {
    // maskovaný protiúčet "**** 1642" → "Účet ****1642"
    if (/^\*{2,}\s?\d{2,6}$/.test(own)) return `Účet ${own.replace(/\s/g, '')}`;
    const v = cleanMerchant(own);
    if (v.length > 1) return v;
  }
  for (const label of MERCHANT_LABELS) {
    for (let i = 0; i < lines.length; i++) {
      const l = norm(lines[i]);
      const re = new RegExp(`(^|\\s)${label}\\s*[:\\-–]\\s*(.*)$`);
      const m = re.exec(l);
      if (!m) continue;
      // vezmi originálny text (s diakritikou) z rovnakej pozície
      const original = lines[i].slice(lines[i].length - m[2].length);
      const value = cleanMerchant(original) || cleanMerchant(lines[i + 1]);
      if (value && value.length > 1) return value;
    }
  }
  // "Platba kartou u obchodníka LIDL BRATISLAVA bola..."
  const joined = lines.join(' ');
  const inline = /(?:u obchodn[ií]ka|v obchode|at|v prevádzke|pri|[Pp]latba kartou|[Nn]ákup)\s+([A-ZÁČĎÉÍĽĹŇÓÔŔŠŤÚÝŽ0-9][\wÁČĎÉÍĽĹŇÓÔŔŠŤÚÝŽáčďéíľĺňóôŕšťúýž&.\- ]{2,40}?)(?=\s+(?:bola|dňa|v sume|na sumu|za|vo výške|,|\.|$))/.exec(joined);
  if (inline) return cleanMerchant(inline[1]);
  return '';
}

function decideSign(value, explicitSign, context) {
  if (explicitSign) return value;
  const c = norm(context);
  const inc = INCOME_WORDS.test(c), exp = EXPENSE_WORDS.test(c);
  if (inc && !exp) return Math.abs(value);
  return -Math.abs(value); // bankové notifikácie sú najčastejšie výdavky
}

/**
 * @param {string} text
 * @param {{source:string, statement?:boolean, fallbackDate?:string, subject?:string}} opts
 */
export function extractTransactions(text, opts = {}) {
  const src = String(text || '')
    .replace(/\r/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[\u00ad\u034f\u200b-\u200d\u2060\ufeff]/g, ''); // neviditeľné znaky z preheaderov
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  // Režim výpisu: veľa riadkov, kde je dátum aj suma → každý riadok = transakcia.
  const rowLines = lines.filter(l => RE_DATE.test(l) && findAmounts(l + ' ').length || RE_DATE.test(l) && new RegExp(`\\s${NUM}\\s*$`).test(l));
  if (opts.statement || rowLines.length >= 3) {
    const rows = parseStatement(lines, opts);
    if (rows.length) return rows;
  }
  const single = parseNotification(src, lines, opts);
  return single ? [single] : [];
}

function parseNotification(src, lines, opts) {
  const amounts = findAmounts(src).filter(a => !a.ignored);
  if (!amounts.length) return null;
  const pick = amounts.find(a => a.labeled) || amounts.find(a => a.explicitSign) || amounts[0];
  const context = src.slice(Math.max(0, pick.index - 200), pick.index + 60) + ' ' + (opts.subject || '');
  const amount = decideSign(pick.value, pick.explicitSign, context);

  const dateLine = labelValue(lines, ['datum', 'datum transakcie', 'datum zauctovania']) ||
    lines.find(l => /d[aá]tum|dňa|date|zaúčtovan|transakci/i.test(l) && RE_DATE.test(l));
  const date = parseDate(dateLine || '') || parseDate(src) || opts.fallbackDate || todayISO();

  let merchant = findMerchant(lines);
  const subjectIsGeneric = !opts.subject || RE_AMOUNT_CUR.test(opts.subject) || /^(transakcia|pohyb|platba|notifik)/i.test(opts.subject);
  RE_AMOUNT_CUR.lastIndex = 0;
  if (!merchant && opts.subject && !subjectIsGeneric) merchant = cleanMerchant(opts.subject);

  // Poznámka: mesto (ak to nie je telefón) a účel platby (ak nie je predvyplnený bankou)
  const city = labelValue(lines, ['mesto']);
  const purpose = labelValue(lines, ['ucel platby', 'sprava pre prijemcu', 'sprava pre prijimatela', 'poznamka']);
  const note = [
    city && !/^\+?\d[\d\s]{5,}$/.test(city) ? city : '',
    purpose && !/^miesto pre pozn/i.test(norm(purpose)) ? purpose : '',
  ].filter(Boolean).join(' · ') || (subjectIsGeneric ? '' : opts.subject?.slice(0, 120) || '');

  return {
    date,
    amount,
    merchant: merchant || 'Neznáma platba',
    note: note.slice(0, 120),
    source: opts.source || 'text',
  };
}

function parseStatement(lines, opts) {
  const out = [];
  for (const line of lines) {
    const date = parseDate(line);
    if (!date) continue;
    let amounts = findAmounts(line + ' ').filter(a => !a.ignored);
    if (!amounts.length) {
      // Výpisy často nemajú menu pri každom riadku: "05.11.2026  LIDL  -23,40"
      // Pri viacerých číslach (suma + zostatok) vyhrá to so znamienkom, inak prvé.
      const nums = (line.replace(new RegExp(RE_DATE.source, 'g'), ' ').match(new RegExp(NUM, 'g')) || [])
        .filter(n => /[.,]\d{2}$/.test(n.trim()))
        .map(n => ({ value: parseAmount(n), explicitSign: /^[+\-−–]/.test(n.trim()) }));
      if (nums.length) amounts = [nums.find(n => n.explicitSign) || nums[0]];
    }
    if (!amounts.length || !Number.isFinite(amounts[0].value)) continue;
    const a = amounts.find(x => x.explicitSign) || amounts[0];
    const noDate = line.replace(new RegExp(RE_DATE.source, 'g'), ' ');
    const merchant = cleanMerchant(noDate.replace(new RegExp(`${NUM}\\s*${CUR}?`, 'g'), m => /[.,]\d{2}/.test(m) ? ' ' : m));
    if (/^(spolu|celkom|suma|zostatok|pociatocny|konecny)/i.test(norm(merchant))) continue;
    out.push({
      date,
      amount: decideSign(a.value, a.explicitSign, line),
      merchant: merchant || 'Položka z výpisu',
      note: '',
      source: opts.source || 'pdf',
    });
  }
  return out;
}

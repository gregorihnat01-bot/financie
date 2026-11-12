/**
 * ui.js — reaktívne vykresľovanie, gestá, sheety, import a deep linky.
 *
 * Tok dát je jednosmerný:  akcia → store (uloží) → subscribe → render()
 * UI nikdy nedrží vlastnú kópiu transakcií, preto nemôže "zostať visieť" stará položka v inboxe.
 */

import { store, CATEGORIES, CAT, monthStats, shiftMonth, merchantKey, todayISO } from './store.js';
import { parseFile, parseText, extractTransactions } from './parser.js';

/* =========================================================================
 *  Helpers
 * ========================================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

const money = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR' });
const moneyShort = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmt = n => money.format(Math.abs(n));
const fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money.format(Math.abs(n));
const fmtShort = n => (n < 0 ? '−' : '') + moneyShort.format(Math.abs(n));

const dayFmt = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'short' });
const dayLongFmt = new Intl.DateTimeFormat('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
const monthFmt = new Intl.DateTimeFormat('sk-SK', { month: 'long', year: 'numeric' });
const monthShortFmt = new Intl.DateTimeFormat('sk-SK', { month: 'short' });

const isoToDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
function fmtDay(iso, long = false) {
  const today = todayISO();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (iso === today) return 'Dnes';
  if (iso === yesterday) return 'Včera';
  return (long ? dayLongFmt : dayFmt).format(isoToDate(iso));
}
const monthLabel = m => monthFmt.format(isoToDate(m + '-01'));

const SOURCE_LABEL = { eml: 'E-mail', pdf: 'PDF výpis', text: 'Text', clipboard: 'Schránka', shortcut: 'Skratka', manual: 'Ručne', link: 'Odkaz', demo: 'Ukážka', gmail: 'Gmail' };
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

/* =========================================================================
 *  UI stav (iba prezentačný — žiadne dáta)
 * ========================================================================= */
const ui = {
  tab: 'inbox',
  month: todayISO().slice(0, 7),
  txFilter: 'all',
  txQuery: '',
  txLimit: 150,
  focusId: null,
};

const APP_VERSION = '6';

const TITLES = { inbox: 'Schváliť', overview: 'Prehľad', tx: 'Transakcie' };

/* =========================================================================
 *  Render
 * ========================================================================= */
function render() {
  renderBadge();
  if (ui.tab === 'inbox') renderInbox();
  else if (ui.tab === 'overview') renderOverview();
  else renderTxList();
}

function renderBadge() {
  const n = store.pending().length;
  const b = $('#inbox-badge');
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : n;
}

function setTab(tab) {
  if (!TITLES[tab]) return;
  ui.tab = tab;
  $('#title').textContent = TITLES[tab];
  for (const btn of $$('.tab')) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active);
  }
  for (const v of ['inbox', 'overview', 'tx']) $(`#view-${v === 'tx' ? 'tx' : v}`).hidden = v !== tab;
  window.scrollTo({ top: 0 });
  render();
}

/* ---------- 1) INBOX ---------- */
function orderedPending() {
  const list = store.pending();
  if (ui.focusId) {
    const i = list.findIndex(t => t.id === ui.focusId);
    if (i > 0) list.unshift(...list.splice(i, 1));
    else if (i < 0) ui.focusId = null;
  }
  return list;
}

function renderInbox() {
  const view = $('#view-inbox');
  const list = orderedPending();

  if (!list.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="empty__icon">✓</div>
        <h2>Všetko vyriešené</h2>
        <p>Žiadne platby nečakajú na schválenie.</p>
        <div class="row">
          ${gmailConnected()
            ? '<button class="btn" data-action="gmail-sync">↻ Skontrolovať Gmail</button>'
            : '<button class="btn" data-action="paste">📋 Zo schránky</button>'}
          <button class="btn" data-action="import">📥 Import</button>
        </div>
        ${gmailStatusLine()}
      </div>
      ${recentApprovedHTML()}`;
    return;
  }

  const top = list[0];
  const s = store.suggest(top);
  const known = list.filter(t => store.suggest(t).source === 'rule');

  view.innerHTML = `
    <div class="inbox-head">
      <div class="inbox-head__count"><b>${list.length}</b> ${list.length === 1 ? 'čaká' : 'čakajú'} na schválenie</div>
      ${known.length > 1 ? `<button class="btn btn--sm" data-action="bulk">Schváliť známe (${known.length})</button>`
        : gmailConnected()
          ? `<button class="btn btn--sm" data-action="gmail-sync">↻ Gmail</button>`
          : `<button class="btn btn--sm" data-action="paste">📋 Vložiť</button>`}
    </div>
    <div class="stack">
      ${list.length > 2 ? '<div class="stack__ghost stack__ghost--2"></div>' : ''}
      ${list.length > 1 ? '<div class="stack__ghost stack__ghost--1"></div>' : ''}
      ${cardHTML(top, s)}
    </div>
    ${list.length > 1 ? `
      <div class="queue">
        <div class="section-title">V poradí</div>
        <div class="glass list">
          ${list.slice(1, 8).map(t => {
            const sg = store.suggest(t);
            return `<button class="list-row" data-action="focus" data-id="${esc(t.id)}">
              <span class="list-row__icon" style="--c:${CAT[sg.category].color}">${CAT[sg.category].icon}</span>
              <span class="list-row__main">
                <span class="list-row__title">${esc(t.merchant)}</span>
                <span class="list-row__sub">${fmtDay(t.date)} · návrh: ${CAT[sg.category].short}${sg.source === 'rule' ? ' ✓' : ''}</span>
              </span>
              <span class="list-row__end ${t.amount > 0 ? 'pos' : ''}">${fmtSigned(t.amount)}</span>
            </button>`;
          }).join('')}
          ${list.length > 8 ? `<div class="list-row muted small">+ ďalších ${list.length - 8}</div>` : ''}
        </div>
      </div>` : ''}`;

  bindSwipe($('.card', view));
}

function cardHTML(t, s) {
  const c = CAT[s.category];
  const hint = {
    rule: `Zapamätané pre „${esc(merchantKey(t.merchant))}“`,
    keyword: 'Odhad podľa názvu obchodníka',
    guess: 'Odhad — ťukni na správnu kategóriu',
  }[s.source];
  return `
    <article class="card" data-id="${esc(t.id)}">
      <span class="swipe-label swipe-label--yes">SCHVÁLIŤ</span>
      <span class="swipe-label swipe-label--no">NESKÔR</span>
      <div class="card__meta">
        <span>${esc(fmtDay(t.date, true))}</span>
        <span class="card__source">${esc(SOURCE_LABEL[t.source] || t.source)}</span>
      </div>
      <div class="card__amount num ${t.amount > 0 ? 'pos' : ''}">${fmtSigned(t.amount)}</div>
      <div class="card__merchant">${esc(t.merchant)}</div>
      ${t.note ? `<div class="card__note">${esc(t.note)}</div>` : ''}
      <div class="card__hint"><span class="dot dot--${s.source}"></span>${hint}</div>
      <button class="btn btn--primary btn--approve" data-action="approve" data-cat="${c.id}">
        Schváliť <span class="emoji">${c.icon}</span> ${esc(c.short)}
      </button>
      <div class="cat-grid">
        ${CATEGORIES.map(k => `
          <button class="cat-btn ${k.id === c.id ? 'is-selected' : ''}" style="--c:${k.color}" data-action="approve" data-cat="${k.id}" aria-label="Zaradiť do ${esc(k.name)}">
            <span class="emoji">${k.icon}</span>${esc(k.short)}
          </button>`).join('')}
      </div>
      <div class="card__footer">
        <button class="btn" data-action="snooze">↩︎ Neskôr</button>
        <button class="btn" data-action="edit">Upraviť</button>
        <button class="btn" data-action="delete">Zmazať</button>
      </div>
    </article>`;
}

function recentApprovedHTML() {
  const recent = store.approved().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5);
  if (!recent.length) return '';
  return `<div class="section-title">Naposledy zaradené</div><div class="glass list">${recent.map(txRowHTML).join('')}</div>`;
}

/** Schválenie: animácia klonu + okamžitý commit do store (uloží + prekreslí). */
function approveTx(id, category, cardEl, dir = 1) {
  const tx = store.get(id);
  if (!tx || !CAT[category]) return;
  const key = merchantKey(tx.merchant);
  const prevRule = store.state.rules[key] || null;
  if (cardEl) flyOut(cardEl, dir);
  if (ui.focusId === id) ui.focusId = null;

  store.approve(id, category); // ← uloží do LocalStorage, naučí pravidlo, okamžite prekreslí inbox

  const same = store.pendingSameMerchant(tx);
  const c = CAT[category];
  if (same.length) {
    toast(`${c.icon} ${c.short} · aj ďalšie ${same.length} od ${tx.merchant}?`, {
      label: 'Zaradiť',
      fn: () => {
        const n = store.approveMany(same.map(t => [t.id, category]));
        toast(`Zaradené ďalšie ${plural(n, 'platba', 'platby', 'platieb')}`);
      },
    });
  } else {
    toast(`${c.icon} Zaradené do ${c.short}`, {
      label: 'Späť',
      fn: () => {
        store.update(id, { status: 'pending', category: null });
        store.setRule(key, prevRule);
        ui.focusId = id;
        render();
      },
    });
  }
}

function flyOut(el, dir = 1) {
  const r = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.classList.remove('is-dragging', 'is-returning');
  clone.classList.add('card--fly');
  Object.assign(clone.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, transform: el.style.transform || 'none' });
  document.body.appendChild(clone);
  clone.getBoundingClientRect(); // reflow
  requestAnimationFrame(() => {
    clone.style.transform = dir > 0
      ? 'translate(120vw, -60px) rotate(18deg)'
      : 'translate(-120vw, -40px) rotate(-18deg)';
    clone.style.opacity = '0';
  });
  setTimeout(() => clone.remove(), 480);
}

/** Swipe: doprava = schváliť návrh, doľava = neskôr. */
function bindSwipe(card) {
  if (!card) return;
  const yes = $('.swipe-label--yes', card), no = $('.swipe-label--no', card);
  let sx = 0, sy = 0, dx = 0, dragging = false, tracking = false, moved = false;
  const THRESHOLD = 110;

  card.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true; dragging = false; moved = false; sx = e.clientX; sy = e.clientY; dx = 0;
  });
  card.addEventListener('pointermove', e => {
    if (!tracking) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!dragging) {
      if (Math.abs(mx) < 10) return;
      if (Math.abs(my) > Math.abs(mx)) { tracking = false; return; } // vertikálny scroll
      dragging = true; moved = true;
      card.classList.add('is-dragging');
      card.classList.remove('is-returning');
      try { card.setPointerCapture(e.pointerId); } catch {}
    }
    dx = mx;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    const p = Math.min(1, Math.abs(dx) / THRESHOLD);
    yes.style.opacity = dx > 0 ? p : 0;
    no.style.opacity = dx < 0 ? p : 0;
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    card.classList.remove('is-dragging');
    const id = card.dataset.id;
    if (dx > THRESHOLD) {
      approveTx(id, store.suggest(store.get(id)).category, card, 1);
    } else if (dx < -THRESHOLD) {
      flyOut(card, -1);
      store.snooze(id);
      toast('Presunuté na koniec frontu');
    } else {
      card.classList.add('is-returning');
      card.style.transform = '';
      yes.style.opacity = no.style.opacity = 0;
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  // Po potiahnutí nesmie prebehnúť "click" na tlačidle pod prstom.
  card.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}

/* ---------- 2) PREHĽAD ---------- */
function renderOverview() {
  const view = $('#view-overview');
  const st = monthStats(ui.month);
  const isCurrent = ui.month >= todayISO().slice(0, 7);
  const spendCats = CATEGORIES.filter(c => ['variable', 'fixed', 'invest'].includes(c.kind));
  const outTotal = spendCats.reduce((s, c) => s + Math.max(0, st.byCat[c.id]), 0);
  const rows = spendCats.map(c => ({ c, v: st.byCat[c.id] })).filter(r => r.v !== 0).sort((a, b) => b.v - a.v);
  const maxRow = Math.max(1, ...rows.map(r => r.v));

  const rateText = st.savingsRate == null ? 'Zatiaľ žiadny príjem v tomto mesiaci'
    : `Ušetrené ${Math.round(st.savingsRate * 100)} % príjmu (pred investíciami)`;

  view.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" data-action="month" data-delta="-1" aria-label="Predchádzajúci mesiac"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
      <div class="month-nav__label">${esc(monthLabel(ui.month))}</div>
      <button class="icon-btn" data-action="month" data-delta="1" aria-label="Ďalší mesiac" ${isCurrent ? 'disabled style="opacity:.3"' : ''}><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
    </div>

    <div class="glass hero">
      <div class="hero__label">Cash-flow mesiaca</div>
      <div class="hero__value num ${st.balance >= 0 ? 'pos' : ''}">${fmtSigned(st.balance)}</div>
      <div class="hero__sub">${rateText}</div>
    </div>

    <div class="tiles">
      <div class="glass tile"><div class="tile__label">Príjmy</div><div class="tile__value num pos">${fmtShort(st.income)}</div></div>
      <div class="glass tile"><div class="tile__label">Výdavky</div><div class="tile__value num">${fmtShort(st.expenses)}</div></div>
      <div class="glass tile"><div class="tile__label">Investované</div><div class="tile__value num">${fmtShort(st.invest)}</div></div>
    </div>

    ${st.pending ? `
      <button class="glass alert" data-action="goto-inbox">
        <span class="alert__icon">⚡</span>
        <span class="list-row__main"><b>${plural(st.pending, 'platba čaká', 'platby čakajú', 'platieb čaká')}</b><br><span class="muted small">Schváľ ich, aby sedeli čísla.</span></span>
        <span class="muted">›</span>
      </button>` : ''}

    <div class="section-title">Kam išli peniaze</div>
    <div class="glass panel">
      ${rows.length ? `
        <div class="stackbar" role="img" aria-label="Rozdelenie výdavkov podľa kategórií">
          ${rows.filter(r => r.v > 0).map(r => `<span class="stackbar__seg" style="--c:${r.c.color};flex:${r.v}" title="${esc(r.c.short)}: ${fmt(r.v)}"></span>`).join('')}
        </div>
        <div class="legend">
          ${['variable', 'fixed', 'invest'].map(kind => {
            const v = kind === 'variable' ? st.variable : kind === 'fixed' ? st.fixed : st.invest;
            return `<span>${{ variable: 'Voľné', fixed: 'Fixné', invest: 'Investície' }[kind]} <b class="num">${outTotal ? Math.round(Math.max(0, v) / outTotal * 100) : 0} %</b></span>`;
          }).join('')}
        </div>
        <div style="margin-top:6px">
          ${rows.map(r => `
            <button class="cat-row" style="--c:${r.c.color};width:100%;text-align:left" data-action="filter-cat" data-cat="${r.c.id}">
              <span class="cat-row__icon">${r.c.icon}</span>
              <span class="cat-row__name">${esc(r.c.short)} <span class="muted small">· ${r.c.kind === 'fixed' ? 'fixné' : r.c.kind === 'invest' ? 'investícia' : 'voľné'}</span></span>
              <span class="cat-row__val">${r.v < 0 ? '+' : ''}${fmt(r.v)}</span>
              <span class="cat-row__bar"><i style="width:${Math.max(0, r.v) / maxRow * 100}%"></i></span>
            </button>`).join('')}
        </div>` : `<div class="muted small" style="text-align:center;padding:18px 0">V tomto mesiaci zatiaľ nie sú zaradené výdavky.</div>`}
    </div>

    <div class="section-title">Posledných 6 mesiacov</div>
    <div class="glass panel trend" id="trend">${trendSVG()}</div>
  `;
  bindTrend();
}

let trendData = [];
function trendSVG() {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(ui.month, i - 5));
  const data = trendData = months.map(m => { const s = monthStats(m); return { m, inc: s.income, out: s.expenses + s.invest, bal: s.balance }; });
  const max = Math.max(1, ...data.flatMap(d => [d.inc, d.out]));
  const W = 340, H = 150, top = 14, base = 120, colW = W / 6, bw = 14;
  const y = v => base - (Math.max(0, v) / max) * (base - top);
  const bar = (x, v, cls) => {
    const yy = y(v), h = base - yy;
    if (h < 0.5) return '';
    const r = Math.min(4, h, bw / 2);
    return `<path class="${cls}" d="M${x},${base} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${base} Z"/>`;
  };
  return `
    <div class="legend" style="margin:0 0 10px">
      <span><i class="swatch" style="--c:var(--green)"></i>Príjmy</span>
      <span><i class="swatch" style="--c:rgba(235,235,245,.55)"></i>Výdavky + investície</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Príjmy a výdavky za posledných 6 mesiacov">
      <line class="grid-line" x1="0" x2="${W}" y1="${top}" y2="${top}"/>
      <line class="grid-line" x1="0" x2="${W}" y1="${(top + base) / 2}" y2="${(top + base) / 2}"/>
      <line class="grid-line" x1="0" x2="${W}" y1="${base}" y2="${base}" style="stroke:rgba(255,255,255,.18)"/>
      <text class="axis-label" x="0" y="${top - 4}">${esc(fmtShort(max))}</text>
      ${data.map((d, i) => {
        const cx = i * colW + colW / 2;
        const active = d.m === ui.month;
        return `<g class="col ${active ? '' : 'is-dim'}" data-i="${i}">
          ${bar(cx - bw - 1, d.inc, 'bar-in')}
          ${bar(cx + 1, d.out, 'bar-out')}
          <text class="axis-label ${active ? 'axis-label--active' : ''}" x="${cx}" y="${base + 18}" text-anchor="middle">${esc(monthShortFmt.format(isoToDate(d.m + '-01')).replace('.', ''))}</text>
          <rect class="hit" x="${i * colW}" y="0" width="${colW}" height="${H}" data-month="${d.m}" data-i="${i}"/>
        </g>`;
      }).join('')}
    </svg>
    <div class="tooltip" id="trend-tip" hidden></div>`;
}

function bindTrend() {
  const box = $('#trend');
  if (!box) return;
  const data = trendData;
  const tip = $('#trend-tip', box);
  const svg = $('svg', box);
  const show = rect => {
    const d = data[+rect.dataset.i];
    tip.innerHTML = `<b>${esc(monthLabel(d.m))}</b>
      <div><span>Príjmy</span><span>${fmt(d.inc)}</span></div>
      <div><span>Výdavky + inv.</span><span>${fmt(d.out)}</span></div>
      <div><span>Bilancia</span><span>${fmtSigned(d.bal)}</span></div>`;
    const br = box.getBoundingClientRect(), rr = rect.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    const x = Math.min(br.width - 85, Math.max(85, rr.left - br.left + rr.width / 2));
    tip.style.left = `${x}px`;
    tip.style.top = `${sr.top - br.top + 8}px`;
    tip.hidden = false;
  };
  for (const r of $$('.hit', box)) {
    r.addEventListener('pointerenter', () => show(r));
    r.addEventListener('pointerleave', () => { tip.hidden = true; });
    r.addEventListener('click', () => { ui.month = r.dataset.month; renderOverview(); });
  }
}

/* ---------- 3) TRANSAKCIE ---------- */
const TX_FILTERS = [
  ['all', 'Všetko'], ['out', 'Výdavky'], ['in', 'Príjmy'], ['pending', 'Čaká'],
  ...CATEGORIES.map(c => [`cat:${c.id}`, `${c.icon} ${c.short}`]),
];

function renderTxFilters() {
  $('#tx-filters').innerHTML = TX_FILTERS.map(([id, label]) =>
    `<button class="chip ${ui.txFilter === id ? 'is-active' : ''}" data-filter="${id}" role="tab" aria-selected="${ui.txFilter === id}">${esc(label)}</button>`).join('');
}

function txRowHTML(t) {
  const c = t.category ? CAT[t.category] : null;
  return `<button class="list-row" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="list-row__icon" style="--c:${c ? c.color : '#ff9f0a'}">${c ? c.icon : '⚡'}</span>
    <span class="list-row__main">
      <span class="list-row__title">${esc(t.merchant)}</span>
      <span class="list-row__sub">${t.status === 'pending' ? '<span class="pill">Čaká</span> ' : ''}${c ? esc(c.short) : 'Nezaradené'}${t.note ? ' · ' + esc(t.note) : ''}</span>
    </span>
    <span class="list-row__end ${t.amount > 0 ? 'pos' : ''}">${fmtSigned(t.amount)}</span>
  </button>`;
}

function filteredTx() {
  const q = ui.txQuery.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const f = ui.txFilter;
  return store.state.transactions
    .filter(t => {
      if (f === 'out' && t.amount >= 0) return false;
      if (f === 'in' && t.amount <= 0) return false;
      if (f === 'pending' && t.status !== 'pending') return false;
      if (f.startsWith('cat:') && t.category !== f.slice(4)) return false;
      if (!q) return true;
      const hay = `${t.merchant} ${t.note} ${t.category ? CAT[t.category].name : ''} ${t.amount.toFixed(2)} ${t.amount.toFixed(2).replace('.', ',')}`
        .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return hay.includes(q);
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

function renderTxList() {
  renderTxFilters();
  const box = $('#tx-list');
  const all = filteredTx();
  if (!all.length) {
    box.innerHTML = `<div class="empty" style="padding-top:40px"><h2>Nič sa nenašlo</h2><p>${store.state.transactions.length ? 'Skús iný filter alebo hľadaný výraz.' : 'Zatiaľ žiadne transakcie. Importuj e-mail alebo PDF výpis.'}</p></div>`;
    return;
  }
  const list = all.slice(0, ui.txLimit);
  const groups = [];
  for (const t of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === t.date) g.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }
  const total = all.reduce((s, t) => s + t.amount, 0);
  box.innerHTML = `
    <div class="muted small" style="margin:10px 6px 0">${plural(all.length, 'transakcia', 'transakcie', 'transakcií')} · spolu <span class="num">${fmtSigned(total)}</span></div>
    ${groups.map(g => `
      <div class="day-head"><span>${esc(fmtDay(g.date, true))}</span><span class="num">${fmtSigned(g.items.reduce((s, t) => s + t.amount, 0))}</span></div>
      <div class="glass list">${g.items.map(txRowHTML).join('')}</div>`).join('')}
    ${all.length > list.length ? `<button class="btn btn--block" style="margin-top:16px" data-action="more">Zobraziť ďalšie (${all.length - list.length})</button>` : ''}`;
}

/* =========================================================================
 *  Bottom sheet
 * ========================================================================= */
let activeSheet = null;

function openSheet({ title, html, onMount }) {
  closeSheet(true);
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet__grab"></div>
      <div class="sheet__head">
        <div class="sheet__title">${esc(title)}</div>
        <button class="btn btn--ghost" data-close>Hotovo</button>
      </div>
      <div class="sheet__body">${html}</div>
    </div>`;
  root.appendChild(wrap);
  const sheet = $('.sheet', wrap);
  const close = () => closeSheet();
  $$('[data-close]', wrap).forEach(b => b.addEventListener('click', close));
  bindSheetDrag(sheet, close);
  activeSheet = { wrap, close };
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('sheet-open')));
  onMount?.(sheet, close);
  return { sheet, close };
}

function closeSheet(instant = false) {
  if (!activeSheet) return;
  const { wrap } = activeSheet;
  activeSheet = null;
  document.body.style.overflow = '';
  if (instant) { wrap.remove(); return; }
  wrap.classList.remove('sheet-open');
  setTimeout(() => wrap.remove(), 420);
}

/** Potiahnutie sheetu nadol ho zavrie (len keď je obsah odscrollovaný hore). */
function bindSheetDrag(sheet, close) {
  let sy = 0, dy = 0, active = false;
  const grab = e => e.target.closest('.sheet__grab, .sheet__head') || sheet.scrollTop <= 0;
  sheet.addEventListener('touchstart', e => {
    if (!grab(e) || e.target.closest('input, textarea, select')) return;
    active = true; sy = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!active) return;
    dy = e.touches[0].clientY - sy;
    if (dy > 0) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!active) return;
    active = false;
    sheet.style.transition = '';
    if (dy > 120) close();
    sheet.style.transform = '';
  });
}

function catGridHTML(selected, action = 'pick-cat') {
  return `<div class="cat-grid">${CATEGORIES.map(c => `
    <button type="button" class="cat-btn ${c.id === selected ? 'is-selected' : ''}" style="--c:${c.color}" data-action="${action}" data-cat="${c.id}">
      <span class="emoji">${c.icon}</span>${esc(c.short)}
    </button>`).join('')}</div>`;
}

/* ---------- Pridať ručne ---------- */
function openAddSheet(prefill = {}) {
  let type = prefill.amount > 0 ? 'in' : 'out';
  let cat = null;
  openSheet({
    title: 'Nová platba',
    html: `
      <form id="add-form" autocomplete="off">
        <div class="segmented" role="tablist">
          <button type="button" data-type="out" class="${type === 'out' ? 'is-active' : ''}">Výdavok</button>
          <button type="button" data-type="in" class="${type === 'in' ? 'is-active' : ''}">Príjem</button>
        </div>
        <label class="field"><input class="input input--amount num" name="amount" inputmode="decimal" placeholder="0,00 €" value="${prefill.amount ? esc(String(Math.abs(prefill.amount)).replace('.', ',')) : ''}" required></label>
        <label class="field"><span class="field__label">Obchodník / popis</span><input class="input" name="merchant" placeholder="napr. Lidl" value="${esc(prefill.merchant || '')}" required></label>
        <div class="row">
          <label class="field"><span class="field__label">Dátum</span><input class="input" type="date" name="date" value="${esc(prefill.date || todayISO())}"></label>
        </div>
        <label class="field"><span class="field__label">Poznámka (nepovinné)</span><input class="input" name="note" value="${esc(prefill.note || '')}"></label>
        <div class="field__label" style="margin-top:6px">Kategória (nepovinné — inak ide do inboxu)</div>
        ${catGridHTML(null)}
        <button class="btn btn--primary btn--block" style="margin-top:16px" type="submit" id="add-submit">Pridať do inboxu</button>
      </form>`,
    onMount(sheet, close) {
      const form = $('#add-form', sheet);
      const submit = $('#add-submit', sheet);
      $$('[data-type]', sheet).forEach(b => b.addEventListener('click', () => {
        type = b.dataset.type;
        $$('[data-type]', sheet).forEach(x => x.classList.toggle('is-active', x === b));
      }));
      $$('[data-action="pick-cat"]', sheet).forEach(b => b.addEventListener('click', () => {
        cat = cat === b.dataset.cat ? null : b.dataset.cat;
        $$('[data-action="pick-cat"]', sheet).forEach(x => x.classList.toggle('is-selected', x.dataset.cat === cat));
        submit.textContent = cat ? `Pridať a zaradiť ${CAT[cat].icon}` : 'Pridať do inboxu';
        if (cat === 'income') { type = 'in'; $$('[data-type]', sheet).forEach(x => x.classList.toggle('is-active', x.dataset.type === 'in')); }
      }));
      form.addEventListener('submit', e => {
        e.preventDefault();
        const fd = new FormData(form);
        const value = parseFloat(String(fd.get('amount')).replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(value) || value === 0) { toast('Zadaj platnú sumu'); return; }
        const amount = type === 'in' ? Math.abs(value) : -Math.abs(value);
        const { items } = store.addTransactions([{
          amount, merchant: String(fd.get('merchant')).trim(), date: fd.get('date') || todayISO(),
          note: String(fd.get('note') || '').trim(), source: prefill.source || 'manual',
        }], { dedupe: false });
        if (cat && items[0]) store.approve(items[0].id, cat);
        close();
        toast(cat ? `${CAT[cat].icon} Pridané a zaradené` : 'Pridané do inboxu');
        if (!cat) setTab('inbox');
      });
      if (!prefill.amount) setTimeout(() => $('[name="amount"]', sheet).focus(), 350);
    },
  });
}

/* ---------- Úprava transakcie ---------- */
function openEditSheet(id) {
  const t = store.get(id);
  if (!t) return;
  openSheet({
    title: 'Upraviť platbu',
    html: `
      <form id="edit-form" autocomplete="off">
        <label class="field"><span class="field__label">Suma (záporná = výdavok)</span><input class="input input--amount num" name="amount" inputmode="decimal" value="${esc(String(t.amount).replace('.', ','))}"></label>
        <label class="field"><span class="field__label">Obchodník</span><input class="input" name="merchant" value="${esc(t.merchant)}"></label>
        <label class="field"><span class="field__label">Dátum</span><input class="input" type="date" name="date" value="${esc(t.date)}"></label>
        <label class="field"><span class="field__label">Poznámka</span><input class="input" name="note" value="${esc(t.note)}"></label>
        <div class="field__label" style="margin-top:6px">Kategória — ťuknutím sa uloží hneď</div>
        ${catGridHTML(t.category, 'set-cat')}
        <button class="btn btn--primary btn--block" style="margin-top:16px" type="submit">Uložiť zmeny</button>
        <button class="btn btn--danger btn--block" style="margin-top:10px" type="button" id="edit-delete">Zmazať platbu</button>
      </form>`,
    onMount(sheet, close) {
      $$('[data-action="set-cat"]', sheet).forEach(b => b.addEventListener('click', () => {
        store.approve(id, b.dataset.cat); // uloží + naučí pravidlo + prekreslí pozadie
        $$('[data-action="set-cat"]', sheet).forEach(x => x.classList.toggle('is-selected', x === b));
        toast(`${CAT[b.dataset.cat].icon} Uložené · pravidlo aktualizované`);
      }));
      $('#edit-form', sheet).addEventListener('submit', e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const amount = parseFloat(String(fd.get('amount')).replace(/\s/g, '').replace(',', '.').replace('−', '-'));
        if (!Number.isFinite(amount) || amount === 0) { toast('Zadaj platnú sumu'); return; }
        store.update(id, { amount, merchant: String(fd.get('merchant')).trim() || t.merchant, date: fd.get('date'), note: String(fd.get('note')).trim() });
        close();
        toast('Uložené');
      });
      $('#edit-delete', sheet).addEventListener('click', () => { close(); deleteTx(id); });
    },
  });
}

function deleteTx(id) {
  const removed = store.remove(id);
  if (removed) toast('Platba zmazaná', { label: 'Späť', fn: () => store.restore(removed) });
}

/* ---------- Nastavenia ---------- */
function openSettings() {
  const n = store.state.transactions.length;
  const rules = store.rules().length;
  const row = (action, icon, title, sub = '', extra = '') =>
    `<button class="list-row" data-action="${action}" ${extra}>
      <span class="list-row__icon" style="--c:#8e8e93">${icon}</span>
      <span class="list-row__main"><span class="list-row__title">${title}</span>${sub ? `<span class="list-row__sub">${sub}</span>` : ''}</span>
      <span class="muted">›</span></button>`;
  openSheet({
    title: 'Nastavenia',
    html: `
      <div class="section-title">Import platieb</div>
      <div class="glass list settings-group">
        ${row('gmail', '📬', 'Automatický import z Gmailu', gmailConnected() ? `Pripojené · ${esc(gmailLastText())}` : 'Platby z mailov banky sa načítajú samé')}
        ${row('import', '📥', 'Vybrať súbory', 'E-mail (.eml), PDF výpis, .txt — aj viac naraz')}
        ${row('paste', '📋', 'Vložiť zo schránky', 'Skopírovaný text bankovej notifikácie')}
        ${row('paste-manual', '✍️', 'Vložiť text ručne')}
      </div>

      <div class="section-title">iPhone</div>
      <div class="glass list settings-group">
        ${row('guide', '⚡', 'Automatizácia cez Skratky', 'Nová platba z mailu jedným ťuknutím')}
        ${row('install', '📲', 'Pridať na plochu', 'Appka bez lišty prehliadača')}
      </div>

      <div class="section-title">Pravidlá</div>
      <div class="glass list settings-group">
        ${row('rules', '🧠', 'Naučené pravidlá', plural(rules, 'pravidlo', 'pravidlá', 'pravidiel'))}
      </div>

      <div class="section-title">Dáta · ${plural(n, 'transakcia', 'transakcie', 'transakcií')}</div>
      <div class="glass list settings-group">
        ${row('export', '💾', 'Exportovať zálohu (JSON)')}
        ${row('restore', '♻️', 'Obnoviť zo zálohy')}
        ${row('demo', '🧪', 'Načítať ukážkové dáta')}
        ${row('wipe', '🗑️', '<span style="color:var(--red)">Vymazať všetky dáta</span>')}
      </div>
      <p class="muted small" style="margin:16px 4px 0;text-align:center">Dáta sú uložené len v tomto zariadení (LocalStorage).<br>Nikam sa neposielajú.<br>Verzia ${APP_VERSION}</p>`,
    onMount(sheet, close) {
      sheet.addEventListener('click', e => {
        const b = e.target.closest('[data-action]');
        if (!b) return;
        const a = b.dataset.action;
        if (a === 'gmail') openGmailSheet();
        else if (a === 'import') { close(); $('#file-input').click(); }
        else if (a === 'paste') { close(); pasteFromClipboard(); }
        else if (a === 'paste-manual') openPasteSheet();
        else if (a === 'guide') openGuide();
        else if (a === 'install') openInstallGuide();
        else if (a === 'rules') openRules();
        else if (a === 'export') exportBackup();
        else if (a === 'restore') { $('#backup-input').click(); }
        else if (a === 'demo') { loadDemo(); close(); }
        else if (a === 'wipe') {
          // Potvrdenie druhým ťuknutím (bez natívneho confirm(), ktorý niektoré prostredia blokujú)
          if (b.dataset.armed) { store.reset(); close(); toast('Všetko vymazané'); return; }
          b.dataset.armed = '1';
          $('.list-row__title', b).innerHTML = '<span style="color:var(--red)">Ťukni znova — vymaže sa všetko</span>';
          setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; $('.list-row__title', b).innerHTML = '<span style="color:var(--red)">Vymazať všetky dáta</span>'; } }, 4000);
        }
      });
    },
  });
}

function openPasteSheet(initial = '') {
  openSheet({
    title: 'Vložiť text',
    html: `
      <p class="muted small" style="margin:0 4px 10px">Vlož text bankovej notifikácie, SMS alebo riadky z výpisu. Suma, obchodník a dátum sa rozpoznajú automaticky.</p>
      <textarea class="input" id="paste-text" placeholder="Platba kartou u obchodníka LIDL vo výške 23,40 EUR…">${esc(initial)}</textarea>
      <button class="btn btn--primary btn--block" style="margin-top:12px" id="paste-go">Rozpoznať platby</button>`,
    onMount(sheet, close) {
      $('#paste-go', sheet).addEventListener('click', () => {
        const text = $('#paste-text', sheet).value;
        if (!text.trim()) return;
        if (importParsed(parseText(text, 'text'))) close();
      });
    },
  });
}

function openRules() {
  const rules = store.rules();
  openSheet({
    title: 'Naučené pravidlá',
    html: rules.length ? `
      <p class="muted small" style="margin:0 4px 10px">Vznikajú automaticky pri každom schválení. Nová platba od rovnakého obchodníka dostane rovnakú kategóriu.</p>
      <div class="glass list" id="rules-list">
        ${rules.map(([k, c]) => `
          <div class="list-row">
            <span class="list-row__icon" style="--c:${CAT[c].color}">${CAT[c].icon}</span>
            <span class="list-row__main"><span class="list-row__title">${esc(k)}</span><span class="list-row__sub">${esc(CAT[c].name)}</span></span>
            <button class="btn btn--sm btn--danger" data-rule="${esc(k)}">Zmazať</button>
          </div>`).join('')}
      </div>` : `<div class="empty" style="padding:20px"><p>Zatiaľ žiadne pravidlá. Schváľ prvú platbu a appka si ju zapamätá.</p></div>`,
    onMount(sheet) {
      sheet.addEventListener('click', e => {
        const b = e.target.closest('[data-rule]');
        if (!b) return;
        store.deleteRule(b.dataset.rule);
        b.closest('.list-row').remove();
      });
    },
  });
}

function appBaseURL() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function openGuide() {
  const base = appBaseURL();
  openSheet({
    title: 'iOS Skratky',
    html: `
      <div class="glass guide">
        <p><b>Cieľ:</b> keď ti príde mail od banky, platba sa sama pripraví a v appke ju schváliš jedným ťuknutím.</p>
        <div class="note"><b>Používaš Gmail?</b> Jednoduchšie je <b>⚙️ → Automatický import z Gmailu</b>. Funguje bez Skratiek a bez ťukania: platby čakajú v appke hneď, ako ju otvoríš.</div>
        <div class="note"><b>Prečo nie <code>financie://</code>?</b> iOS nedovoľuje webovým appkám registrovať vlastnú URL schému. Rovnakú úlohu plní tento https odkaz s parametrami — funguje identicky, a ak appku raz zabalíš do natívneho obalu, parametre ostanú rovnaké.</div>
      </div>

      <div class="section-title">Spôsob A · Cez schránku (odporúčané)</div>
      <div class="glass guide">
        <p class="muted small" style="margin-bottom:10px">Funguje aj s appkou pridanou na plochu (tá má vlastné úložisko oddelené od Safari).</p>
        <ol>
          <li>Otvor <b>Skratky → Automatizácia → +</b> → <b>E-mail</b>.</li>
          <li><b>Odosielateľ:</b> adresa notifikácií tvojej banky. Voliteľne <b>Predmet obsahuje</b>: „platba“ alebo „transakcia“. Zvoľ <b>Spustiť okamžite</b>.</li>
          <li>Pridaj akciu <b>Kopírovať do schránky</b> a ako vstup zvoľ <b>Vstup skratky</b> (ťukni na premennú → <i>Obsah</i>/<i>Telo</i>).</li>
          <li>Pridaj akciu <b>Zobraziť upozornenie</b>: „Nová platba — otvor Financie“.</li>
          <li>V appke ťukni na <b>📋 Vložiť</b> v inboxe → karta je pripravená → <b>Schváliť</b>.</li>
        </ol>
      </div>

      <div class="section-title">Spôsob B · Priamy odkaz</div>
      <div class="glass guide">
        <p class="muted small" style="margin-bottom:10px">Plne automatické, ale iOS otvára odkazy v Safari — používaj potom appku v Safari (záložka), nie z plochy.</p>
        <ol>
          <li>Automatizácia <b>E-mail</b> ako vyššie.</li>
          <li>Akcia <b>Text</b> → vlož <b>Vstup skratky</b> (Telo).</li>
          <li>Akcia <b>Kódovať URL</b> (URL Encode).</li>
          <li>Akcia <b>Otvoriť URL</b> s textom:<code class="code">${esc(base)}?import=1&amp;text=[Kódovaný text]</code></li>
        </ol>
        <p class="small muted" style="margin-top:6px">Alebo, ak si sumu vytiahneš sám (akcia <i>Zhodovať text</i>):</p>
        <code class="code">${esc(base)}?add=1&amp;amount=-12.50&amp;merchant=Lidl&amp;date=${todayISO()}</code>
      </div>

      <div class="section-title">Podporované parametre</div>
      <div class="glass guide small">
        <p><code>add=1</code> + <code>amount</code> (záporná = výdavok), <code>merchant</code>, <code>date</code> (YYYY-MM-DD), <code>note</code>, <code>type=income|expense</code>, <code>category</code> (napr. <code>groceries</code>) → platba ide do inboxu (s kategóriou rovno do štatistík).</p>
        <p style="margin-top:8px"><code>import=1&amp;text=…</code> → text sa rozparsuje ako notifikácia.<br><code>import=clipboard</code> → appka ponúkne vloženie zo schránky.<br><code>tab=overview|tx|inbox</code> → otvorí daný tab.</p>
        <p style="margin-top:8px" class="muted">Kategórie: ${CATEGORIES.map(c => `<code>${c.id}</code>`).join(' ')}</p>
      </div>
      <button class="btn btn--block" style="margin-top:14px" id="copy-base">Kopírovať adresu appky</button>`,
    onMount(sheet) {
      $('#copy-base', sheet).addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(base); toast('Adresa skopírovaná'); }
        catch { toast(base); }
      });
    },
  });
}

function openInstallGuide() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  openSheet({
    title: 'Pridať na plochu',
    html: `<div class="glass guide">${standalone
      ? '<p>✅ Appka už beží ako samostatná aplikácia z plochy.</p>'
      : `<ol>
          <li>Otvor túto stránku v <b>Safari</b>.</li>
          <li>Ťukni na <b>Zdieľať</b> <span aria-hidden="true">(štvorec so šípkou)</span>.</li>
          <li>Zvoľ <b>Pridať na plochu</b> a potvrď.</li>
        </ol>
        <div class="note">Appka potom beží na celú obrazovku, funguje offline a má vlastnú ikonu.</div>`}</div>`,
  });
}

/* =========================================================================
 *  Import
 * ========================================================================= */
function importParsed(items, { goToInbox = true } = {}) {
  if (!items.length) {
    toast('Nenašiel som žiadnu sumu. Skús iný text alebo pridaj ručne.', { label: 'Pridať', fn: () => openAddSheet() });
    return false;
  }
  const { added, skipped } = store.addTransactions(items);
  if (!added) { toast(skipped ? 'Tieto platby už v appke sú' : 'Nič nové na import'); return true; }
  toast(`${plural(added, 'nová platba', 'nové platby', 'nových platieb')} na schválenie${skipped ? ` · ${skipped} duplicitných preskočených` : ''}`);
  if (goToInbox) setTab('inbox');
  return true;
}

async function importFiles(files) {
  const all = [];
  const errors = [];
  for (const f of files) {
    try { all.push(...await parseFile(f)); }
    catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  if (errors.length) toast(errors[0]);
  if (all.length || !errors.length) importParsed(all);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text?.trim()) { toast('Schránka je prázdna'); return; }
    importParsed(parseText(text, 'clipboard'));
  } catch {
    openPasteSheet(); // prehliadač nepovolil čítanie → ručné vloženie (dlhé podržanie → Vložiť)
  }
}

function exportBackup() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financie-zaloha-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadDemo() {
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const approved = [];
  for (let m = 0; m < 4; m++) {
    const o = m * 30;
    approved.push(
      { date: d(o + 9), amount: 2150, merchant: 'Mzda ACME s.r.o.', category: 'income' },
      { date: d(o + 7), amount: -650, merchant: 'Nájomné byt', category: 'housing' },
      { date: d(o + 6), amount: -84.2, merchant: 'ZSE Energia', category: 'housing' },
      { date: d(o + 5), amount: -13.99, merchant: 'Netflix.com', category: 'subs' },
      { date: d(o + 5), amount: -11.99, merchant: 'Spotify', category: 'subs' },
      { date: d(o + 4), amount: -300, merchant: 'Finax ETF', category: 'invest' },
      { date: d(o + 3), amount: -(62 + m * 7.3), merchant: 'Lidl Bratislava', category: 'groceries' },
      { date: d(o + 2), amount: -(48 + m * 4.1), merchant: 'Kaufland', category: 'groceries' },
      { date: d(o + 12), amount: -(55 + m * 3), merchant: 'Slovnaft', category: 'transport' },
      { date: d(o + 14), amount: -(38.5 + m * 6), merchant: 'Bistro Na rohu', category: 'fun' },
      { date: d(o + 16), amount: -(22.9 + m * 2), merchant: 'Wolt', category: 'fun' },
      { date: d(o + 18), amount: -(41.3 + m * 5), merchant: 'Tesco', category: 'groceries' },
    );
  }
  const res = store.addTransactions(approved.map(t => ({ ...t, source: 'demo' })));
  const catOf = Object.fromEntries(approved.map(a => [a.merchant, a.category]));
  store.approveMany(res.items.map(t => [t.id, catOf[t.merchant]]));
  store.addTransactions([
    { date: d(0), amount: -27.45, merchant: 'Lidl Bratislava', source: 'eml' },
    { date: d(0), amount: -4.2, merchant: 'Starbucks Eurovea', source: 'eml' },
    { date: d(1), amount: -60, merchant: 'Shell Senec', source: 'eml' },
    { date: d(1), amount: -9.99, merchant: 'Apple.com/bill', source: 'eml' },
    { date: d(2), amount: -35, merchant: 'PAYPAL *NEZNAMY', source: 'pdf' },
  ]);
  toast('Ukážkové dáta načítané');
  setTab('inbox');
}

/* =========================================================================
 *  Deep linky  (https://…/?add=1&amount=… , ?import=1&text=… , financie://add?…)
 * ========================================================================= */
export function handleLink(href) {
  let url;
  try { url = new URL(href, location.href); } catch { return false; }
  const p = url.searchParams;
  // Podpora pre budúci natívny obal: financie://add?amount=… → action = "add"
  const nativeAction = url.protocol === 'financie:' ? (url.hostname || url.pathname.replace(/^\/+/, '')) : '';
  const action = nativeAction || (p.has('add') ? 'add' : p.has('import') ? 'import' : '');

  if (p.get('tab')) setTab(p.get('tab'));

  if (action === 'add') {
    const raw = String(p.get('amount') || '').replace(/\s/g, '').replace(',', '.').replace('−', '-');
    let amount = parseFloat(raw);
    const merchant = (p.get('merchant') || p.get('m') || '').trim();
    if (!Number.isFinite(amount) || amount === 0) {
      openAddSheet({ merchant, source: 'shortcut' });
      return true;
    }
    const type = (p.get('type') || '').toLowerCase();
    if (type === 'income' || type === 'in') amount = Math.abs(amount);
    else if (type === 'expense' || type === 'out' || !/^[+-]/.test(raw)) amount = raw.startsWith('+') ? Math.abs(amount) : -Math.abs(amount);
    const { items, skipped } = store.addTransactions([{
      amount, merchant: merchant || 'Platba zo Skratky',
      date: /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date') : todayISO(),
      note: p.get('note') || '', source: 'shortcut',
    }]);
    const cat = p.get('category');
    if (items[0] && CAT[cat]) { store.approve(items[0].id, cat); toast(`${CAT[cat].icon} Platba pridaná a zaradená`); }
    else if (items[0]) { ui.focusId = items[0].id; setTab('inbox'); toast('Nová platba čaká na schválenie'); }
    else if (skipped) toast('Táto platba už v appke je');
    return true;
  }

  if (action === 'import') {
    const text = p.get('text') || p.get('body') || '';
    const mode = p.get('import');
    if (text) importParsed(parseText(text, 'shortcut'));
    else if (mode === 'clipboard') {
      setTab('inbox');
      openSheet({
        title: 'Nová platba',
        html: `<p class="muted" style="margin:0 4px 14px">Skratka skopírovala notifikáciu do schránky. Ťukni pre vloženie:</p>
               <button class="btn btn--primary btn--block btn--approve" id="clip-go">📋 Vložiť zo schránky</button>`,
        onMount(sheet, close) { $('#clip-go', sheet).addEventListener('click', () => { close(); pasteFromClipboard(); }); },
      });
    } else openSettings();
    return true;
  }
  return false;
}

function consumeLaunchURL() {
  const handled = handleLink(location.href);
  if (handled || location.search) {
    // vyčisti URL, aby refresh neimportoval znova
    history.replaceState(null, '', location.pathname);
  }
}

/* =========================================================================
 *  Automatický import z Gmailu (cez Google Apps Script v účte používateľa)
 * ========================================================================= */
const GMAIL_THROTTLE_MS = 60_000;
const GMAIL_SCRIPT_URL = 'https://github.com/gregorihnat01-bot/financie/blob/main/apps-script/Code.gs';
let gmailBusy = false;
let gmailLastAttempt = 0;

const gmailConnected = () => Boolean(store.state.settings.gmailUrl && store.state.settings.gmailToken);

function relTime(ms) {
  if (!ms) return 'ešte nikdy';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'práve teraz';
  if (min < 60) return `pred ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `pred ${h} h`;
  return dayFmt.format(new Date(ms));
}
const gmailLastText = () => store.state.settings.gmailError
  ? `⚠️ ${store.state.settings.gmailError}`
  : `kontrola ${relTime(store.state.settings.gmailLastOk)}`;

function gmailStatusLine() {
  if (!gmailConnected()) return '';
  return `<p class="muted small" style="margin-top:14px">📬 Gmail · ${esc(gmailLastText())}</p>`;
}

/**
 * Rozdelí odkaz "https://script.google.com/macros/s/…/exec?token=…" na adresu a kľúč.
 * Kľúč môže chýbať, ak ho už poznáme (napr. z /dev odkazu vloženého predtým).
 */
function parseGmailLink(input) {
  const raw = String(input).trim().match(/https:\/\/script\.google\S+/)?.[0];
  let u;
  try { u = new URL(raw); } catch { throw new Error('Toto nie je platný odkaz zo script.google.com.'); }
  if (!/^script\.google(usercontent)?\.com$/.test(u.hostname)) throw new Error('Odkaz musí byť zo script.google.com.');
  const token = u.searchParams.get('token') || '';
  u.searchParams.delete('token');
  u.hash = '';
  return { url: u.toString(), token, isDev: u.pathname.endsWith('/dev'), isExec: u.pathname.endsWith('/exec') };
}

async function fetchGmail(cfg, after) {
  const sep = cfg.gmailUrl.includes('?') ? '&' : '?';
  const url = `${cfg.gmailUrl}${sep}token=${encodeURIComponent(cfg.gmailToken)}&after=${after}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
    if (!res.ok) throw new Error(`Skript vrátil chybu ${res.status}`);
    let data;
    try { data = await res.json(); }
    catch { throw new Error('Skript nevracia dáta. Je nasadený s prístupom „Ktokoľvek“?'); }
    if (!data.ok) throw new Error(data.error === 'unauthorized' ? 'Nesprávny kľúč. Skopíruj odkaz z protokolu znova.' : data.error || 'Neznáma chyba skriptu');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Gmail skript neodpovedá. Skús to o chvíľu.');
    if (e instanceof TypeError) throw new Error(navigator.onLine ? 'Nepodarilo sa spojiť so skriptom.' : 'Si offline.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Stiahne nové notifikácie, rozparsuje ich tým istým parserom ako import EML a pridá do inboxu. */
async function syncGmail({ manual = false } = {}) {
  const cfg = store.state.settings;
  if (!gmailConnected()) { if (manual) openGmailSheet(); return null; }
  if (gmailBusy) return null;
  if (!manual && Date.now() - gmailLastAttempt < GMAIL_THROTTLE_MS) return null;
  gmailBusy = true;
  gmailLastAttempt = Date.now();
  if (manual) toast('Kontrolujem Gmail…');
  try {
    // 2 dni prekryv kvôli oneskoreným mailom; duplicity stráži zoznam ID správ
    const after = cfg.gmailLastSync ? cfg.gmailLastSync - 2 * 86400 : 0;
    const data = await fetchGmail(cfg, after);
    const seen = new Set(cfg.gmailSeen || []);
    const parsed = [];
    for (const item of data.items || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      parsed.push(...extractTransactions(`${item.subject}\n${item.text}`, {
        source: 'gmail', subject: item.subject, fallbackDate: String(item.date).slice(0, 10),
      }));
    }
    const { added } = parsed.length ? store.addTransactions(parsed) : { added: 0 };
    store.setSettings({ gmailLastSync: data.now, gmailSeen: [...seen].slice(-500), gmailLastOk: Date.now(), gmailError: '' });
    if (added) toast(`📬 ${plural(added, 'nová platba', 'nové platby', 'nových platieb')} z Gmailu`);
    else if (manual) toast('Žiadne nové platby');
    return added;
  } catch (e) {
    store.setSetting('gmailError', e.message);
    if (manual) toast(e.message);
    return null;
  } finally {
    gmailBusy = false;
  }
}

function openGmailSheet() {
  const s = store.state.settings;
  const connected = gmailConnected();
  openSheet({
    title: 'Import z Gmailu',
    html: `
      <div class="glass guide">
        ${connected
          ? `<p><b>✅ Pripojené.</b> Nové platby sa načítajú pri každom otvorení appky.</p>
             <p class="muted small" style="margin-top:6px">${esc(gmailLastText())}</p>`
          : `<p>Malý skript vo <b>tvojom</b> Google účte číta notifikácie banky. Appka si ich pri otvorení stiahne a platby čakajú v inboxe na schválenie.</p>`}
      </div>

      <label class="field" style="margin-top:14px">
        <span class="field__label" id="gmail-label">${s.gmailPendingToken && !connected
          ? '✓ Kľúč mám. Teraz vlož Web app URL (končí na /exec)'
          : 'Odkaz z Apps Scriptu (s ?token=…)'}</span>
        <input class="input" id="gmail-link" type="url" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="https://script.google.com/macros/s/…/exec?token=…"
          value="${connected ? esc(`${s.gmailUrl}${s.gmailUrl.includes('?') ? '&' : '?'}token=${s.gmailToken}`) : ''}">
      </label>
      <button class="btn btn--primary btn--block" id="gmail-save">${connected ? 'Uložiť a skontrolovať' : 'Pripojiť'}</button>
      ${connected ? `
        <div class="row" style="margin-top:10px">
          <button class="btn" id="gmail-now">↻ Skontrolovať teraz</button>
          <button class="btn btn--danger" id="gmail-off">Odpojiť</button>
        </div>` : ''}

      <div class="section-title">Nastavenie (raz, cca 5 minút — najľahšie na počítači)</div>
      <div class="glass guide">
        <ol>
          <li>Otvor <b>script.google.com</b> → <b>Nový projekt</b>.</li>
          <li>Obsah súboru <code>Code.gs</code> nahraď skriptom z GitHubu:
            <code class="code">${esc(GMAIL_SCRIPT_URL)}</code>
            a ulož (⌘S / Ctrl+S).</li>
          <li><b>Nasadiť → Nové nasadenie</b> → ozubené koliesko → <b>Webová aplikácia</b>.<br>
            Spustiť ako: <b>Ja</b> · Kto má prístup: <b>Ktokoľvek</b> → <b>Nasadiť</b>.</li>
          <li>Povoľ prístup ku Gmailu. Google ukáže varovanie „neoverená aplikácia“, lebo skript je tvoj vlastný: <b>Rozšírené → Prejsť na projekt</b>.</li>
          <li>Hore vyber funkciu <b>setup</b> → <b>Spustiť</b>. V <b>Protokole vykonávania</b> sa objaví riadok <i>ODKAZ PRE APPKU</i>. Vlož ho sem vyššie → <b>Pripojiť</b>.</li>
          <li>Ak odkaz končí na <code>/dev</code>, appka si z neho vezme kľúč. Potom v Apps Scripte otvor <b>Deploy → Manage deployments</b>, skopíruj <b>Web app URL</b> (končí na <code>/exec</code>) a vlož ju sem tiež.</li>
        </ol>
        <div class="note"><b>Bezpečnosť:</b> skript Gmail iba číta, a len maily od banky (ČSOB <code>info@servis.csob.sk</code>). Odkaz s kľúčom nikomu neposielaj. Ak unikne, spusti v skripte <code>resetToken</code>.</div>
      </div>`,
    onMount(sheet, close) {
      $('#gmail-save', sheet).addEventListener('click', async () => {
        const input = $('#gmail-link', sheet);
        let link;
        try { link = parseGmailLink(input.value); }
        catch (e) { toast(e.message); return; }
        const token = link.token || store.state.settings.gmailPendingToken || store.state.settings.gmailToken;
        if (link.isDev || !link.isExec) {
          // /dev odkaz funguje len v editore — kľúč si ale zapamätáme
          if (link.token) store.setSetting('gmailPendingToken', link.token);
          input.value = '';
          input.placeholder = 'https://script.google.com/macros/s/…/exec';
          $('#gmail-label', sheet).textContent = token
            ? '✓ Kľúč mám. Teraz vlož Web app URL (končí na /exec)'
            : 'Vlož Web app URL (končí na /exec) aj s ?token=…';
          toast('Tento odkaz končí na /dev. V Apps Scripte: Deploy → Manage deployments → skopíruj Web app URL.');
          return;
        }
        if (!token) { toast('Chýba kľúč. Vlož celý riadok z protokolu (s ?token=…).'); return; }
        const cfg = { gmailUrl: link.url, gmailToken: token, gmailPendingToken: '' };
        const changed = cfg.gmailUrl !== s.gmailUrl || cfg.gmailToken !== s.gmailToken;
        store.setSettings({ ...cfg, ...(changed ? { gmailLastSync: 0, gmailError: '' } : {}) });
        close();
        const added = await syncGmail({ manual: true });
        if (added !== null) setTab('inbox');
      });
      $('#gmail-now', sheet)?.addEventListener('click', () => { close(); syncGmail({ manual: true }); });
      $('#gmail-off', sheet)?.addEventListener('click', () => {
        store.setSettings({ gmailUrl: '', gmailToken: '', gmailLastSync: 0, gmailError: '' });
        close();
        toast('Gmail odpojený');
      });
    },
  });
}

/* =========================================================================
 *  Toast
 * ========================================================================= */
let toastTimer = null;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast__action">${esc(action.label)}</button>` : ''}`;
  if (action) $('.toast__action', el).addEventListener('click', () => { hide(); action.fn(); }, { once: true });
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  const hide = () => el.classList.remove('is-visible');
  toastTimer = setTimeout(hide, action ? 4500 : 2400);
}

/* =========================================================================
 *  Globálne eventy (delegácia — viazané iba raz)
 * ========================================================================= */
function bindEvents() {
  $('.tabbar').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) setTab(t.dataset.tab);
  });
  $('#btn-add').addEventListener('click', () => openAddSheet());
  $('#btn-settings').addEventListener('click', openSettings);

  $('#view-inbox').addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const card = b.closest('.card');
    const id = card?.dataset.id || b.dataset.id;
    switch (b.dataset.action) {
      case 'approve': approveTx(id, b.dataset.cat, card, 1); break;
      case 'snooze': flyOut(card, -1); store.snooze(id); toast('Presunuté na koniec frontu'); break;
      case 'edit': openEditSheet(id); break;
      case 'delete': flyOut(card, -1); deleteTx(id); break;
      case 'focus': ui.focusId = id; renderInbox(); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'bulk': {
        const pairs = store.pending().map(t => [t.id, store.suggest(t)]).filter(([, s]) => s.source === 'rule').map(([id, s]) => [id, s.category]);
        const n = store.approveMany(pairs);
        toast(`✓ Schválených ${n} známych platieb`);
        break;
      }
      case 'paste': pasteFromClipboard(); break;
      case 'gmail-sync': syncGmail({ manual: true }); break;
      case 'import': $('#file-input').click(); break;
      case 'edit-tx': openEditSheet(id); break;
    }
  });

  $('#view-overview').addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'month') { ui.month = shiftMonth(ui.month, +b.dataset.delta); renderOverview(); }
    else if (b.dataset.action === 'goto-inbox') setTab('inbox');
    else if (b.dataset.action === 'filter-cat') { ui.txFilter = `cat:${b.dataset.cat}`; ui.txQuery = ''; $('#tx-search').value = ''; setTab('tx'); }
  });

  // Swipe medzi mesiacmi v prehľade
  let ox = null;
  $('#view-overview').addEventListener('touchstart', e => { ox = e.touches[0].clientX; }, { passive: true });
  $('#view-overview').addEventListener('touchend', e => {
    if (ox == null || e.target.closest('.trend')) return;
    const dx = e.changedTouches[0].clientX - ox; ox = null;
    if (Math.abs(dx) > 80) {
      const next = shiftMonth(ui.month, dx < 0 ? 1 : -1);
      if (next <= todayISO().slice(0, 7)) { ui.month = next; renderOverview(); }
    }
  });

  let searchTimer;
  $('#tx-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.txQuery = e.target.value; ui.txLimit = 150; renderTxList(); }, 120);
  });
  $('#tx-filters').addEventListener('click', e => {
    const c = e.target.closest('[data-filter]');
    if (!c) return;
    ui.txFilter = c.dataset.filter; ui.txLimit = 150;
    renderTxList();
  });
  $('#tx-list').addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'edit-tx') openEditSheet(b.dataset.id);
    if (b.dataset.action === 'more') { ui.txLimit += 300; renderTxList(); }
  });

  $('#file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) { toast('Spracúvam…'); await importFiles(files); }
  });
  $('#backup-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { const n = store.importJSON(await f.text()); closeSheet(); toast(`Obnovené: ${plural(n, 'transakcia', 'transakcie', 'transakcií')}`); }
    catch (err) { toast(`Chyba zálohy: ${err.message}`); }
  });

  // Drag & drop súborov (desktop / iPad)
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
}

/* =========================================================================
 *  Štart
 * ========================================================================= */
store.subscribe((_, reason) => {
  render();
  if (store.error) toast(store.error);
  if (reason === 'sync') toast('Dáta aktualizované');
});

bindEvents();
setTab('inbox');
consumeLaunchURL();

// Automatický import z Gmailu: pri štarte a pri každom návrate do appky
syncGmail();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncGmail(); });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {}));
  // Keď sa nainštaluje nová verzia, raz sa obnovíme, aby hneď bežal nový kód
  let reloaded = false;
  const hadController = Boolean(navigator.serviceWorker.controller); // prvá inštalácia = bez reloadu
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    if (!activeSheet) location.reload();
  });
}

// Ladenie z konzoly: window.financie.store
window.financie = { store, handleLink };

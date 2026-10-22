import { firebaseConfig } from './firebase-config.js';
import { createStore } from './store.js';
import { parseAmount, formatINR, paiseToInput } from './money.js';
import { KIND, MONEY_TYPE, MONEY_TYPES, PAID_FROM, newId, validateTransaction, parseBackup } from './model.js';
import {
  todayISO, periodFor, shiftPeriod, addDays, dashboard, filterTransactions, sortTransactions,
  summarize, rangeForPreset, inRange, paidFromFor, txPaidFrom, myBudgetTotal, daysBetween,
  buildAlerts, planGap, weekGlance, underLimitStreak, usesHomePot,
} from './calc.js';
import { buildBackup, buildCsv, download, backupFilename } from './backup.js';
import { RANGE_PRESETS, SCOPES, analyticsRange, analyze, budgetReview, categoryTrends, savingsHistory, moneySummary, categoryBudgetRows, categoryFrequency, homeBreakdown } from './analytics.js';

// ---------------- State

const state = {
  data: { ready: false, user: null, settings: null, transactions: [] },
  periodOffset: 0,
  chartMode: 'running',
  analytics: { preset: 'period', scope: 'me', timeView: 'time', from: '', to: '' },
  editingId: null,
  saving: false,
  settingsDirty: false,
  history: { preset: 'period', from: '', to: '', q: '', kind: '', category: '', paidBy: '', sort: 'date-desc' },
};
let store;

const view = document.getElementById('view');
const $ = (sel, root = view) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const money = (p, decimals) => `<span class="num">${formatINR(p, { decimals })}</span>`;
const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dateFmtLong = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDate = (iso, long) => (long ? dateFmtLong : dateFmt).format(new Date(iso + 'T00:00:00Z'));
const settings = () => state.data.settings;
const findTx = (id) => state.data.transactions.find((t) => t.id === id);

const prefs = {
  get(key) { try { return localStorage.getItem('et-pref:' + key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem('et-pref:' + key, value); } catch { /* optional */ } },
};

if (prefs.get('chartMode') === 'daily') state.chartMode = 'daily';

function applyTheme(theme) {
  prefs.set('theme', theme);
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ---------------- Toast

let toastTimer;
function toast(message, { action, onAction, error = false, duration = 4000 } = {}) {
  const el = document.getElementById('toast');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 8000 : duration);
}
const showError = (message) => toast(message, { error: true });

// ---------------- Routing

const views = {
  dashboard: { render: renderDashboard },
  analytics: { render: renderAnalytics, refresh: renderAnalyticsBody },
  add: { render: () => renderEntryView(KIND.EXPENSE), refresh: () => refreshRecent(KIND.EXPENSE) },
  history: { render: renderHistory, refresh: renderHistoryResults },
  money: { render: () => renderEntryView(KIND.MONEY_IN), refresh: () => refreshRecent(KIND.MONEY_IN) },
  settings: { render: renderSettings, refresh: () => { if (!state.settingsDirty) renderSettings(); } },
};
const currentTab = () => (location.hash.slice(1).split('?')[0] in views ? location.hash.slice(1).split('?')[0] : 'dashboard');

function navigate(tab, { editId = null } = {}) {
  state.editingId = editId;
  if (location.hash === '#' + tab) render(); else location.hash = tab;
}

function render() {
  const tab = currentTab();
  document.querySelectorAll('.tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  document.querySelectorAll('.tabs a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  if (store?.mode === 'firebase' && state.data.ready && !state.data.user) return renderSignIn();
  if (!state.data.ready || !settings()) { view.innerHTML = '<p class="muted center">Loading…</p>'; return; }
  state.settingsDirty = false;
  view.dataset.view = tab;
  views[tab].render();
}

function onDataChange(data) {
  if (!store) { state.data = data; return; } // first local update arrives before createStore returns
  const wasReady = state.data.ready && state.data.settings;
  state.data = data;
  const tab = currentTab();
  if (wasReady && data.ready && views[tab].refresh && !(store?.mode === 'firebase' && !data.user)) views[tab].refresh();
  else render();
}

// ---------------- Sign in (Firebase mode only)

function renderSignIn() {
  view.innerHTML = `
    <section class="card center stack">
      <h2>Welcome</h2>
      <p class="muted">Sign in with Google to see your expenses on all your devices.</p>
      <button class="btn primary" data-action="sign-in">Sign in with Google</button>
    </section>`;
  $('[data-action="sign-in"]').onclick = () => store.signIn();
}

// ---------------- Dashboard

function renderDashboard() {
  const s = settings();
  const today = todayISO();
  const period = shiftPeriod(periodFor(today, s.periodStartDay), state.periodOffset, s.periodStartDay);
  const d = dashboard(state.data.transactions, s, period, today);
  const isCurrent = state.periodOffset === 0;
  const tone = (v) => (v < 0 ? 'bad' : '');

  const header = `
    <div class="period-nav">
      <button class="btn icon-btn" data-period="-1" aria-label="Previous period">${icon('left')}</button>
      <div class="center">
        <h2>${fmtDate(period.start)} – ${fmtDate(period.end)} ${period.end.slice(0, 4)}</h2>
        <div class="muted small">${isCurrent ? `Day ${d.daysPassed} of ${d.daysInPeriod} · ${d.daysLeft} days left` : `<a href="#dashboard" data-period="0">Back to current period</a>`}</div>
      </div>
      <button class="btn icon-btn" data-period="1" aria-label="Next period">${icon('right')}</button>
    </div>`;

  if (!d.expenseCount && !d.received && !d.saved && !d.givenHome && !d.fromSavings) {
    view.innerHTML = `${header}
      <div class="card empty">
        <p>No entries in this period yet.</p>
        <div class="row" style="justify-content:center">
          <a class="btn primary" href="#add">Add expense</a><a class="btn" href="#money">Add money in</a>
        </div>
      </div>`;
    bindPeriodNav();
    return;
  }

  // Category change vs the same days of the previous period – only when those days have entries.
  const r = analyze(state.data.transactions, s, { preset: 'period', ...period, periods: 1 }, today, 'all');
  const compare = hasEntries(r.prevWindow) ? { changes: new Map(r.categories.map((c) => [c.name, c.change])), label: isCurrent ? 'vs same days last period' : 'vs last period' } : null;

  const gap = isCurrent ? planGap(d, today) : null;
  const chip = gap === null ? ''
    : gap > 0 ? `<span class="chip-status warn">⚠ ${money(gap)} over plan</span>`
      : `<span class="chip-status good">✓ ${money(-gap)} under plan</span>`;
  const endLeft = isCurrent ? (d.daysPassed > 0 ? d.forecastLeft : null) : d.myLeft;
  const spentAll = d.pool ? d.mySpent + d.homeSpent : d.mySpent; // pool: everything comes out of the month's money
  const endStat = endLeft === null ? stat('End of period', '–')
    : stat(isCurrent ? 'End of period (forecast)' : 'Left at end', endLeft < 0 ? `${money(-endLeft)} short` : `${money(endLeft)} left`, endLeft < 0 ? 'bad' : 'good');

  // Laptop: two columns. Phone: one column in this order (CSS 'order' on the wrappers).
  view.innerHTML = `${header}
    <div class="dash-grid reorder"><div class="dash-col">
    ${ord(1, `
    <section class="card hero">
      <div class="row between wrap"><div class="label">${d.pool ? 'Money left' : 'My money left'}</div>${chip}</div>
      <div class="value ${tone(d.myLeft)}">${money(d.myLeft)}</div>
      ${d.myMoney > 0 ? `<div class="hero-bar" role="img" aria-label="${Math.round((spentAll / d.myMoney) * 100)}% of the money spent"><div class="${d.myLeft < 0 ? 'over' : endLeft !== null && endLeft < 0 ? 'warn' : ''}" style="width:${Math.min(100, (spentAll / d.myMoney) * 100)}%"></div></div>` : ''}
      <div class="muted small">Spent ${money(spentAll)} of ${money(d.myMoney)}${d.myMoney > 0 ? ` · ${Math.round((spentAll / d.myMoney) * 100)}%` : ''}</div>
      ${d.pool && d.received > 0 ? `<p class="small money-sum">${money(d.received)} salary − ${money(d.saved)} saved${d.fromSavings ? ` + ${money(d.fromSavings)} from savings` : ''} − ${money(d.mySpent)} my spend − ${money(d.homeSpent)} home spend = <strong class="${d.myLeft < 0 ? 'bad' : ''}">${money(d.myLeft)} left</strong>${d.homeBudget && d.homeSpent > d.homeBudget ? ` <span class="bad">(home over budget by ${money(d.homeSpent - d.homeBudget)} – included)</span>` : ''}</p>` : ''}
      <div class="stats ${d.pool ? '' : 'stats-4'}">
        ${d.pool ? stat('My spend', money(d.mySpent) + (d.myBudget ? ` <span class="muted small">of ${formatINR(d.myBudget)}</span>` : '')) : ''}
        ${d.pool ? stat('Home spend', money(d.homeSpent) + (d.homeBudget ? ` <span class="muted small">of ${formatINR(d.homeBudget)}</span>` : '')) : ''}
        ${stat(isCurrent ? 'Safe to spend / day' : 'Left per day', money(d.safePerDay, true), tone(d.safePerDay))}
        ${isCurrent ? stat('Spent today', money(d.spentToday), d.spentToday > d.safePerDay ? 'warn' : '') : ''}
        ${endStat}
        ${stat('Saved', money(d.netSaved) + (d.fromSavings ? ` <span class="muted small">(${formatINR(d.fromSavings)} taken)</span>` : ''))}
      </div>
      <p class="muted small hero-foot">${d.pool ? 'My spend: average' : 'Average'} ${money(d.avgPerDay)}/day vs ${d.pool ? 'plan' : 'daily limit'} ${money(d.dailyLimit)}${d.avgPerDay > d.dailyLimit && d.dailyLimit > 0 ? ' <span class="warn">⚠</span>' : ''}</p>
    </section>
    `)}
    ${ord(3, alertsCard(buildAlerts(d, s, today)))}
    ${ord(4, '<section class="card chart" id="spend-chart"></section>')}
    ${ord(5, categoriesCard(d, compare))}
    </div><div class="dash-col">
    ${ord(2, isCurrent ? todayWeekCard(d, today) : '')}
    ${ord(6, usesHomePot(s, state.data.transactions, period) ? homeCard(d, period) : '')}
    </div></div>`;

  bindPeriodNav();
  view.querySelectorAll('[data-see]').forEach((b) => b.addEventListener('click', () => {
    state.history = { preset: 'custom', from: period.start, to: period.end, q: '', kind: KIND.EXPENSE, category: b.dataset.see, paidBy: '', sort: 'date-desc' };
    navigate('history');
  }));
  renderSpendChart(d, today);
}

const stat = (label, value, cls = '') => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
const ord = (n, html) => (html ? `<div class="ord" style="order:${n}">${html}</div>` : '');
const hasEntries = (window) => state.data.transactions.some((tx) => inRange(tx.date, window));

// ---- Alerts: the 3 most important, the rest folded

function alertsCard(alerts) {
  if (!alerts.length) return '';
  const item = (a) => `<li class="alert alert-${a.level}"><span class="alert-icon">${icon(a.level)}</span><span>${esc(a.text)}</span></li>`;
  const more = alerts.slice(3);
  return `
    <section class="card">
      <h3>Alerts</h3>
      <ul class="alert-list">${alerts.slice(0, 3).map(item).join('')}</ul>
      ${more.length ? `<details class="more"><summary>Show ${more.length} more</summary><ul class="alert-list">${more.map(item).join('')}</ul></details>` : ''}
    </section>`;
}

// ---- Today & this week

function todayWeekCard(d, today) {
  const w = weekGlance(d, today);
  const streak = underLimitStreak(d.daily, today, d.dailyLimit);
  const kpiCls = (spent, limit) => (limit > 0 && spent > limit ? 'warn' : '');
  const streakText = d.dailyLimit <= 0 ? ''
    : streak > 0 ? `<span class="good">✓</span> ${streak} day${streak === 1 ? '' : 's'} in a row within your daily limit (${money(d.dailyLimit)}).`
      : 'Today is above your daily limit – a new streak starts tomorrow.';
  return `
    <section class="card">
      <h3>Today &amp; this week</h3>
      <div class="kpis two">
        ${kpi('Spent today', money(w.todaySpent), kpiCls(w.todaySpent, d.safePerDay), `safe today ${money(d.safePerDay)}`)}
        ${kpi('This week', money(w.weekSpent), kpiCls(w.weekSpent, w.weekPlan), `plan ${money(w.weekPlan)} · ${w.daysIn} day${w.daysIn === 1 ? '' : 's'}`)}
      </div>
      ${streakText ? `<p class="small kpi-compare">${streakText}</p>` : ''}
    </section>`;
}

// ---- Home money: how much of the ₹ given home is used, and on what

function homeCard(d, period) {
  const h = homeBreakdown(state.data.transactions, settings(), period);
  const max = h.rows[0]?.total ?? 0;
  // Pool mode: home spend against the home categories' budgets; otherwise against money given home.
  const base = d.pool ? d.homeBudget : d.homeMoney;
  const over = d.homeSpent > base && base > 0;
  const used = base > 0 ? Math.min(100, (d.homeSpent / base) * 100) : 0;
  const right = d.pool
    ? (base > 0 ? `${over ? 'Over by' : 'Left'} <strong class="${over ? 'bad' : ''}">${money(Math.abs(base - d.homeSpent))}</strong>` : `Spent <strong>${money(d.homeSpent)}</strong>`)
    : `Left <strong class="${d.homeLeft < 0 ? 'bad' : ''}">${money(d.homeLeft)}</strong>`;
  return `
    <section class="card">
      <div class="row between wrap"><h3>${d.pool ? 'Home spend' : 'Home money'}</h3><span class="small">${right}</span></div>
      ${base > 0 ? `<div class="hero-bar" role="img" aria-label="${Math.round(used)}% used"><div class="${over ? 'over' : ''}" style="width:${used}%"></div></div>` : ''}
      <div class="muted small">${d.pool ? `Spent ${money(d.homeSpent)}${base ? ` of home budget ${money(base)}` : ''}` : `Spent ${money(d.homeSpent)} of ${money(d.homeMoney)} given to home`}</div>
      ${h.rows.map((x) => `
        <div class="hbar">
          <div class="row between"><span>${esc(x.name)}</span><strong>${money(x.total)}</strong></div>
          <div class="track"><div class="fill" style="width:${max ? (x.total / max) * 100 : 0}%"></div></div>
        </div>`).join('')}
      ${h.switched ? `<p class="muted small" style="margin:8px 0 0">Includes ${money(h.switched)} you switched to "Paid from: Home money".</p>` : ''}
    </section>`;
}

// ---- Categories: where the money went, biggest first

const STATUS = {
  ok: (c) => `<span class="good">✓ ${money(c.left)} left</span>`,
  warn: (c) => `<span class="warn">⚠ ${money(c.left)} left</span>`,
  over: (c) => `<span class="bad">⛔ Over by ${money(-c.left)}</span>`,
  'no-budget': () => '<span class="muted">No budget set</span>',
  none: () => '<span class="muted">–</span>',
};

/** "▲ ₹120 more vs …" / "▼ ₹50 less vs …" for a category change; '' when there is nothing to compare. */
const changeNote = (change, label) => {
  if (change === null || change === undefined || change === 0) return '';
  return change > 0 ? ` · <span class="warn">▲ ${money(change)}</span> ${label}` : ` · <span class="good">▼ ${money(-change)}</span> ${label}`;
};

function categoriesCard(d, compare) {
  const total = d.categories.reduce((t, c) => t + c.spent, 0);
  const sorted = [...d.categories].sort((a, b) => b.spent - a.spent);
  const used = sorted.filter((c) => c.spent > 0);
  const unused = sorted.filter((c) => c.spent === 0 && c.budget > 0);
  const row = (c) => categoryRow(c, total, compare ? changeNote(compare.changes.get(c.name) ?? null, compare.label) : '');
  return `
    <section class="card">
      <div class="row between"><h3>Where your money went</h3><span class="muted small">${money(total)} total</span></div>
      ${used.map(row).join('') || '<p class="muted">No spending yet this period.</p>'}
      ${unused.length ? `<details class="more"><summary>Show ${unused.length} unused categor${unused.length === 1 ? 'y' : 'ies'}</summary>${unused.map(row).join('')}</details>` : ''}
    </section>`;
}

function categoryRow(c, total, note = '') {
  const pct = c.ratio === null ? 0 : Math.min(100, c.ratio * 100);
  const share = total > 0 && c.spent > 0 ? ` · ${Math.round((c.spent / total) * 100)}% of spending` : '';
  return `
    <div class="cat">
      <div class="row between wrap">
        <div><strong>${esc(c.name)}</strong> ${c.paidFrom === PAID_FROM.HOME ? '<span class="tag">Home</span>' : ''}${c.removed ? ' <span class="tag">Removed</span>' : ''}</div>
        <div class="small">${STATUS[c.status](c)}</div>
      </div>
      ${c.budget ? `<div class="track" role="img" aria-label="${Math.round(c.ratio * 100)}% of budget used"><div class="fill ${c.status}" style="width:${pct}%"></div></div>` : ''}
      <div class="row between small">
        <span class="muted">${money(c.spent)}${c.budget ? ` of ${money(c.budget)}` : ''}${share}${note}</span>
        ${c.spent ? `<button type="button" class="link-btn" data-see="${esc(c.name)}">Entries ›</button>` : ''}
      </div>
    </div>`;
}

// ---- Charts (inline SVG; tap or hover a day/month for details)

const CHART = { W: 360, H: 170, top: 10, bottom: 22, left: 4, right: 4 };

/** Draw at the card's real width so labels keep the same size on phone and laptop. */
const fitChart = (el) => { CHART.W = Math.max(280, Math.round(el.clientWidth - 36)); };

function roundedBar(x, base, w, h, i) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `<path class="bar mark" data-i="${i}" d="M${x},${base} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>`;
}

function axisLabel(anchor, x, text) {
  return `<text class="axis" x="${x}" y="${CHART.H - 6}" text-anchor="${anchor}">${text}</text>`;
}

/** Slots, scale and hit areas shared by all charts. */
function chartGeometry(count, max) {
  const { W, H, top, bottom, left, right } = CHART;
  const slot = (W - left - right) / count;
  const base = H - bottom;
  return {
    slot, base,
    x: (i) => left + i * slot,
    cx: (i) => left + i * slot + slot / 2,
    y: (v) => top + (base - top) * (1 - Math.max(0, v) / max),
    hits: Array.from({ length: count }, (_, i) => `<rect class="hit" data-i="${i}" x="${left + i * slot}" y="0" width="${slot}" height="${base}"/>`).join(''),
  };
}

function dayLabels(days, g) {
  return days.map((x, i) => {
    const first = i === 0;
    const last = i === days.length - 1;
    if (!first && !last && !x.date.endsWith('-01')) return '';
    return axisLabel(first ? 'start' : last ? 'end' : 'middle', first ? g.x(i) : last ? g.x(i) + g.slot : g.cx(i), fmtDate(x.date));
  }).join('');
}

function renderSpendChart(d, today) {
  const el = $('#spend-chart');
  fitChart(el);
  const mode = state.chartMode;
  const days = d.daily;
  const lastIndex = today < d.period.start ? -1 : today > d.period.end ? days.length - 1 : daysBetween(d.period.start, today);
  const plan = (i) => d.dailyLimit * (i + 1);
  let svg;
  let describe;

  if (mode === 'running') {
    const max = Math.max(d.pool ? d.dailyLimit * days.length : d.myMoney, days[days.length - 1].running, d.projected, 1);
    const g = chartGeometry(days.length, max);
    const planLine = d.dailyLimit > 0 ? `<polyline class="plan" points="${days.map((_, i) => `${g.cx(i)},${g.y(plan(i))}`).join(' ')}"/>` : '';
    const actual = days.slice(0, lastIndex + 1);
    const line = actual.length ? `<polyline class="line" points="${actual.map((x, i) => `${g.cx(i)},${g.y(x.running)}`).join(' ')}"/>` : '';
    const dots = actual.map((x, i) => `<circle class="dot mark${i === lastIndex ? ' last' : ''}" data-i="${i}" cx="${g.cx(i)}" cy="${g.y(x.running)}" r="4"/>`).join('');
    // Forecast: straight line from today's total to the projected total on the last day.
    const forecast = lastIndex >= 0 && lastIndex < days.length - 1 && d.daysPassed > 0
      ? `<line class="forecast" x1="${g.cx(lastIndex)}" y1="${g.y(days[lastIndex].running)}" x2="${g.cx(days.length - 1)}" y2="${g.y(d.projected)}"/>` : '';
    svg = `<svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="Spent so far ${formatINR(d.mySpent)} against a plan of ${formatINR(d.myMoney)} for the period">${planLine}${forecast}${line}${dots}${dayLabels(days, g)}${g.hits}</svg>`;
    describe = (i) => {
      const x = days[i];
      if (i > lastIndex) return `${fmtDate(x.date, true)}: plan is to have spent ${money(plan(i))} by this day`;
      const diff = x.running - plan(i);
      return `${fmtDate(x.date, true)}: spent so far ${money(x.running)} · plan ${money(plan(i))} · `
        + (diff > 0 ? `<span class="warn">${money(diff)} over plan</span>` : `<span class="good">${money(-diff)} under plan</span>`);
    };
  } else {
    const max = Math.max(d.dailyLimit, ...days.map((x) => x.spent), 1);
    const g = chartGeometry(days.length, max);
    const barW = Math.max(2, g.slot - 2); // 2px gap between bars
    const bars = days.map((x, i) => roundedBar(g.x(i) + (g.slot - barW) / 2, g.base, barW, g.base - g.y(x.spent), i)).join('');
    const ly = g.y(d.dailyLimit);
    const limit = d.dailyLimit > 0 ? `<line class="limit" x1="${CHART.left}" x2="${CHART.W - CHART.right}" y1="${ly}" y2="${ly}"/>` : '';
    svg = `<svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="Daily spending; daily limit ${formatINR(d.dailyLimit, { decimals: true })}">${limit}${bars}${dayLabels(days, g)}${g.hits}</svg>`;
    describe = (i) => {
      const x = days[i];
      return `${fmtDate(x.date, true)}: spent ${money(x.spent)}${x.spent > x.limit ? ' · <span class="warn">⚠ above daily limit</span>' : ''}`;
    };
  }

  const gap = lastIndex >= 0 ? days[lastIndex].running - plan(lastIndex) : 0;
  const summary = mode !== 'running' ? 'Tap or hover a day for details.'
    : lastIndex < 0 ? 'This period has not started yet.'
      : (gap > 0 ? `You are <span class="warn">${money(gap)} over plan</span> so far.` : `You are <span class="good">${money(-gap)} under plan</span> so far.`)
        + (lastIndex < days.length - 1 && d.daysPassed > 0
          ? ` At this pace you'll end with ${d.forecastLeft < 0 ? `<span class="bad">${money(-d.forecastLeft)} short</span>` : `<span class="good">${money(d.forecastLeft)} left</span>`}.` : '')
        + ' Tap a day for details.';

  el.innerHTML = `
    <div class="row between wrap">
      <h3>${mode === 'running' ? 'Spent vs plan' : 'Daily spending'}</h3>
      <div class="seg" role="group" aria-label="Chart type">
        <button type="button" data-mode="running" aria-pressed="${mode === 'running'}">Running total</button>
        <button type="button" data-mode="daily" aria-pressed="${mode === 'daily'}">Daily</button>
      </div>
    </div>
    <p class="muted small legend">${mode === 'running'
      ? '<span class="key line-key"></span>spent so far <span class="key plan-key"></span>plan <span class="key forecast-key"></span>forecast'
      : '<span class="key bar-key"></span>spent that day <span class="key plan-key"></span>daily limit'}</p>
    <p class="small readout" aria-live="polite"></p>
    ${svg}`;
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.chartMode = b.dataset.mode;
    prefs.set('chartMode', state.chartMode);
    renderSpendChart(d, today);
  }));
  bindHover(el, describe, summary);
}

const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' });

/** Tap/hover a slot to show its description; leaving the chart restores the summary. */
function bindHover(container, describe, summary) {
  const readout = container.querySelector('.readout');
  const clear = () => container.querySelectorAll('.mark.active').forEach((m) => m.classList.remove('active'));
  const show = (i) => {
    clear();
    container.querySelectorAll(`.mark[data-i="${i}"]`).forEach((m) => m.classList.add('active'));
    readout.innerHTML = describe(i);
  };
  const reset = () => { clear(); readout.innerHTML = summary; };
  container.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('pointerenter', () => show(Number(h.dataset.i)));
    h.addEventListener('click', () => show(Number(h.dataset.i)));
  });
  container.querySelector('svg').addEventListener('pointerleave', reset);
  reset();
}

// ---------------- Analytics

function renderAnalytics() {
  const a = state.analytics;
  const opt = (value, label, selected) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
  view.innerHTML = `
    <section class="card">
      <div class="an-controls">
        <div><label for="an-range">Range</label><select id="an-range">${RANGE_PRESETS.map(([v, l]) => opt(v, l, a.preset)).join('')}</select></div>
        <div data-custom ${a.preset === 'custom' ? '' : 'hidden'}><label for="an-from">From</label><input id="an-from" type="date" value="${esc(a.from)}"></div>
        <div data-custom ${a.preset === 'custom' ? '' : 'hidden'}><label for="an-to">To</label><input id="an-to" type="date" value="${esc(a.to)}"></div>
      </div>
    </section>
    <div id="an-body"></div>`;
  view.querySelector('.an-controls').addEventListener('change', () => {
    a.preset = $('#an-range').value;
    a.from = $('#an-from').value;
    a.to = $('#an-to').value;
    view.querySelectorAll('[data-custom]').forEach((el) => { el.hidden = a.preset !== 'custom'; });
    renderAnalyticsBody();
  });
  renderAnalyticsBody();
}

function renderAnalyticsBody() {
  const el = $('#an-body');
  if (!el) return;
  const s = settings();
  const today = todayISO();
  const a = state.analytics;
  const range = analyticsRange(a.preset, today, s.periodStartDay, { from: a.from, to: a.to });
  if (!range) {
    el.innerHTML = '<div class="card empty">Pick a start and an end date (start before end).</div>';
    return;
  }
  const rangeLabel = `${fmtDate(range.start)} ${range.start.slice(0, 4) !== range.end.slice(0, 4) ? range.start.slice(0, 4) : ''} – ${fmtDate(range.end)} ${range.end.slice(0, 4)}`;

  // Nothing at all in this range: say so plainly and point to where the entries are.
  if (!state.data.transactions.some((tx) => inRange(tx.date, range))) {
    const dates = state.data.transactions.map((tx) => tx.date).sort();
    el.innerHTML = `
      <div class="card empty">
        <p><strong>Nothing recorded for ${rangeLabel}.</strong></p>
        ${dates.length ? `<p class="small">Your entries are from ${fmtDate(dates[0], true)} to ${fmtDate(dates.at(-1), true)}. Pick a range that includes those dates.</p>` : '<p class="small">Add your first expense or Money In to see analytics.</p>'}
      </div>`;
    return;
  }

  const m = moneySummary(state.data.transactions, s, range, today);
  const homePot = usesHomePot(s, state.data.transactions, range);
  if (!homePot && a.scope === 'home') a.scope = 'me';
  const r = analyze(state.data.transactions, s, range, today, a.scope);
  const comparable = hasEntries(r.prevWindow); // compare only with days that actually have entries
  const scopeLabel = SCOPES.find(([v]) => v === a.scope)[1];
  const history = savingsHistory(state.data.transactions, s, today);
  const usefulModes = r.paymentModes.filter((p) => p.share >= 0.1).length >= 2;

  el.innerHTML = `
    ${summaryCard(m, rangeLabel, hasEntries(m.prevWindow), homePot)}
    <div class="dash-grid an-grid">
      <div class="dash-col">${categoryTableCard(categoryBudgetRows(r, s, a.scope), a.scope, comparable, homePot)}</div>
      <div class="dash-col"><section class="card chart" id="an-time"></section></div>
    </div>
    <div class="dash-grid an-grid">
      <div class="dash-col">${changesCard(r, comparable, scopeLabel)}</div>
      <div class="dash-col">${habitsCard(categoryFrequency(state.data.transactions, s, range, a.scope), scopeLabel)}</div>
    </div>
    <section class="card chart" id="an-savings"></section>
    ${monthTableCard(history)}
    <details class="more-details">
      <summary>More details <span class="muted small">budget suggestions · trends · calendar${usefulModes ? ' · payments' : ''} · top 5</span></summary>
      <div class="more-body">
        ${budgetReviewCard(budgetReview(state.data.transactions, s, today))}
        ${trendsCard(categoryTrends(state.data.transactions, s, today, a.scope), scopeLabel)}
        <section class="card" id="an-calendar"></section>
        ${usefulModes ? barListCard('Payment methods', r.paymentModes.map((p) => ({ name: p.mode, value: p.spent, sub: `${Math.round(p.share * 100)}%` })), 'No payments in this range.') : ''}
        <section class="card"><h3>Top 5 expenses</h3>${r.top.length ? `<ul class="list card-list flat">${r.top.map(txRow).join('')}</ul>` : '<p class="muted">No expenses in this range.</p>'}</section>
      </div>
    </details>`;

  el.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    a.scope = b.dataset.scope;
    renderAnalyticsBody();
  }));
  el.querySelectorAll('[data-see]').forEach((b) => b.addEventListener('click', () => {
    state.history = { preset: 'custom', from: range.start, to: range.end, q: '', kind: KIND.EXPENSE, category: b.dataset.see, paidBy: '', sort: 'date-desc' };
    navigate('history');
  }));
  bindTxList(el);
  renderTimeChart(r, m, range);
  renderSavingsChart(history);
  renderCalendar(r);
}

const changeText = (change, ratio) => {
  if (change === null) return '<span class="muted">No earlier data</span>';
  if (change === 0) return 'Same as before';
  const pct = ratio === null ? '' : ` (${Math.round(Math.abs(ratio) * 100)}%)`;
  return change > 0
    ? `<span class="warn">▲ ${money(change)} more${pct}</span>`
    : `<span class="good">▼ ${money(-change)} less${pct}</span>`;
};

const kpi = (label, value, cls = '', note = '') =>
  `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${cls}">${value}</div>${note ? `<div class="kpi-note">${note}</div>` : ''}</div>`;

/** One card: Excel-style boxes → where the salary went → key rates. */
function summaryCard(m, rangeLabel, comparable, homePot) {
  const netSaved = m.saved - m.fromSavings;
  const rate = m.salary > 0 ? `${Math.round((netSaved / m.salary) * 100)}%` : '–';
  const compare = m.change === null || !comparable ? ''
    : `<span>My spending ${changeText(m.change, null)} than ${fmtDate(m.prevWindow.start)} – ${fmtDate(m.prevWindow.end)}</span>`;
  return `
    <section class="card">
      <div class="row between wrap"><h3>Money summary</h3><span class="muted small">${rangeLabel}</span></div>
      <div class="kpis">
        ${kpi('Salary', money(m.salary), '', 'Money in')}
        ${kpi('Saved', money(m.saved), '', m.fromSavings ? `${formatINR(m.fromSavings)} taken back` : '')}
        ${!m.pool ? kpi('Given to Home', money(m.givenHome)) : ''}
        ${kpi(m.pool ? 'Money for month' : 'My Money', money(m.myMoney), '', m.pool ? 'salary − saved' : 'to spend')}
        ${kpi(m.pool ? 'My spend' : 'My Spent', money(m.mySpent))}
        ${m.pool && (homePot || m.homeSpent) ? kpi('Home spend', money(m.homeSpent)) : ''}
        ${kpi(m.pool ? 'Money Left' : 'My Money Left', money(m.myLeft), m.myLeft < 0 ? 'bad' : 'good', m.myLeft < 0 ? 'overspent' : '')}
      </div>
      ${salarySplit(m)}
      <div class="kpi-strip">
        <span>Savings rate <strong>${rate}</strong></span>
        <span>Average / day <strong>${money(m.avgPerDay)}</strong></span>
        <span>${m.pool ? 'Money per day' : 'Daily limit'} <strong>${money(m.dailyLimit)}</strong></span>
        ${homePot && !m.pool ? `<span>Home left <strong class="${m.homeLeft < 0 ? 'bad' : ''}">${money(m.homeLeft)}</strong></span>` : ''}
        ${compare}
      </div>
    </section>`;
}

/** Stacked bar of how the salary was split. Colour is backed by a text label on every part. */
function salarySplit(m) {
  if (m.salary <= 0) return '<p class="muted small" style="margin:12px 0 0">Add your salary in Money In to see where it went.</p>';
  const parts = [
    { key: 's1', label: 'Saved', value: m.saved },
    { key: 's2', label: m.pool ? 'Home spend' : 'Given to Home', value: m.pool ? m.homeSpent : m.givenHome },
    { key: 's3', label: 'My spent', value: m.mySpent },
    { key: 'left', label: 'Left', value: Math.max(0, m.myLeft) },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((t, p) => t + p.value, 0);
  const pct = (v) => Math.round((v / total) * 100);
  return `
    <h4 class="sub-title">Where your salary went</h4>
    <div class="split-bar" role="img" aria-label="${parts.map((p) => `${p.label} ${pct(p.value)}%`).join(', ')}">
      ${parts.map((p) => `<div class="seg-${p.key}" style="flex:${p.value}" title="${p.label}: ${formatINR(p.value)}"></div>`).join('')}
    </div>
    <ul class="split-legend">
      ${parts.map((p) => `<li><span class="key seg-${p.key}"></span>${p.label}<strong>${money(p.value)}</strong><span class="muted">${pct(p.value)}%</span></li>`).join('')}
    </ul>
    ${m.fromSavings ? `<p class="muted small" style="margin:8px 0 0">Includes ${formatINR(m.fromSavings)} taken back from savings.</p>` : ''}
    ${m.myLeft < 0 ? `<p class="small bad" style="margin:8px 0 0">⛔ Overspent by ${money(-m.myLeft)} – more than your money for this range.</p>` : ''}`;
}

/** Biggest increases and decreases by category vs the previous range. */
function changesCard(r, comparable, scopeLabel) {
  const title = `<div class="row between wrap"><h3>Biggest changes</h3><span class="muted small">${scopeLabel} · vs previous</span></div>`;
  const rows = comparable ? r.categories.filter((c) => c.change) : [];
  if (!rows.length) return `<section class="card">${title}<p class="muted small">Shows which categories went up or down once the earlier period has entries on the same days.</p></section>`;
  const ups = rows.filter((c) => c.change > 0).sort((a, b) => b.change - a.change).slice(0, 3);
  const downs = rows.filter((c) => c.change < 0).sort((a, b) => a.change - b.change).slice(0, 3);
  const max = Math.max(...[...ups, ...downs].map((c) => Math.abs(c.change)), 1);
  const line = (c) => `
    <div class="hbar">
      <div class="row between"><span>${esc(c.name)}</span>${c.change > 0 ? `<span class="warn">▲ ${money(c.change)} more</span>` : `<span class="good">▼ ${money(-c.change)} less</span>`}</div>
      <div class="track"><div class="fill ${c.change > 0 ? 'warn' : ''}" style="width:${(Math.abs(c.change) / max) * 100}%"></div></div>
    </div>`;
  return `
    <section class="card">${title}
      ${ups.length ? `<h4 class="sub-title">Went up</h4>${ups.map(line).join('')}` : ''}
      ${downs.length ? `<h4 class="sub-title">Went down</h4>${downs.map(line).join('')}` : ''}
    </section>`;
}

/** How often you buy each thing: times · average · total. */
function habitsCard(rows, scopeLabel) {
  const title = `<div class="row between wrap"><h3>Spending habits</h3><span class="muted small">${scopeLabel}</span></div>`;
  if (!rows.length) return `<section class="card">${title}<p class="muted">No spending in this range.</p></section>`;
  const max = Math.max(...rows.map((x) => x.total), 1);
  return `
    <section class="card">${title}
      <div class="table-wrap"><table class="table habits">
        <thead><tr><th>Category</th><th>Times</th><th>Average</th><th>Total</th></tr></thead>
        <tbody>${rows.slice(0, 8).map((x) => `
          <tr><td>${esc(x.name)}<div class="mini-track"><div class="fill" style="width:${(x.total / max) * 100}%"></div></div></td>
            <td class="num">${x.count}</td><td class="num">${formatINR(Math.round(x.avg / 100) * 100)}</td><td class="num">${formatINR(x.total)}</td></tr>`).join('')}
        </tbody></table></div>
      ${rows.length > 8 ? `<p class="muted small" style="margin:8px 0 0">+ ${rows.length - 8} more categories</p>` : ''}
    </section>`;
}

/** Cumulative savings line over the periods, with the total as headline. */
function renderSavingsChart(h) {
  const el = $('#an-savings');
  fitChart(el);
  const title = `<div class="row between wrap"><h3>Savings</h3><span class="small">Total saved <strong>${money(h.allTimeSaved)}</strong></span></div>`;
  if (!h.rows.length) {
    el.innerHTML = `${title}<p class="muted">Add Saved entries in Money In to track your savings.</p>`;
    return;
  }
  let running = 0;
  const points = h.rows.map((x) => ({ ...x, total: (running += x.netSaved) }));
  const g = chartGeometry(points.length, Math.max(...points.map((p) => p.total), 1));
  const line = points.length > 1 ? `<polyline class="line" points="${points.map((p, i) => `${g.cx(i)},${g.y(p.total)}`).join(' ')}"/>` : '';
  const dots = points.map((p, i) => `<circle class="dot mark last" data-i="${i}" cx="${g.cx(i)}" cy="${g.y(p.total)}" r="4"/>`).join('');
  const labels = points.map((p, i) => axisLabel('middle', g.cx(i), monthFmt.format(new Date(p.period.start + 'T00:00:00Z')))).join('');
  const rate = (p) => (p.received > 0 ? `${Math.round((p.netSaved / p.received) * 100)}%` : '–');
  el.innerHTML = `${title}
    <p class="muted small legend"><span class="key line-key"></span>total saved so far</p>
    <p class="small readout" aria-live="polite"></p>
    <svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="Savings grew to ${formatINR(running)}">${line}${dots}${labels}${g.hits}</svg>
    <p class="small kpi-compare">${points.map((p) => `${monthFmt.format(new Date(p.period.start + 'T00:00:00Z'))}: <strong>${money(p.netSaved)}</strong> (${rate(p)} of salary)`).join(' · ')}</p>`;
  bindHover(el, (i) => {
    const p = points[i];
    return `${fmtDate(p.period.start)} – ${fmtDate(p.period.end)}: saved ${money(p.netSaved)} (${rate(p)} of salary) · total ${money(p.total)}`;
  }, 'Tap a month for details.');
}

/** Excel-style category table: spent vs budget, biggest first; unused budgets folded away. */
function categoryTableCard(rows, scope, comparable, homePot) {
  const used = rows.filter((x) => !x.unused).sort((a, b) => b.spent - a.spent);
  const unused = rows.filter((x) => x.unused);
  const total = used.reduce((t, x) => t + x.spent, 0);
  const row = (c) => {
    const bar = c.budget ? Math.min(100, (c.spent / c.budget) * 100) : total ? (c.spent / total) * 100 : 0;
    return `
      <div class="cat">
        <div class="row between wrap">
          <div><strong>${esc(c.name)}</strong> ${scope === 'all' && c.paidFrom === PAID_FROM.HOME ? '<span class="tag">Home</span>' : ''}</div>
          <div class="small">${c.budget ? STATUS[c.status](c) : `<strong>${money(c.spent)}</strong>`}</div>
        </div>
        <div class="track"><div class="fill ${c.budget ? c.status : ''}" style="width:${bar}%"></div></div>
        <div class="row between small">
          <span class="muted">${money(c.spent)}${c.budget ? ` of ${money(c.budget)}` : ''}${total && c.spent ? ` · ${Math.round((c.spent / total) * 100)}% of spending` : ''}${comparable ? changeNote(c.change, 'vs before') : ''}</span>
          ${c.spent ? `<button type="button" class="link-btn" data-see="${esc(c.name)}">Entries ›</button>` : ''}
        </div>
      </div>`;
  };
  return `
    <section class="card">
      <div class="row between wrap">
        <h3>Spending by category</h3>
        ${homePot ? `<div class="seg" role="group" aria-label="Which money">
          ${SCOPES.map(([v, l]) => `<button type="button" data-scope="${v}" aria-pressed="${v === scope}">${l.replace(' money', '')}</button>`).join('')}
        </div>` : ''}
      </div>
      ${used.map(row).join('') || '<p class="muted">No spending in this range.</p>'}
      ${unused.length ? `<details class="more"><summary>Show ${unused.length} unused categor${unused.length === 1 ? 'y' : 'ies'}</summary>${unused.map(row).join('')}</details>` : ''}
    </section>`;
}

/** Period-by-period table, like the summary block of each Excel tab (always all recent periods). */
function monthTableCard(h) {
  if (!h.rows.length) return '';
  const t = h.rows.reduce((acc, x) => ({
    received: acc.received + x.received, saved: acc.saved + x.saved, home: acc.home + x.home,
    mySpent: acc.mySpent + x.mySpent, myLeft: acc.myLeft + x.myLeft,
  }), { received: 0, saved: 0, home: 0, mySpent: 0, myLeft: 0 });
  const cells = (x) => `<td class="num">${formatINR(x.received)}</td><td class="num">${formatINR(x.saved)}</td><td class="num">${formatINR(x.home)}</td>
    <td class="num">${formatINR(x.mySpent)}</td><td class="num ${x.myLeft < 0 ? 'bad' : ''}">${formatINR(x.myLeft)}</td>`;
  return `
    <section class="card">
      <div class="row between wrap"><h3>Month by month</h3><span class="muted small">All periods</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Period</th><th>Salary</th><th>Saved</th><th>Home</th><th>Spent</th><th>Left</th></tr></thead>
        <tbody>${h.rows.map((x) => `<tr><td>${fmtDate(x.period.start)}${x.current ? ' <span class="tag">now</span>' : ''}</td>${cells(x)}</tr>`).join('')}</tbody>
        ${h.rows.length > 1 ? `<tfoot><tr><th>Total</th>${cells(t).replace(/<td/g, '<th').replace(/<\/td>/g, '</th>')}</tr></tfoot>` : ''}
      </table></div>
      <p class="muted small" style="margin:8px 0 0">Home = home spending (or money given home in older months). Spent = my spending. Left = what was not spent. Current period: so far.</p>
    </section>`;
}

/** "Spending over time" card: daily bars (short ranges) or one bar per period; or average by weekday. */
function renderTimeChart(r, m, range) {
  const el = $('#an-time');
  fitChart(el);
  const a = state.analytics;
  const header = `
    <div class="row between wrap">
      <h3>Spending over time</h3>
      <div class="seg" role="group" aria-label="Chart view">
        <button type="button" data-tv="time" aria-pressed="${a.timeView === 'time'}">Over time</button>
        <button type="button" data-tv="weekday" aria-pressed="${a.timeView === 'weekday'}">By weekday</button>
      </div>
    </div>`;
  const bind = () => el.querySelectorAll('[data-tv]').forEach((b) => b.addEventListener('click', () => {
    a.timeView = b.dataset.tv;
    renderTimeChart(r, m, range);
  }));
  if (!r.total) {
    el.innerHTML = `${header}<p class="muted">No spending in this range.</p>`;
    bind();
    return;
  }
  const scopeNote = SCOPES.find(([v]) => v === a.scope)[1].toLowerCase();
  let svg, describe, summary, legend;

  if (a.timeView === 'weekday') {
    const days = r.weekday;
    const g = chartGeometry(7, Math.max(...days.map((d) => d.avg ?? 0), 1));
    const barW = Math.min(36, g.slot - 10);
    const marks = days.map((d, i) => roundedBar(g.cx(i) - barW / 2, g.base, barW, g.base - g.y(d.avg ?? 0), i) + axisLabel('middle', g.cx(i), d.label)).join('');
    const busiest = days.reduce((b, d) => ((d.avg ?? 0) > (b.avg ?? 0) ? d : b), days[0]);
    svg = `<svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="Average spending per weekday; highest on ${busiest.label}">${marks}${g.hits}</svg>`;
    legend = `<span class="key bar-key"></span>average per day (${scopeNote})`;
    summary = `You spend most on <strong>${busiest.label}</strong> (average ${money(busiest.avg ?? 0)}). Tap a day for details.`;
    describe = (i) => {
      const d = days[i];
      return d.count ? `${d.label}: average ${money(d.avg)} per day (${d.count} day${d.count === 1 ? '' : 's'}, total ${money(d.total)})` : `${d.label}: none in this range yet`;
    };
  } else if (r.calendar && daysBetween(range.start, range.end) < 62) {
    // Whole range on the axis; days still to come show as empty.
    const days = [...r.calendar];
    for (let d = addDays(days.at(-1).date, 1); d <= range.end; d = addDays(d, 1)) days.push({ date: d, spent: 0 });
    const limit = a.scope === 'me' && range.periods === 1 ? m.dailyLimit : 0;
    const g = chartGeometry(days.length, Math.max(limit, ...days.map((d) => d.spent), 1));
    const barW = Math.max(2, g.slot - 2);
    const bars = days.map((d, i) => roundedBar(g.x(i) + (g.slot - barW) / 2, g.base, barW, g.base - g.y(d.spent), i)).join('');
    const ly = g.y(limit);
    const line = limit > 0 ? `<line class="limit" x1="${CHART.left}" x2="${CHART.W - CHART.right}" y1="${ly}" y2="${ly}"/>` : '';
    svg = `<svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="Spending per day">${line}${bars}${dayLabels(days, g)}${g.hits}</svg>`;
    legend = `<span class="key bar-key"></span>spent that day (${scopeNote})${limit ? ' <span class="key plan-key"></span>daily limit' : ''}`;
    const top = days.reduce((b, d) => (d.spent > b.spent ? d : b), days[0]);
    summary = `Biggest day: <strong>${fmtDate(top.date, true)}</strong> (${money(top.spent)}). Tap a day for details.`;
    describe = (i) => `${fmtDate(days[i].date, true)}: spent ${money(days[i].spent)}${limit && days[i].spent > limit ? ' · <span class="warn">⚠ above daily limit</span>' : ''}`;
  } else {
    const s = settings();
    const periods = [];
    for (let p = periodFor(range.start, s.periodStartDay); p.start <= range.end; p = shiftPeriod(p, 1, s.periodStartDay)) periods.push(p);
    const rows = periods.map((p) => ({ period: p, ...moneySummary(state.data.transactions, s, p, todayISO()) }));
    const g = chartGeometry(rows.length, Math.max(...rows.map((x) => Math.max(x.myMoney, x.mySpent)), 1));
    const barW = Math.min(40, g.slot - 8);
    const marks = rows.map((x, i) => {
      const bx = g.cx(i) - barW / 2;
      const tick = x.myMoney > 0 ? `<line class="money-tick" x1="${bx - 3}" x2="${bx + barW + 3}" y1="${g.y(x.myMoney)}" y2="${g.y(x.myMoney)}"/>` : '';
      return roundedBar(bx, g.base, barW, g.base - g.y(x.mySpent), i) + tick + axisLabel('middle', g.cx(i), monthFmt.format(new Date(x.period.start + 'T00:00:00Z')));
    }).join('');
    svg = `<svg viewBox="0 0 ${CHART.W} ${CHART.H}" role="img" aria-label="My spending per period compared with my money">${marks}${g.hits}</svg>`;
    legend = '<span class="key bar-key"></span>my spending <span class="key tick-key"></span>my money';
    summary = 'One bar per period. Tap a bar for details.';
    describe = (i) => {
      const x = rows[i];
      return `${fmtDate(x.period.start)} – ${fmtDate(x.period.end)}: spent ${money(x.mySpent)} of ${money(x.myMoney)}`
        + (x.myLeft >= 0 ? ` · <span class="good">${money(x.myLeft)} left</span>` : ` · <span class="warn">${money(-x.myLeft)} over</span>`);
    };
  }
  el.innerHTML = `${header}<p class="muted small legend">${legend}</p><p class="small readout" aria-live="polite"></p>${svg}`;
  bind();
  bindHover(el, describe, summary);
}

const SUGGESTION = {
  raise: (x) => `<span class="warn">Usually over – consider ${money(x.suggestion.value)}</span>`,
  lower: (x) => `<span class="good">Usually under – could lower to ${money(x.suggestion.value)}</span>`,
  set: (x) => `<span class="warn">No budget – consider ${money(x.suggestion.value)}</span>`,
  ok: () => '<span class="good">✓ Budget looks right</span>',
};

function budgetReviewCard(review) {
  const title = '<h3>Budget review</h3>';
  if (!review.periods.length) {
    return `<section class="card">${title}<p class="muted small">Available after your first full period ends (${fmtDate(review.firstFullEnd, true)}). It will compare each budget with what you really spend and suggest better amounts.</p></section>`;
  }
  const n = review.periods.length;
  const order = { raise: 0, set: 1, lower: 2, ok: 3 };
  const unused = review.rows.filter((x) => x.suggestion.type === 'unused');
  const rows = review.rows.filter((x) => x.suggestion.type !== 'unused')
    .sort((a, b) => order[a.suggestion.type] - order[b.suggestion.type] || b.avg - a.avg)
    .map((x) => `
    <div class="cat">
      <div class="row between wrap"><strong>${esc(x.name)}</strong><span class="small">${SUGGESTION[x.suggestion.type](x)}</span></div>
      <div class="muted small">Average ${money(x.avg)} vs budget ${money(x.budget)}${x.ratio === null ? '' : ` (${Math.round(x.ratio * 100)}%)`}${x.overCount ? ` · over in ${x.overCount} of ${n}` : ''}</div>
    </div>`).join('');
  const unusedLine = unused.length
    ? `<p class="muted small" style="margin:10px 0 0">Not used in these periods: ${unused.map((x) => esc(x.name)).join(', ')}. Keep their budgets if you expect to use them, or set them to ₹0 in Settings.</p>` : '';
  return `<section class="card">${title}<p class="muted small" style="margin:4px 0 0">Based on your last ${n} full period${n === 1 ? '' : 's'}.</p>${rows}${unusedLine}</section>`;
}

function sparkline(values) {
  const W = 84, H = 26, max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (W - 4) + 2},${H - 2 - (v / max) * (H - 4)}`).join(' ');
  const [lx, ly] = pts.split(' ').at(-1).split(',');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}"/><circle cx="${lx}" cy="${ly}" r="3"/></svg>`;
}

function trendsCard(t, scopeLabel) {
  const title = `<div class="row between"><h3>Category trends</h3><span class="muted small">Last 6 periods · ${scopeLabel}</span></div>`;
  if (t.periods.filter((p) => p.hasData).length < 2) {
    return `<section class="card">${title}<p class="muted small">Needs at least 2 periods of entries. It will show if each category is going up or down.</p></section>`;
  }
  const rows = t.rows.map((x) => {
    let verdict = '';
    if (x.projected !== null && x.avg) {
      const diff = x.projected - x.avg;
      verdict = Math.abs(diff) < x.avg * 0.1 ? 'On usual track'
        : diff > 0 ? `<span class="warn">▲ heading ${money(diff)} above usual</span>` : `<span class="good">▼ heading ${money(-diff)} below usual</span>`;
    }
    return `
      <div class="trend-row">
        <div class="trend-name"><strong>${esc(x.name)}</strong><div class="muted small">Usual ${x.avg === null ? '–' : money(x.avg)} · this period ${money(x.current)}</div>${verdict ? `<div class="small">${verdict}</div>` : ''}</div>
        ${sparkline(x.values)}
      </div>`;
  }).join('');
  return `<section class="card">${title}${rows || '<p class="muted">No spending yet.</p>'}</section>`;
}

function barListCard(title, items, empty) {
  const max = items[0]?.value ?? 0;
  const rows = items.map((x) => `
    <div class="hbar">
      <div class="row between"><strong>${esc(x.name)}</strong><span>${money(x.value)} <span class="muted small">${x.sub}</span></span></div>
      <div class="track"><div class="fill" style="width:${max ? (x.value / max) * 100 : 0}%"></div></div>
    </div>`).join('');
  return `<section class="card"><h3>${title}</h3>${rows || `<p class="muted">${empty}</p>`}</section>`;
}

function renderCalendar(r) {
  const el = $('#an-calendar');
  const title = '<h3>Spending calendar</h3>';
  if (!r.calendar) {
    el.innerHTML = `${title}<p class="muted small">Pick a range of up to 3 months to see the calendar.</p>`;
    return;
  }
  const max = Math.max(...r.calendar.map((c) => c.spent), 1);
  const level = (v) => (v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4)));
  const offset = (new Date(r.calendar[0].date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const blanks = '<span class="cal-blank"></span>'.repeat(offset);
  const cells = r.calendar.map((c, i) => `<button type="button" class="cal-day mark lvl-${level(c.spent)}" data-i="${i}" aria-label="${fmtDate(c.date, true)}: ${formatINR(c.spent)}">${Number(c.date.slice(8))}</button>`).join('');
  el.innerHTML = `${title}
    <p class="small readout" aria-live="polite"></p>
    <div class="cal-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span class="cal-head">${d}</span>`).join('')}${blanks}${cells}</div>
    <div class="cal-legend muted small">Less ${[0, 1, 2, 3, 4].map((l) => `<span class="cal-key lvl-${l}"></span>`).join('')} More</div>`;
  const readout = el.querySelector('.readout');
  const summary = 'Darker = more spent. Tap a day for its total.';
  readout.textContent = summary;
  el.querySelectorAll('.cal-day').forEach((b) => {
    const show = () => {
      el.querySelectorAll('.cal-day.active').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const c = r.calendar[Number(b.dataset.i)];
      readout.innerHTML = `${fmtDate(c.date, true)}: spent ${money(c.spent)}`;
    };
    b.addEventListener('click', show);
    b.addEventListener('pointerenter', show);
  });
}

function bindPeriodNav() {
  view.querySelectorAll('[data-period]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    const step = Number(el.dataset.period);
    state.periodOffset = step === 0 ? 0 : state.periodOffset + step;
    renderDashboard();
  }));
}

// ---------------- Add / edit entry (expenses and money in share one form)

let pendingId = newId(); // fixed per form so a double submit can never create two entries

function renderEntryView(kind) {
  const editing = state.editingId ? findTx(state.editingId) : null;
  if (state.editingId && !editing) state.editingId = null;
  const tx = editing?.kind === kind ? editing : null;
  const isExpense = kind === KIND.EXPENSE;
  const s = settings();
  const lastPaidBy = prefs.get('paidBy');
  const paidBy = tx?.paidBy ?? (s.payModes.includes(lastPaidBy) ? lastPaidBy : s.payModes[0]);
  const paidFrom = tx?.kind === KIND.EXPENSE ? txPaidFrom(tx, s) : PAID_FROM.ME;
  const homePot = usesHomePot(s, state.data.transactions); // separate home money in use?
  const usesGivenHome = state.data.transactions.some((t) => t.type === MONEY_TYPE.HOME); // older data only
  const chips = (name, options, selected) => options.map((o) => `
    <label class="chip"><input type="radio" name="${name}" value="${esc(o)}" ${o === selected ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('');

  view.innerHTML = `
    <div class="entry-grid"><div>
    <form class="card stack" id="entry-form" novalidate>
      <h2>${tx ? 'Edit' : 'Add'} ${isExpense ? 'expense' : 'money in'}</h2>
      <div>
        <label for="amount">Amount (₹)</label>
        <input id="amount" name="amount" class="amount-input" inputmode="decimal" autocomplete="off" placeholder="0" value="${tx ? paiseToInput(tx.amountPaise).replace(/\.00$/, '') : ''}">
        <div class="field-error" data-error="amount"></div>
      </div>
      ${isExpense ? `
        <fieldset class="chips" id="category-chips"><legend>Category</legend>${chips('category', s.categories.map((c) => c.name).concat(tx && !s.categories.some((c) => c.name === tx.category) ? [tx.category] : []), tx?.category)}<button type="button" class="chip-add" data-action="new-cat" aria-expanded="false" aria-controls="new-cat">+ New</button></fieldset>
        <div class="field-error" data-error="category"></div>
        <div class="card stack new-cat" id="new-cat" hidden>
          <div><label for="new-cat-name">New category name</label><input id="new-cat-name" maxlength="60" autocomplete="off"></div>
          <div class="grid2">
            <div><label for="new-cat-budget">Monthly budget (₹)</label><input id="new-cat-budget" inputmode="decimal" placeholder="0" autocomplete="off"></div>
            <div><label for="new-cat-paid">Paid from</label><select id="new-cat-paid"><option>${PAID_FROM.ME}</option><option>${PAID_FROM.HOME}</option></select></div>
          </div>
          <div class="field-error" id="new-cat-error" role="alert"></div>
          <div class="row"><button type="button" class="btn block" data-action="new-cat-cancel">Cancel</button><button type="button" class="btn primary block" data-action="new-cat-save">Add category</button></div>
        </div>
        <fieldset class="chips"><legend>Paid by</legend>${chips('paidBy', s.payModes, paidBy)}</fieldset>
        <div class="field-error" data-error="paidBy"></div>
        ${homePot || paidFrom === PAID_FROM.HOME ? `<fieldset class="chips"><legend>Paid from</legend>${chips('paidFrom', [PAID_FROM.ME, PAID_FROM.HOME], paidFrom)}</fieldset>
        <div class="field-error" data-error="paidFrom"></div>` : ''}`
      : `
        <fieldset class="chips"><legend>Type</legend>${chips('type', MONEY_TYPES.filter((t) => t !== MONEY_TYPE.HOME || usesGivenHome || tx?.type === MONEY_TYPE.HOME), tx?.type ?? MONEY_TYPE.IN)}</fieldset>
        <p class="muted small">Money In = salary/cash received · Saved = put aside${usesGivenHome ? ' · Given to Home = money for home expenses' : ''} · Taken from Savings = money moved back from savings to spend.${usesGivenHome ? '' : ' Money you give home: add it as an expense in the Home category.'}</p>
        <div class="field-error" data-error="type"></div>`}
      <div class="grid2">
        <div>
          <label for="date">Date</label>
          <input id="date" name="date" type="date" value="${tx?.date ?? todayISO()}" max="9999-12-31">
          <div class="field-error" data-error="date"></div>
        </div>
        <div>
          <label for="note">${isExpense ? 'Note (optional)' : 'Description (optional)'}</label>
          <input id="note" name="note" maxlength="200" autocomplete="off" value="${esc(tx?.note ?? '')}">
        </div>
      </div>
      <button class="btn primary block" type="submit">${tx ? 'Save changes' : 'Save'}</button>
      ${tx ? `<div class="row"><button class="btn block" type="button" data-action="cancel">Cancel</button><button class="btn danger block" type="button" data-action="delete">Delete</button></div>` : ''}
    </form>
    </div>
    <section>
      <h3>${isExpense ? 'Recent expenses' : 'Money in this period'}</h3>
      <div id="recent"></div>
    </section>
    </div>`;

  const form = $('#entry-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitEntry(form, kind, tx); });
  form.querySelector('[data-action="cancel"]')?.addEventListener('click', () => navigate('history'));
  form.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteEntry(tx));
  if (isExpense) {
    bindNewCategory(form);
    // Picking a category pre-selects its usual pot; the user can still switch it.
    form.addEventListener('change', (e) => {
      if (e.target.name === 'category') selectPaidFrom(form, paidFromFor(e.target.value, settings()));
    });
  }
  refreshRecent(kind);
  if (!tx && matchMedia('(min-width: 720px)').matches) $('#amount').focus();
}

/** "+ New" on the Add page: create a category without leaving the form (amount/note stay as typed). */
function bindNewCategory(form) {
  const panel = $('#new-cat');
  const toggle = form.querySelector('[data-action="new-cat"]');
  const nameInput = $('#new-cat-name');
  const budgetInput = $('#new-cat-budget');
  const errorEl = $('#new-cat-error');
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    errorEl.textContent = '';
    if (open) nameInput.focus();
    else { nameInput.value = ''; budgetInput.value = ''; toggle.focus(); }
  };

  async function save(button) {
    const s = settings();
    const name = nameInput.value.trim();
    const budgetText = budgetInput.value.trim();
    const budget = budgetText === '' || Number(budgetText) === 0 ? { ok: true, paise: 0 } : parseAmount(budgetText);
    let error = '';
    if (!name) error = 'Enter a category name';
    else if (s.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) error = `"${name}" already exists`;
    else if (!budget.ok) error = 'Budget: ' + budget.error;
    if (error) { errorEl.textContent = error; return; }

    button.disabled = true;
    try {
      const category = { name, budgetPaise: budget.paise, paidFrom: $('#new-cat-paid').value };
      await store.saveSettings({ ...s, categories: [...s.categories, category] });
      toggle.insertAdjacentHTML('beforebegin',
        `<label class="chip"><input type="radio" name="category" value="${esc(name)}" checked><span>${esc(name)}</span></label>`);
      form.querySelector('[data-error="category"]').textContent = '';
      selectPaidFrom(form, category.paidFrom);
      setOpen(false);
      toast(`Category "${name}" added`);
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.querySelector('[data-action="new-cat-cancel"]').addEventListener('click', () => setOpen(false));
  const saveButton = panel.querySelector('[data-action="new-cat-save"]');
  saveButton.addEventListener('click', () => save(saveButton));
  // Enter inside the panel adds the category instead of submitting the expense.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveButton.click(); }
    if (e.key === 'Escape') setOpen(false);
  });
}

function selectPaidFrom(form, pot) {
  const radio = [...form.querySelectorAll('input[name="paidFrom"]')].find((r) => r.value === pot);
  if (radio) radio.checked = true;
}

async function submitEntry(form, kind, existing) {
  if (state.saving) return;
  form.querySelectorAll('[data-error]').forEach((el) => { el.textContent = ''; });
  const fd = new FormData(form);
  const amount = parseAmount(fd.get('amount'));
  const draft = {
    id: existing?.id ?? pendingId,
    kind,
    date: fd.get('date'),
    amountPaise: amount.ok ? amount.paise : 0,
    note: fd.get('note'),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ...(kind === KIND.EXPENSE ? { category: fd.get('category') ?? '', paidBy: fd.get('paidBy') ?? '', paidFrom: fd.get('paidFrom') ?? PAID_FROM.ME } : { type: fd.get('type') }),
  };
  const result = validateTransaction(draft);
  if (!amount.ok) result.errors.amount = amount.error;
  if (Object.keys(result.errors).length) {
    for (const [field, msg] of Object.entries(result.errors)) {
      const el = form.querySelector(`[data-error="${field}"]`);
      if (el) el.textContent = msg;
    }
    form.querySelector('.field-error:not(:empty)')?.previousElementSibling?.focus?.();
    return;
  }

  const button = form.querySelector('[type="submit"]');
  state.saving = true;
  button.disabled = true;
  try {
    await store.saveTransactions([result.value]);
    const tx = result.value;
    if (tx.paidBy) prefs.set('paidBy', tx.paidBy);
    const label = tx.kind === KIND.EXPENSE ? tx.category : tx.type;
    toast(`${existing ? 'Updated' : 'Saved'} ${formatINR(tx.amountPaise)} · ${label}`);
    if (existing) { navigate('history'); return; }
    pendingId = newId();
    form.amount.value = '';
    form.note.value = '';
    form.amount.focus();
  } catch (e) {
    showError('Not saved: ' + e.message);
  } finally {
    state.saving = false;
    button.disabled = false;
  }
}

async function deleteEntry(tx) {
  const label = tx.kind === KIND.EXPENSE ? tx.category : tx.type;
  if (!confirm(`Delete ${formatINR(tx.amountPaise)} · ${label} on ${fmtDate(tx.date, true)}?`)) return;
  try {
    await store.deleteTransaction(tx.id);
    navigate(tx.kind === KIND.EXPENSE ? 'history' : 'money');
    toast('Deleted', { action: 'Undo', duration: 7000, onAction: () => store.saveTransactions([tx]).catch((e) => showError(e.message)) });
  } catch (e) {
    showError('Not deleted: ' + e.message);
  }
}

function refreshRecent(kind) {
  const el = $('#recent');
  if (!el) return;
  const s = settings();
  let txs = state.data.transactions.filter((t) => t.kind === kind);
  if (kind === KIND.MONEY_IN) {
    const period = periodFor(todayISO(), s.periodStartDay);
    txs = txs.filter((t) => inRange(t.date, period));
    const sum = summarize(txs);
    const totals = `<div class="card stats" style="margin:8px 0">${stat('Money in', money(sum.received))}${stat('Saved', money(sum.saved))}${stat('Given to home', money(sum.givenHome))}${sum.fromSavings ? stat('Taken from savings', money(sum.fromSavings)) : ''}${stat('My money', money(sum.received - sum.saved - sum.givenHome + sum.fromSavings))}</div>`;
    el.innerHTML = totals + (txList(sortTransactions(txs)) || '<p class="empty">Nothing added this period.</p>');
  } else {
    el.innerHTML = txList(sortTransactions(txs).slice(0, 8)) || '<p class="empty">No expenses yet. Your first one will show here.</p>';
  }
  bindTxList(el);
}

// ---------------- Transaction list (shared)

/** "Tea & Snacks" -> "TS", "Petrol" -> "PE". */
function initials(name) {
  const words = String(name).match(/[A-Za-z0-9]+/g) ?? ['?'];
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

function txRow(tx) {
  const isExpense = tx.kind === KIND.EXPENSE;
  const isIncome = tx.type === MONEY_TYPE.IN; // Saved / Given to Home are allocations, not income
  const s = settings();
  const sub = isExpense
    ? [tx.paidBy, txPaidFrom(tx, s) === PAID_FROM.HOME ? 'Home money' : '', tx.note].filter(Boolean).join(' · ')
    : tx.note;
  return `<li><button type="button" class="tx" data-id="${esc(tx.id)}" aria-label="Edit ${esc(isExpense ? tx.category : tx.type)} ${formatINR(tx.amountPaise)}">
    <span class="avatar ${isIncome ? 'in' : ''}" aria-hidden="true">${esc(initials(isExpense ? tx.category : tx.type))}</span>
    <div class="main"><div class="title">${esc(isExpense ? tx.category : tx.type)}</div><div class="sub">${esc(sub) || '&nbsp;'}</div></div>
    <div class="amt ${isIncome ? 'in' : ''}">${isIncome ? '+' : ''}${money(tx.amountPaise, tx.amountPaise % 100 !== 0)}</div>
  </button></li>`;
}

/** Group by date with a per-day expense total. */
function txList(txs) {
  if (!txs.length) return '';
  const groups = new Map();
  for (const tx of txs) {
    if (!groups.has(tx.date)) groups.set(tx.date, []);
    groups.get(tx.date).push(tx);
  }
  return [...groups].map(([date, items]) => {
    const spent = summarize(items).expenses;
    return `<div class="day-head"><span>${fmtDate(date, true)}</span>${spent ? `<span>${money(spent)}</span>` : ''}</div><ul class="list card-list">${items.map(txRow).join('')}</ul>`;
  }).join('');
}

function bindTxList(root) {
  root.querySelectorAll('.tx').forEach((btn) => btn.addEventListener('click', () => {
    const tx = findTx(btn.dataset.id);
    if (tx) navigate(tx.kind === KIND.EXPENSE ? 'add' : 'money', { editId: tx.id });
  }));
}

// ---------------- History

function renderHistory() {
  const h = state.history;
  const s = settings();
  const opt = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const categoryNames = [...new Set([...s.categories.map((c) => c.name), ...state.data.transactions.map((t) => t.category).filter(Boolean)])];

  view.innerHTML = `
    <section class="card">
      <form class="filters" id="filters" role="search">
        <div class="full"><label for="q">Search</label><input id="q" name="q" type="search" placeholder="Note, category, payment…" value="${esc(h.q)}"></div>
        <div><label for="preset">Dates</label><select id="preset" name="preset">
          ${[['today', 'Today'], ['week', 'This week'], ['period', 'This period'], ['last-period', 'Last period'], ['all', 'All time'], ['custom', 'Custom range']].map(([v, l]) => opt(v, l, h.preset)).join('')}
        </select></div>
        <div ${h.preset === 'custom' ? '' : 'hidden'} data-custom><label for="from">From</label><input id="from" name="from" type="date" value="${esc(h.from)}"></div>
        <div ${h.preset === 'custom' ? '' : 'hidden'} data-custom><label for="to">To</label><input id="to" name="to" type="date" value="${esc(h.to)}"></div>
        <div><label for="kind">Type</label><select id="kind" name="kind">${opt('', 'All', h.kind)}${opt(KIND.EXPENSE, 'Expenses', h.kind)}${opt(KIND.MONEY_IN, 'Money in', h.kind)}</select></div>
        <div><label for="category">Category</label><select id="category" name="category">${opt('', 'All', h.category)}${categoryNames.map((c) => opt(c, c, h.category)).join('')}${MONEY_TYPES.map((t) => opt(t, t, h.category)).join('')}</select></div>
        <div><label for="paidBy">Paid by</label><select id="paidBy" name="paidBy">${opt('', 'All', h.paidBy)}${s.payModes.map((p) => opt(p, p, h.paidBy)).join('')}</select></div>
        <div><label for="sort">Sort</label><select id="sort" name="sort">
          ${opt('date-desc', 'Newest first', h.sort)}${opt('date-asc', 'Oldest first', h.sort)}${opt('amount-desc', 'Highest amount', h.sort)}${opt('amount-asc', 'Lowest amount', h.sort)}
        </select></div>
      </form>
    </section>
    <div id="history-results"></div>`;

  const form = $('#filters');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    const fd = new FormData(form);
    for (const key of Object.keys(h)) h[key] = fd.get(key) ?? '';
    form.querySelectorAll('[data-custom]').forEach((el) => { el.hidden = h.preset !== 'custom'; });
    renderHistoryResults();
  });
  renderHistoryResults();
}

function renderHistoryResults() {
  const el = $('#history-results');
  if (!el) return;
  const h = state.history;
  const range = h.preset === 'custom' ? { start: h.from, end: h.to } : rangeForPreset(h.preset, todayISO(), settings().periodStartDay);
  const filtered = filterTransactions(state.data.transactions, {
    q: h.q, kind: h.kind, category: h.category, paidBy: h.paidBy, from: range?.start, to: range?.end,
  });
  const [key, dir] = h.sort.split('-');
  const sorted = sortTransactions(filtered, key, dir);
  const sum = summarize(filtered);
  const groupByDay = key === 'date';

  el.innerHTML = `
    <div class="card stats" style="margin-top:12px">
      ${stat('Entries', String(sum.count))}
      ${stat('Expenses', money(sum.expenses))}
      ${stat('Money in', money(sum.received))}
    </div>
    <div style="margin-top:8px">
      ${!sorted.length
        ? `<p class="empty">${state.data.transactions.length ? 'No entries match these filters.' : 'No entries yet. <a href="#add">Add your first expense</a>.'}</p>`
        : groupByDay ? txList(sorted) : `<ul class="list card-list" style="margin-top:12px">${sorted.map(txRow).join('')}</ul>`}
    </div>`;
  bindTxList(el);
}

// ---------------- Settings

function renderSettings() {
  const s = settings();
  const user = state.data.user;
  const catRow = (c) => `
    <div class="cat-row" data-cat data-original="${esc(c.name)}">
      <input aria-label="Category name" name="name" value="${esc(c.name)}" maxlength="60">
      <input aria-label="Monthly budget (₹)" name="budget" inputmode="decimal" value="${c.budgetPaise ? paiseToInput(c.budgetPaise).replace(/\.00$/, '') : '0'}">
      <select aria-label="Paid from" name="paidFrom" class="paid-from">
        <option ${c.paidFrom === PAID_FROM.ME ? 'selected' : ''}>${PAID_FROM.ME}</option>
        <option ${c.paidFrom === PAID_FROM.HOME ? 'selected' : ''}>${PAID_FROM.HOME}</option>
      </select>
      <button type="button" class="btn icon-btn danger" data-remove aria-label="Remove ${esc(c.name)}">${icon('close')}</button>
    </div>`;

  view.innerHTML = `
    <section class="card stack">
      <h2>Sync</h2>
      ${store.mode === 'firebase'
        ? `<p>Signed in as <strong>${esc(user?.email ?? '')}</strong>. Your entries sync across your devices.</p>
           <button class="btn" data-action="sign-out">Sign out</button>`
        : `<p class="muted">Data is saved only in this browser. To use it on your phone and laptop, set up free sync (Firebase) – see the setup guide. Use Backup below to move data meanwhile.</p>`}
    </section>

    <section class="card stack">
      <h2>Appearance</h2>
      <div><label for="theme">Theme</label><select id="theme">
        ${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Same as device']].map(([v, l]) => `<option value="${v}" ${v === (prefs.get('theme') ?? 'light') ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    </section>

    <form class="card stack" id="settings-form" novalidate>
      <h2>Budget settings</h2>
      <div class="grid2">
        <div><label for="periodStartDay">Period starts on day</label><input id="periodStartDay" name="periodStartDay" type="number" min="1" max="28" value="${s.periodStartDay}"></div>
        <div><label for="warnPercent">Warn at % of budget</label><input id="warnPercent" name="warnPercent" type="number" min="1" max="100" value="${s.warnPercent}"></div>
      </div>
      <div>
        <div class="label-text">Categories · monthly budget (₹) · paid from</div>
        <div id="cat-rows">${s.categories.map(catRow).join('')}</div>
        <button type="button" class="btn" data-action="add-cat">+ Add category</button>
        <p class="small" id="budget-check" aria-live="polite"></p>
      </div>
      <div><label for="payModes">Payment modes (comma separated)</label><input id="payModes" name="payModes" value="${esc(s.payModes.join(', '))}"></div>
      <div class="field-error" id="settings-error" role="alert"></div>
      <button class="btn primary block" type="submit">Save settings</button>
    </form>

    <section class="card stack">
      <h2>Backup</h2>
      <p class="muted small">Download a backup regularly. CSV opens in Excel. Restoring adds entries from the file and replaces settings; nothing is deleted.</p>
      <div class="row wrap">
        <button class="btn" data-action="export-json">Download backup</button>
        <button class="btn" data-action="export-csv">Export to Excel (CSV)</button>
        <label class="btn" style="margin:0;font-weight:400">Restore backup<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      </div>
    </section>`;

  const form = $('#settings-form');
  form.addEventListener('input', () => { state.settingsDirty = true; updateBudgetCheck(form); });
  updateBudgetCheck(form);
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) { e.target.closest('[data-cat]').remove(); state.settingsDirty = true; }
    if (e.target.closest('[data-action="add-cat"]')) {
      $('#cat-rows').insertAdjacentHTML('beforeend', catRow({ name: '', budgetPaise: 0, paidFrom: PAID_FROM.ME }));
      $('#cat-rows [data-cat]:last-child input').focus();
      state.settingsDirty = true;
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); saveSettingsForm(form); });
  $('[data-action="sign-out"]')?.addEventListener('click', () => store.signOut());
  $('#theme').addEventListener('change', (e) => applyTheme(e.target.value));
  $('[data-action="export-json"]').addEventListener('click', () =>
    download(backupFilename('json'), JSON.stringify(buildBackup(state.data), null, 2), 'application/json'));
  $('[data-action="export-csv"]').addEventListener('click', () =>
    download(backupFilename('csv'), buildCsv(state.data), 'text/csv;charset=utf-8'));
  $('[data-action="import"]').addEventListener('change', (e) => importBackup(e.target));
}

/** Compare "Me" budgets typed in the form with this period's My Money. */
function updateBudgetCheck(form) {
  const s = settings();
  const today = todayISO();
  const { myMoney } = dashboard(state.data.transactions, s, periodFor(today, s.periodStartDay), today);
  const categories = [...form.querySelectorAll('[data-cat]')].map((row) => ({
    paidFrom: row.querySelector('[name="paidFrom"]').value,
    budgetPaise: parseAmount(row.querySelector('[name="budget"]').value).paise ?? 0,
  }));
  const budgets = myBudgetTotal(categories);
  const gap = budgets - myMoney;
  const el = $('#budget-check');
  el.className = 'small ' + (gap > 0 ? 'warn' : 'good');
  el.innerHTML = `My budgets: ${money(budgets)} · My money this period: ${money(myMoney)}`
    + (gap > 0 ? `<br>⚠ ${money(gap)} more than your money – add "Taken from Savings" in Money In, or reduce budgets.` : ' ✓');
}

async function saveSettingsForm(form) {
  const errorEl = $('#settings-error');
  errorEl.textContent = '';
  const errors = [];
  const renames = {};
  const categories = [...form.querySelectorAll('[data-cat]')].map((row) => {
    const name = row.querySelector('[name="name"]').value.trim();
    const budgetText = row.querySelector('[name="budget"]').value.trim();
    const budget = budgetText === '' || Number(budgetText) === 0 ? { ok: true, paise: 0 } : parseAmount(budgetText);
    if (!budget.ok) errors.push(`Budget for "${name || 'new category'}": ${budget.error}`);
    const original = row.dataset.original;
    if (original && name && original !== name) renames[original] = name;
    return { name, budgetPaise: budget.paise ?? 0, paidFrom: row.querySelector('[name="paidFrom"]').value };
  });

  // Never orphan entries: a category in use can be renamed but not removed.
  const kept = new Set(categories.map((c) => c.name).concat(Object.keys(renames)));
  for (const c of settings().categories) {
    if (kept.has(c.name)) continue;
    const used = state.data.transactions.filter((t) => t.category === c.name).length;
    if (used) errors.push(`"${c.name}" is used by ${used} entr${used === 1 ? 'y' : 'ies'}. Rename it instead of removing.`);
  }

  const next = {
    periodStartDay: Number(form.periodStartDay.value),
    warnPercent: Number(form.warnPercent.value),
    payModes: form.payModes.value.split(','),
    categories,
  };
  if (errors.length) { errorEl.textContent = errors.join('\n'); return; }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await store.saveSettings(next, renames);
    state.settingsDirty = false;
    toast('Settings saved');
    renderSettings();
  } catch (e) {
    errorEl.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

async function importBackup(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = parseBackup(JSON.parse(await file.text()));
  } catch {
    parsed = { ok: false, error: 'Could not read this file. Is it a backup (.json)?' };
  }
  if (!parsed.ok) { showError(parsed.error); return; }
  const existing = new Set(state.data.transactions.map((t) => t.id));
  const added = parsed.transactions.filter((t) => !existing.has(t.id)).length;
  if (!confirm(`Restore ${parsed.transactions.length} entries (${added} new, ${parsed.transactions.length - added} already here) and replace settings?`)) return;
  try {
    await store.saveSettings(parsed.settings);
    await store.saveTransactions(parsed.transactions);
    toast(`Restored ${parsed.transactions.length} entries`);
    renderSettings();
  } catch (e) {
    showError('Restore failed: ' + e.message);
  }
}

// ---------------- Start

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!state.data.ready) return;
    if (currentTab() === 'dashboard') renderDashboard();
    if (currentTab() === 'analytics') renderAnalyticsBody(); }, 200);
});

window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#add') && !location.hash.startsWith('#money')) state.editingId = null;
  render();
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-tab]');
  if (link) state.editingId = null;
});

try {
  // ?mode=local keeps data in this browser only (used by the local test tools).
  const localOnly = new URLSearchParams(location.search).get('mode') === 'local';
  store = await createStore({ firebaseConfig: localOnly ? null : firebaseConfig, onChange: onDataChange, onError: showError });
  render();
} catch (e) {
  view.innerHTML = `<div class="card empty"><p>Could not start the app.</p><p class="small">${esc(e.message)}</p><p class="small">Check your internet connection and reload.</p></div>`;
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

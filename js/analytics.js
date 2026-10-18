// Pure calculations for the Analytics tab. Builds on calc.js so numbers match the Dashboard.
import { KIND, PAID_FROM, MONEY_TYPE } from './model.js';
import { periodFor, shiftPeriod, addDays, daysBetween, inRange, paidFromFor, dashboard, budgetStatus, PACE_MIN_DAYS } from './calc.js';

export const RANGE_PRESETS = [
  ['period', 'This period'], ['last-period', 'Last period'], ['3p', 'Last 3 periods'],
  ['6p', 'Last 6 periods'], ['year', 'This year'], ['custom', 'Custom'],
];
export const SCOPES = [['me', 'My money'], ['home', 'Home money'], ['all', 'All']];

const sum = (txs) => txs.reduce((t, tx) => t + tx.amountPaise, 0);
const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekdayIndex = (iso) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0

/** Date range for a preset. Period presets carry `periods` so the previous range shifts by whole periods. */
export function analyticsRange(preset, today, startDay, custom = {}) {
  const current = periodFor(today, startDay);
  const periodsBack = (n) => ({ start: shiftPeriod(current, -(n - 1), startDay).start, end: current.end, periods: n });
  switch (preset) {
    case 'period': return { preset, ...current, periods: 1 };
    case 'last-period': return { preset, ...shiftPeriod(current, -1, startDay), periods: 1 };
    case '3p': return { preset, ...periodsBack(3) };
    case '6p': return { preset, ...periodsBack(6) };
    case 'year': return { preset, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, periods: null };
    case 'custom':
      if (!custom.from || !custom.to || custom.from > custom.to) return null;
      return { preset, start: custom.from, end: custom.to, periods: null };
    default: return null;
  }
}

/** The range of the same length just before `range`. */
export function previousRange(range, startDay) {
  if (range.periods) {
    return { start: shiftPeriod(periodFor(range.start, startDay), -range.periods, startDay).start, end: addDays(range.start, -1) };
  }
  if (range.preset === 'year') {
    const y = Number(range.start.slice(0, 4)) - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  const length = daysBetween(range.start, range.end) + 1;
  return { start: addDays(range.start, -length), end: addDays(range.start, -1) };
}

/** Previous range to compare with; an in-progress range is compared over the same number of days. */
function comparisonWindow(transactions, range, today, startDay) {
  const prev = previousRange(range, startDay);
  const lastDay = minDate(range.end, today);
  const days = lastDay < range.start ? 0 : daysBetween(range.start, lastDay) + 1;
  const inProgress = today >= range.start && today < range.end;
  const prevWindow = inProgress && days > 0 ? { start: prev.start, end: minDate(prev.end, addDays(prev.start, days - 1)) } : prev;
  return { prevWindow, prevHasData: transactions.some((tx) => inRange(tx.date, prev)) };
}

export function inScope(tx, scope, settings) {
  if (tx.kind !== KIND.EXPENSE) return false;
  if (scope === 'all') return true;
  const mine = paidFromFor(tx.category, settings) === PAID_FROM.ME;
  return scope === 'me' ? mine : !mine;
}

/** Everything for the selected range and scope. */
export function analyze(transactions, settings, range, today, scope) {
  const expenses = transactions.filter((tx) => inScope(tx, scope, settings) && inRange(tx.date, range));
  const lastDay = minDate(range.end, today);
  const days = lastDay < range.start ? 0 : daysBetween(range.start, lastDay) + 1;
  const total = sum(expenses);

  // Compare with the previous range; an in-progress range is compared over the same number of days.
  const { prevWindow, prevHasData } = comparisonWindow(transactions, range, today, settings.periodStartDay);
  const prevExpenses = transactions.filter((tx) => inScope(tx, scope, settings) && inRange(tx.date, prevWindow));
  const prevTotal = sum(prevExpenses);

  const spentBy = (txs) => txs.reduce((m, tx) => m.set(tx.category, (m.get(tx.category) ?? 0) + tx.amountPaise), new Map());
  const now = spentBy(expenses);
  const before = spentBy(prevExpenses);
  const categories = [...now].map(([name, spent]) => ({
    name,
    spent,
    share: total ? spent / total : 0,
    paidFrom: paidFromFor(name, settings),
    change: prevHasData ? spent - (before.get(name) ?? 0) : null,
  })).sort((a, b) => b.spent - a.spent);

  // Average per weekday over elapsed days (days without spending count as ₹0).
  const weekday = WEEKDAYS.map((label) => ({ label, total: 0, count: 0 }));
  for (let d = range.start; d <= lastDay; d = addDays(d, 1)) weekday[weekdayIndex(d)].count++;
  for (const tx of expenses) if (tx.date <= lastDay) weekday[weekdayIndex(tx.date)].total += tx.amountPaise;

  // Calendar for ranges up to ~3 months; extends to any future-dated entry so nothing is hidden.
  const calendarEnd = expenses.reduce((m, tx) => maxDate(m, tx.date), lastDay);
  let calendar = null;
  if (calendarEnd >= range.start && daysBetween(range.start, calendarEnd) < 93) {
    const byDate = expenses.reduce((m, tx) => m.set(tx.date, (m.get(tx.date) ?? 0) + tx.amountPaise), new Map());
    calendar = [];
    for (let d = range.start; d <= calendarEnd; d = addDays(d, 1)) calendar.push({ date: d, spent: byDate.get(d) ?? 0 });
  }

  const byMode = expenses.reduce((m, tx) => m.set(tx.paidBy, (m.get(tx.paidBy) ?? 0) + tx.amountPaise), new Map());

  // Periods inside the range that actually have entries (budgets/averages use these, not empty months).
  const periodsWithData = new Set(transactions.filter((tx) => inRange(tx.date, range)).map((tx) => periodFor(tx.date, settings.periodStartDay).start)).size;

  return {
    range,
    days,
    periodsWithData,
    total,
    count: expenses.length,
    dailyAvg: days ? total / days : 0,
    prevWindow,
    prevHasData,
    prevTotal,
    change: prevHasData ? total - prevTotal : null,
    changeRatio: prevHasData && prevTotal > 0 ? (total - prevTotal) / prevTotal : null,
    categories,
    weekday: weekday.map((w) => ({ ...w, avg: w.count ? w.total / w.count : null })),
    calendar,
    paymentModes: [...byMode].map(([mode, spent]) => ({ mode, spent, share: spent / total })).sort((a, b) => b.spent - a.spent),
    top: [...expenses].sort((a, b) => b.amountPaise - a.amountPaise || b.date.localeCompare(a.date)).slice(0, 5),
  };
}

const roundUp50 = (paise) => Math.ceil(paise / 5000) * 5000;
const hasDataIn = (transactions, period) => transactions.some((tx) => inRange(tx.date, period));

/** Budget vs reality over completed periods (the current one is still running, so it is left out). */
export function budgetReview(transactions, settings, today, count = 6) {
  const current = periodFor(today, settings.periodStartDay);
  const periods = [];
  for (let i = count; i >= 1; i--) {
    const p = shiftPeriod(current, -i, settings.periodStartDay);
    if (hasDataIn(transactions, p)) periods.push(p);
  }
  if (!periods.length) return { periods, rows: [], firstFullEnd: current.end };

  const rows = [];
  for (const c of settings.categories) {
    const spent = periods.map((p) => sum(transactions.filter((tx) => tx.kind === KIND.EXPENSE && tx.category === c.name && inRange(tx.date, p))));
    const avg = spent.reduce((a, b) => a + b, 0) / periods.length;
    const budget = c.budgetPaise;
    if (!budget && !avg) continue;
    let suggestion = { type: 'ok' };
    if (!budget) suggestion = { type: 'set', value: roundUp50(avg) };
    else if (!avg) suggestion = { type: 'unused' };
    else if (avg > budget * 1.1) suggestion = { type: 'raise', value: roundUp50(avg) };
    else if (avg < budget * 0.6) suggestion = { type: 'lower', value: roundUp50(avg) };
    rows.push({
      name: c.name, paidFrom: c.paidFrom, budget, avg,
      overCount: budget ? spent.filter((s) => s > budget).length : 0,
      ratio: budget ? avg / budget : null,
      suggestion,
    });
  }
  return { periods, rows: rows.sort((a, b) => b.avg - a.avg), firstFullEnd: null };
}

/** Spending per period for the top categories (oldest period first; last one is the current period). */
export function categoryTrends(transactions, settings, today, scope, count = 6, top = 6) {
  const current = periodFor(today, settings.periodStartDay);
  const periods = [];
  for (let i = count - 1; i >= 0; i--) {
    const p = shiftPeriod(current, -i, settings.periodStartDay);
    periods.push({ ...p, hasData: hasDataIn(transactions, p) });
  }
  const expenses = transactions.filter((tx) => inScope(tx, scope, settings));
  const names = new Map();
  for (const tx of expenses) if (inRange(tx.date, { start: periods[0].start, end: current.end })) names.set(tx.category, (names.get(tx.category) ?? 0) + tx.amountPaise);

  const d = dashboard(transactions, settings, current, today);
  const rows = [...names].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name]) => {
    const values = periods.map((p) => sum(expenses.filter((tx) => tx.category === name && inRange(tx.date, p))));
    const past = values.slice(0, -1).filter((_, i) => periods[i].hasData);
    const avg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null;
    const so = values.at(-1);
    const projected = d.daysPassed >= PACE_MIN_DAYS ? (so * d.daysInPeriod) / d.daysPassed : null;
    return { name, values, avg, current: so, projected };
  });
  return { periods, rows };
}

/** Money in, savings and leftover per period, plus total saved across all time. */
export function savingsHistory(transactions, settings, today, count = 6) {
  const current = periodFor(today, settings.periodStartDay);
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const p = shiftPeriod(current, -i, settings.periodStartDay);
    if (!hasDataIn(transactions, p)) continue;
    const d = dashboard(transactions, settings, p, today);
    rows.push({ period: p, current: i === 0, received: d.received, saved: d.saved, givenHome: d.givenHome, fromSavings: d.fromSavings, netSaved: d.netSaved, myMoney: d.myMoney, mySpent: d.mySpent, myLeft: d.myLeft });
  }
  const moneyIn = transactions.filter((tx) => tx.kind === KIND.MONEY_IN);
  const allTimeSaved = sum(moneyIn.filter((tx) => tx.type === MONEY_TYPE.SAVED)) - sum(moneyIn.filter((tx) => tx.type === MONEY_TYPE.FROM_SAVINGS));
  return { rows, allTimeSaved };
}

/** The Excel-style money boxes for any range: salary → saved → home → my money → spent → left. */
export function moneySummary(transactions, settings, range, today) {
  const txs = transactions.filter((tx) => inRange(tx.date, range));
  const ofType = (type) => sum(txs.filter((tx) => tx.kind === KIND.MONEY_IN && tx.type === type));
  const mySpentIn = (list) => sum(list.filter((tx) => inScope(tx, 'me', settings)));
  const salary = ofType(MONEY_TYPE.IN);
  const saved = ofType(MONEY_TYPE.SAVED);
  const givenHome = ofType(MONEY_TYPE.HOME);
  const fromSavings = ofType(MONEY_TYPE.FROM_SAVINGS);
  const myMoney = salary - saved - givenHome + fromSavings;
  const mySpent = mySpentIn(txs);
  const homeSpent = sum(txs.filter((tx) => inScope(tx, 'home', settings)));

  // Count days from the first period that has entries, so empty earlier months don't dilute averages.
  const firstDate = txs.reduce((min, tx) => minDate(min, tx.date), range.end);
  const start = maxDate(range.start, periodFor(firstDate, settings.periodStartDay).start);
  const lastDay = minDate(range.end, today);
  const daysPassed = lastDay < start ? 0 : daysBetween(start, lastDay) + 1;
  const daysInRange = daysBetween(start, range.end) + 1;

  const { prevWindow, prevHasData } = comparisonWindow(transactions, range, today, settings.periodStartDay);
  const prevSpent = mySpentIn(transactions.filter((tx) => inRange(tx.date, prevWindow)));

  return {
    salary, saved, givenHome, fromSavings, myMoney, mySpent,
    myLeft: myMoney - mySpent,
    homeSpent,
    homeLeft: givenHome - homeSpent,
    avgPerDay: daysPassed ? mySpent / daysPassed : 0,
    dailyLimit: myMoney / daysInRange,
    prevWindow,
    change: prevHasData ? mySpent - prevSpent : null,
  };
}

/**
 * Category rows like the Excel table: spent vs budget for the range, biggest first.
 * Budgets are multiplied by the number of periods that have entries (period presets) and left out for year/custom ranges.
 * Budgeted categories with no spending are included (flag `unused`) so nothing is hidden.
 */
export function categoryBudgetRows(analysis, settings, scope) {
  const periods = analysis.range.periods ? Math.max(1, Math.min(analysis.range.periods, analysis.periodsWithData)) : null;
  const rows = analysis.categories.map((c) => ({ name: c.name, paidFrom: c.paidFrom, spent: c.spent, share: c.share, change: c.change }));
  for (const c of settings.categories) {
    if (c.budgetPaise > 0 && !rows.some((r) => r.name === c.name) && (scope === 'all' || (scope === 'me') === (c.paidFrom === PAID_FROM.ME))) {
      rows.push({ name: c.name, paidFrom: c.paidFrom, spent: 0, share: 0, change: null, unused: true });
    }
  }
  return rows.map((r) => {
    const found = settings.categories.find((c) => c.name === r.name);
    const budget = periods && found ? found.budgetPaise * periods : null;
    return {
      ...r,
      budget,
      left: budget === null ? null : budget - r.spent,
      ratio: budget ? r.spent / budget : null,
      status: budget === null ? 'none' : budgetStatus(r.spent, budget, settings.warnPercent),
    };
  });
}

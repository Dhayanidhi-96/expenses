// Pure calculations. Every total, card and chart on screen comes from here.
import { KIND, PAID_FROM, MONEY_TYPE } from './model.js';
import { formatINR } from './money.js';

const DAY_MS = 86_400_000;

// ---- Dates (ISO 'YYYY-MM-DD' strings, computed in UTC so time zones never shift a day)

const toMs = (iso) => Date.parse(iso + 'T00:00:00Z');
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, n) => fromMs(toMs(iso) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

/** Today's date in the user's local time zone. */
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const ymd = (y, m, d) => fromMs(Date.UTC(y, m, d));

/** Budget period containing `iso`, e.g. start day 16 -> 16 Oct .. 15 Nov. */
export function periodFor(iso, startDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const monthIndex = d >= startDay ? m - 1 : m - 2;
  const start = ymd(y, monthIndex, startDay);
  const end = addDays(ymd(y, monthIndex + 1, startDay), -1);
  return { start, end };
}

export function shiftPeriod(period, n, startDay) {
  const [y, m] = period.start.split('-').map(Number);
  return periodFor(ymd(y, m - 1 + n, startDay), startDay);
}

/** Monday-to-Sunday week containing `iso`. */
export function weekFor(iso) {
  const weekday = (new Date(toMs(iso)).getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(iso, -weekday);
  return { start, end: addDays(start, 6) };
}

export const inRange = (iso, { start, end }) => iso >= start && iso <= end;

// ---- Transactions

export function paidFromFor(category, settings) {
  const found = settings.categories.find((c) => c.name === category);
  return found ? found.paidFrom : PAID_FROM.ME;
}

/** Pot an expense is paid from: the choice saved on the entry, else its category's usual pot (older entries). */
export function txPaidFrom(tx, settings) {
  return tx.paidFrom === PAID_FROM.ME || tx.paidFrom === PAID_FROM.HOME ? tx.paidFrom : paidFromFor(tx.category, settings);
}

const sum = (txs) => txs.reduce((total, tx) => total + tx.amountPaise, 0);

/** Everything the Dashboard shows, for one period. Mirrors the Excel formulas. */
export function dashboard(transactions, settings, period, today) {
  const txs = transactions.filter((tx) => inRange(tx.date, period));
  const expenses = txs.filter((tx) => tx.kind === KIND.EXPENSE);
  const moneyIn = txs.filter((tx) => tx.kind === KIND.MONEY_IN);
  const isMine = (tx) => txPaidFrom(tx, settings) === PAID_FROM.ME;
  const ofType = (type) => sum(moneyIn.filter((tx) => tx.type === type));

  const received = ofType(MONEY_TYPE.IN);
  const saved = ofType(MONEY_TYPE.SAVED);
  const givenHome = ofType(MONEY_TYPE.HOME);
  const fromSavings = ofType(MONEY_TYPE.FROM_SAVINGS);
  const myMoney = received - saved - givenHome + fromSavings;

  const myExpenses = expenses.filter(isMine);
  const mySpent = sum(myExpenses);
  const homeSpent = sum(expenses.filter((tx) => !isMine(tx)));

  const daysInPeriod = daysBetween(period.start, period.end) + 1;
  const lastCounted = today < period.end ? today : period.end;
  const daysPassed = Math.max(0, daysBetween(period.start, lastCounted) + 1);
  const daysLeft = daysInPeriod - daysPassed;

  // Pool mode (no "Given to Home" this period): one pot for the month. Home bills reduce what's left,
  // but only my spending is projected forward and planned against my categories' budgets.
  const pool = givenHome === 0;
  const myBudget = myBudgetTotal(settings.categories);
  // One monthly home limit when set in Settings; otherwise the home categories' budgets added up.
  const homeBudget = settings.homeLimitPaise > 0 ? settings.homeLimitPaise
    : settings.categories.filter((c) => c.paidFrom === PAID_FROM.HOME).reduce((t, c) => t + c.budgetPaise, 0);
  const myLeft = pool ? myMoney - mySpent - homeSpent : myMoney - mySpent;
  const dailyLimit = !pool ? myMoney / daysInPeriod
    : myMoney > 0 ? (myBudget > 0 ? myBudget : myMoney) / daysInPeriod : 0;
  const projected = daysPassed > 0 ? (mySpent * daysInPeriod) / daysPassed : 0;

  const categories = categoryBreakdown(expenses, settings);
  const top = categories.reduce((best, c) => (c.spent > (best?.spent ?? 0) ? c : best), null);

  return {
    period,
    daysInPeriod,
    daysPassed,
    daysLeft,
    received,
    saved,
    givenHome,
    fromSavings,
    netSaved: saved - fromSavings,
    myMoney,
    mySpent,
    myLeft,
    pool,
    myBudget,
    homeBudget,
    dailyLimit,
    safePerDay: daysLeft > 0 ? myLeft / daysLeft : myLeft,
    spentToday: sum(myExpenses.filter((tx) => tx.date === today)),
    avgPerDay: daysPassed > 0 ? mySpent / daysPassed : 0,
    projected,
    // Money left at the end of the period at today's pace (home bills counted as they are, not projected).
    forecastLeft: (pool ? myMoney - homeSpent : myMoney) - projected,
    homeMoney: givenHome,
    homeSpent,
    homeLeft: pool ? null : givenHome - homeSpent,
    topCategory: top ? top.name : null,
    categories,
    daily: dailySeries(myExpenses, period, dailyLimit),
    expenseCount: expenses.length,
  };
}

export function budgetStatus(spent, budget, warnPercent) {
  if (budget === 0) return spent > 0 ? 'no-budget' : 'none';
  if (spent > budget) return 'over';
  if (spent * 100 >= budget * warnPercent) return 'warn';
  return 'ok';
}

/** Per-category budget rows. Categories no longer in Settings still appear so totals reconcile. */
/** With a home spend limit set, home categories have no budget of their own: the one limit covers them all. */
export const inHomeLimit = (category, settings) => settings.homeLimitPaise > 0 && category.paidFrom === PAID_FROM.HOME;
export const categoryBudget = (category, settings) => (inHomeLimit(category, settings) ? 0 : category.budgetPaise);

export function categoryBreakdown(expenses, settings) {
  const spentBy = new Map();
  for (const tx of expenses) spentBy.set(tx.category, (spentBy.get(tx.category) ?? 0) + tx.amountPaise);

  const rows = settings.categories.map((c) => ({ name: c.name, budget: categoryBudget(c, settings), paidFrom: c.paidFrom, inHomeLimit: inHomeLimit(c, settings) }));
  for (const name of spentBy.keys()) {
    if (!rows.some((r) => r.name === name)) rows.push({ name, budget: 0, paidFrom: PAID_FROM.ME, removed: true });
  }
  return rows.map((r) => {
    const spent = spentBy.get(r.name) ?? 0;
    return {
      ...r,
      spent,
      left: r.budget - spent,
      ratio: r.budget > 0 ? spent / r.budget : null,
      status: budgetStatus(spent, r.budget, settings.warnPercent),
    };
  });
}

export function dailySeries(expenses, period, dailyLimit) {
  const byDate = new Map();
  for (const tx of expenses) byDate.set(tx.date, (byDate.get(tx.date) ?? 0) + tx.amountPaise);
  const days = [];
  let running = 0;
  for (let date = period.start; date <= period.end; date = addDays(date, 1)) {
    const spent = byDate.get(date) ?? 0;
    running += spent;
    days.push({ date, spent, running, limit: dailyLimit });
  }
  return days;
}

// ---- History: filter, sort, summarize

export function filterTransactions(transactions, filter) {
  const q = (filter.q ?? '').trim().toLowerCase();
  return transactions.filter((tx) => {
    if (filter.kind && tx.kind !== filter.kind) return false;
    if (filter.category && tx.category !== filter.category && tx.type !== filter.category) return false;
    if (filter.paidBy && tx.paidBy !== filter.paidBy) return false;
    if (filter.from && tx.date < filter.from) return false;
    if (filter.to && tx.date > filter.to) return false;
    if (q) {
      const text = [tx.note, tx.category, tx.type, tx.paidBy].join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
}

const comparators = {
  date: (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt,
  amount: (a, b) => a.amountPaise - b.amountPaise || a.date.localeCompare(b.date),
};

export function sortTransactions(transactions, key = 'date', direction = 'desc') {
  const cmp = comparators[key] ?? comparators.date;
  const sign = direction === 'asc' ? 1 : -1;
  return [...transactions].sort((a, b) => sign * cmp(a, b));
}

export function summarize(transactions) {
  const expenses = transactions.filter((tx) => tx.kind === KIND.EXPENSE);
  const ofType = (type) => sum(transactions.filter((tx) => tx.kind === KIND.MONEY_IN && tx.type === type));
  return {
    count: transactions.length,
    expenses: sum(expenses),
    received: ofType(MONEY_TYPE.IN),
    saved: ofType(MONEY_TYPE.SAVED),
    givenHome: ofType(MONEY_TYPE.HOME),
    fromSavings: ofType(MONEY_TYPE.FROM_SAVINGS),
  };
}

/** Total monthly budget of categories paid from my own money. */
export const myBudgetTotal = (categories) =>
  categories.filter((c) => c.paidFrom === PAID_FROM.ME).reduce((total, c) => total + c.budgetPaise, 0);

/** Date range for History presets. */
export function rangeForPreset(preset, today, startDay) {
  switch (preset) {
    case 'today': return { start: today, end: today };
    case 'week': return weekFor(today);
    case 'period': return periodFor(today, startDay);
    case 'last-period': return shiftPeriod(periodFor(today, startDay), -1, startDay);
    default: return null; // 'all' or 'custom'
  }
}

// ---- Analytics: alerts, patterns and trends (all derived from dashboard())

/** Forecasts are unreliable in the first days of a period, so pace warnings wait until then. */
export const PACE_MIN_DAYS = 5;

const inr = (p) => formatINR(p);
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

/**
 * Plain-language alerts for one period, most serious first.
 * level: 'bad' (problem now) | 'warn' (heading for a problem) | 'info' (reminder) | 'good'.
 */
export function buildAlerts(d, settings, today) {
  const alerts = [];
  const add = (level, text) => alerts.push({ level, text });
  const isCurrent = inRange(today, d.period);
  const paceReady = isCurrent && d.daysPassed >= PACE_MIN_DAYS && d.daysLeft > 0;
  const timeRatio = d.daysPassed / d.daysInPeriod;

  if (d.myMoney <= 0 && d.received === 0) {
    add('info', 'No Money In added for this period yet. Add your salary in Money In to see your limits.');
  } else if (d.myLeft < 0) {
    add('bad', `You have spent ${inr(-d.myLeft)} more than your money this period.`);
  } else if (d.pool && isCurrent && d.daysLeft > 0 && d.daysPassed > 0 && d.forecastLeft < 0) {
    add('warn', paceReady
      ? `At this pace you'll end the period ${inr(-d.forecastLeft)} short. Keep to ${inr(d.safePerDay)}/day to stay within.`
      : `You're spending faster than your money allows. Keep to ${inr(d.safePerDay)}/day to stay within.`);
  } else if (!d.pool && isCurrent && d.daysLeft > 0 && d.projected > d.myMoney) {
    // Over the plan line already (same condition as projected > my money); forecast wording waits for enough days.
    const overPlan = d.mySpent - d.dailyLimit * d.daysPassed;
    add('warn', paceReady
      ? `At this speed you'll spend ${inr(d.projected)} this period – ${inr(d.projected - d.myMoney)} more than your ${inr(d.myMoney)}. Keep to ${inr(d.safePerDay)}/day to stay within.`
      : `You've spent ${inr(d.mySpent)} so far – ${inr(overPlan)} more than planned by today. Keep to ${inr(d.safePerDay)}/day to stay within.`);
  }

  if (isCurrent && d.spentToday > 0 && d.spentToday > d.safePerDay && d.myLeft >= 0) {
    add('warn', `Today you spent ${inr(d.spentToday)} – more than your safe ${inr(d.safePerDay)}/day.`);
  }

  for (const c of d.categories) {
    if (c.status === 'over') add('bad', `${c.name} is over budget by ${inr(-c.left)}.`);
    else if (c.status === 'warn') add('warn', `${c.name}: ${pct(c.ratio)} of budget used (${inr(c.left)} left).`);
    else if (c.status === 'ok' && paceReady && c.ratio >= 0.25 && c.ratio > timeRatio + 0.2) {
      add('warn', `${c.name}: ${pct(c.ratio)} of budget used, but only ${pct(timeRatio)} of the period has gone.`);
    }
  }

  if (d.homeMoney > 0 && d.homeLeft < 0) add('bad', `Home spending is ${inr(-d.homeLeft)} more than the home money.`);
  else if (d.homeMoney > 0 && d.homeLeft < d.homeMoney * 0.1) add('warn', `Only ${inr(d.homeLeft)} of home money left.`);

  const budgets = d.pool ? d.myBudget + d.homeBudget : myBudgetTotal(settings.categories);
  if (isCurrent && d.myMoney > 0 && budgets > d.myMoney) {
    add('info', `Your budgets add up to ${inr(budgets)} but you have ${inr(d.myMoney)}. Add "Taken from Savings" in Money In if you need it.`);
  }

  if (!alerts.some((a) => a.level === 'bad' || a.level === 'warn') && d.myMoney > 0) {
    add('good', isCurrent ? "All good – you're within your budget." : `You stayed within your money: spent ${inr(d.mySpent)} of ${inr(d.myMoney)}.`);
  }
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return alerts.sort((a, b) => order[a.level] - order[b.level]);
}

const isWeekend = (iso) => [0, 6].includes(new Date(toMs(iso)).getUTCDay());

/** Facts about my spending in a period: weekday vs weekend, biggest expense, last period, payment modes. */
export function spendingPatterns(transactions, settings, period, today) {
  const lastDay = today < period.end ? today : period.end;
  const expenses = transactions.filter((tx) => tx.kind === KIND.EXPENSE && inRange(tx.date, period));
  const mine = expenses.filter((tx) => txPaidFrom(tx, settings) === PAID_FROM.ME);

  // Average per elapsed day, so days with no spending count too.
  const days = { weekday: { spent: 0, count: 0 }, weekend: { spent: 0, count: 0 } };
  for (let date = period.start; date <= lastDay; date = addDays(date, 1)) days[isWeekend(date) ? 'weekend' : 'weekday'].count++;
  for (const tx of mine) if (tx.date <= lastDay) days[isWeekend(tx.date) ? 'weekend' : 'weekday'].spent += tx.amountPaise;
  const avg = (g) => (g.count ? g.spent / g.count : null);

  const biggest = expenses.reduce((best, tx) => (!best || tx.amountPaise > best.amountPaise ? tx : best), null);

  // Same number of days into the previous period.
  const daysIn = Math.max(0, daysBetween(period.start, lastDay) + 1);
  const prev = shiftPeriod(period, -1, settings.periodStartDay);
  const prevRange = { start: prev.start, end: addDays(prev.start, daysIn - 1) };
  const prevHasData = transactions.some((tx) => inRange(tx.date, prev));
  const mySpentBy = (range) => sum(transactions.filter((tx) =>
    tx.kind === KIND.EXPENSE && inRange(tx.date, range) && txPaidFrom(tx, settings) === PAID_FROM.ME));

  const byMode = new Map();
  for (const tx of expenses) byMode.set(tx.paidBy, (byMode.get(tx.paidBy) ?? 0) + tx.amountPaise);
  const total = sum(expenses);

  return {
    weekdayAvg: avg(days.weekday),
    weekendAvg: avg(days.weekend),
    biggest,
    vsLastPeriod: prevHasData && daysIn > 0 ? { now: mySpentBy({ start: period.start, end: lastDay }), before: mySpentBy(prevRange), days: daysIn } : null,
    paymentModes: [...byMode].map(([mode, spent]) => ({ mode, spent, share: spent / total })).sort((a, b) => b.spent - a.spent),
  };
}

/** My money vs my spending for the last `count` periods, oldest first. */
export function periodTrend(transactions, settings, today, count = 6) {
  const current = periodFor(today, settings.periodStartDay);
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    const period = shiftPeriod(current, -i, settings.periodStartDay);
    const d = dashboard(transactions, settings, period, today);
    rows.push({ period, myMoney: d.myMoney, mySpent: d.mySpent, hasData: transactions.some((tx) => inRange(tx.date, period)) });
  }
  return rows;
}

// ---- At-a-glance helpers for the Dashboard (built on dashboard() output; no new money rules)

/** Spent minus plan (daily limit × days so far) up to today; null outside the period or without a plan. */
export function planGap(d, today) {
  if (!inRange(today, d.period) || d.dailyLimit <= 0) return null;
  const i = daysBetween(d.period.start, today);
  return d.daily[i].running - d.dailyLimit * (i + 1);
}

/** Today and this week (Monday–Sunday, clipped to the period, up to today) for my money. */
export function weekGlance(d, today) {
  const week = weekFor(today);
  const start = week.start > d.period.start ? week.start : d.period.start;
  const end = today < d.period.end ? today : d.period.end;
  const days = d.daily.filter((x) => x.date >= start && x.date <= end);
  return {
    todaySpent: d.spentToday,
    weekSpent: days.reduce((t, x) => t + x.spent, 0),
    daysIn: days.length,
    weekPlan: d.dailyLimit * days.length,
  };
}

/** Days in a row, ending today, where my spending stayed within the daily limit. */
export function underLimitStreak(daily, today, limit) {
  if (!(limit > 0)) return 0;
  let n = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].date > today) continue;
    if (daily[i].spent > limit) break;
    n++;
  }
  return n;
}

/**
 * Is the separate home-money pot in use? True when a category is paid from Home money, or (within `range`,
 * or anywhere when no range) there is a "Given to Home" entry or an expense switched to Home money.
 * When false the app hides the pot (owner now records home costs as normal expenses).
 */
export function usesHomePot(settings, transactions, range = null) {
  if (settings.categories.some((c) => c.paidFrom === PAID_FROM.HOME)) return true;
  return transactions.some((tx) => (!range || inRange(tx.date, range))
    && ((tx.kind === KIND.MONEY_IN && tx.type === MONEY_TYPE.HOME) || (tx.kind === KIND.EXPENSE && tx.paidFrom === PAID_FROM.HOME)));
}

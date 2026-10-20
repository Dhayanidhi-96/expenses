import { isValidPaise } from './money.js';

export const KIND = { EXPENSE: 'expense', MONEY_IN: 'moneyIn' };
export const PAID_FROM = { ME: 'Me', HOME: 'Home money' };
// 'Taken from Savings' moves money back from savings into My Money; it is a transfer, not income.
export const MONEY_TYPE = { IN: 'Money In', SAVED: 'Saved', HOME: 'Given to Home', FROM_SAVINGS: 'Taken from Savings' };
export const MONEY_TYPES = Object.values(MONEY_TYPE);

export const DEFAULT_SETTINGS = Object.freeze({
  periodStartDay: 16,
  warnPercent: 80,
  payModes: ['UPI', 'Cash', 'Card', 'Other'],
  categories: [
    { name: 'Travel / Bus', budgetPaise: 60000, paidFrom: PAID_FROM.ME },
    { name: 'Petrol', budgetPaise: 40000, paidFrom: PAID_FROM.ME },
    { name: 'Tea & Snacks', budgetPaise: 180000, paidFrom: PAID_FROM.ME },
    { name: 'Food / Meals', budgetPaise: 30000, paidFrom: PAID_FROM.ME },
    { name: 'Mobile Recharge', budgetPaise: 35000, paidFrom: PAID_FROM.ME },
    { name: 'WiFi', budgetPaise: 80000, paidFrom: PAID_FROM.ME },
    { name: 'Home', budgetPaise: 850000, paidFrom: PAID_FROM.HOME },
    { name: 'Shopping / Books', budgetPaise: 30000, paidFrom: PAID_FROM.ME },
    { name: 'Personal Care', budgetPaise: 20000, paidFrom: PAID_FROM.ME },
    { name: 'Medical', budgetPaise: 150000, paidFrom: PAID_FROM.HOME },
    { name: 'Hostel Fee', budgetPaise: 0, paidFrom: PAID_FROM.HOME },
    { name: 'Debt / Loan', budgetPaise: 0, paidFrom: PAID_FROM.ME },
    { name: 'Extras', budgetPaise: 25000, paidFrom: PAID_FROM.ME },
  ],
});

export function cloneDefaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

export function newId() {
  return crypto.randomUUID();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const MAX_TEXT = 200;
const cleanText = (v) => String(v ?? '').trim().slice(0, MAX_TEXT);

/** Returns { ok, value, errors } where value is a cleaned transaction. */
export function validateTransaction(tx) {
  const errors = {};
  const value = {
    id: cleanText(tx.id),
    kind: tx.kind,
    date: tx.date,
    amountPaise: tx.amountPaise,
    note: cleanText(tx.note),
    createdAt: Number(tx.createdAt) || Date.now(),
    updatedAt: Number(tx.updatedAt) || Date.now(),
  };
  if (!value.id) errors.id = 'Missing id';
  if (!isValidDate(value.date)) errors.date = 'Pick a valid date';
  if (!isValidPaise(value.amountPaise)) errors.amount = 'Amount must be more than ₹0';

  if (tx.kind === KIND.EXPENSE) {
    value.category = cleanText(tx.category);
    value.paidBy = cleanText(tx.paidBy);
    if (!value.category) errors.category = 'Pick a category';
    if (!value.paidBy) errors.paidBy = 'Pick how you paid';
    if (tx.paidFrom !== undefined && tx.paidFrom !== null) {
      if (tx.paidFrom === PAID_FROM.ME || tx.paidFrom === PAID_FROM.HOME) value.paidFrom = tx.paidFrom;
      else errors.paidFrom = 'Pick Me or Home money';
    }
  } else if (tx.kind === KIND.MONEY_IN) {
    value.type = tx.type;
    if (!MONEY_TYPES.includes(tx.type)) errors.type = 'Pick a type';
  } else {
    errors.kind = 'Unknown transaction kind';
  }
  return { ok: Object.keys(errors).length === 0, value, errors };
}

export function validateSettings(s) {
  const errors = [];
  const day = Number(s.periodStartDay);
  const warn = Number(s.warnPercent);
  if (!Number.isInteger(day) || day < 1 || day > 28) errors.push('Period start day must be 1–28');
  if (!Number.isInteger(warn) || warn < 1 || warn > 100) errors.push('Warning % must be 1–100');

  const payModes = [...new Set((s.payModes ?? []).map(cleanText).filter(Boolean))];
  if (!payModes.length) errors.push('Add at least one payment mode');

  const names = new Set();
  const categories = (s.categories ?? []).map((c) => ({
    name: cleanText(c.name),
    budgetPaise: Number(c.budgetPaise) || 0,
    paidFrom: c.paidFrom === PAID_FROM.HOME ? PAID_FROM.HOME : PAID_FROM.ME,
  }));
  for (const c of categories) {
    if (!c.name) errors.push('Category name cannot be empty');
    else if (names.has(c.name.toLowerCase())) errors.push(`Duplicate category "${c.name}"`);
    names.add(c.name.toLowerCase());
    if (!Number.isSafeInteger(c.budgetPaise) || c.budgetPaise < 0) errors.push(`Invalid budget for "${c.name}"`);
  }
  if (!categories.length) errors.push('Add at least one category');

  return {
    ok: errors.length === 0,
    errors,
    value: { periodStartDay: day, warnPercent: warn, payModes, categories },
  };
}

/** Validate a backup file. Never drops rows silently: invalid rows are reported. */
export function parseBackup(data) {
  if (!data || data.app !== 'expense-tracker' || !Array.isArray(data.transactions)) {
    return { ok: false, error: 'This is not an Expense Tracker backup file' };
  }
  const settings = validateSettings(data.settings ?? {});
  if (!settings.ok) return { ok: false, error: 'Backup settings invalid: ' + settings.errors.join('; ') };

  const transactions = [];
  const invalid = [];
  data.transactions.forEach((tx, i) => {
    const r = validateTransaction(tx);
    if (r.ok) transactions.push(r.value);
    else invalid.push(`Row ${i + 1}: ${Object.values(r.errors).join(', ')}`);
  });
  if (invalid.length) return { ok: false, error: 'Backup has invalid rows:\n' + invalid.join('\n') };
  return { ok: true, settings: settings.value, transactions };
}

import { paiseToInput } from './money.js';
import { txPaidFrom, sortTransactions, todayISO } from './calc.js';
import { KIND } from './model.js';

export function buildBackup({ settings, transactions }) {
  return { app: 'expense-tracker', version: 1, exportedAt: Date.now(), settings, transactions };
}

// Prefix cells that Excel would treat as formulas (CSV injection).
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function buildCsv({ settings, transactions }) {
  const header = ['Date', 'Kind', 'Category / Type', 'Amount (Rs)', 'Paid By', 'Paid From', 'Note'];
  const rows = sortTransactions(transactions, 'date', 'asc').map((tx) => {
    const isExpense = tx.kind === KIND.EXPENSE;
    return [
      tx.date,
      isExpense ? 'Expense' : 'Money In',
      isExpense ? tx.category : tx.type,
      paiseToInput(tx.amountPaise),
      tx.paidBy ?? '',
      isExpense ? txPaidFrom(tx, settings) : '',
      tx.note,
    ];
  });
  // BOM so Excel opens UTF-8 (₹, non-English notes) correctly.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const backupFilename = (ext) => `expenses-${todayISO()}.${ext}`;

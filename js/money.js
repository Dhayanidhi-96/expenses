// Money is stored as integer paise (₹1 = 100 paise) to avoid floating-point errors.

const MAX_PAISE = 100_000_000_00; // ₹10 crore per entry is a sane upper bound

/** Parse user input like "1,250.5" or "₹ 40" into integer paise. */
export function parseAmount(input) {
  const text = String(input ?? '').replace(/[₹,\s]/g, '');
  if (text === '') return { ok: false, error: 'Enter an amount' };
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return { ok: false, error: 'Use numbers only, up to 2 decimals' };
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (paise <= 0) return { ok: false, error: 'Amount must be more than ₹0' };
  if (paise > MAX_PAISE) return { ok: false, error: 'Amount is too large' };
  return { ok: true, paise };
}

export function isValidPaise(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PAISE;
}

const groupFormat = new Intl.NumberFormat('en-IN');

/**
 * Format paise as Indian rupees, e.g. 12345678 -> "₹1,23,456.78".
 * Accepts fractional paise (from averages) and rounds to the nearest paisa.
 * Whole-rupee amounts drop the decimals unless `decimals` is true.
 */
export function formatINR(paise, { decimals = false } = {}) {
  const rounded = Math.round(paise);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const rupees = groupFormat.format(Math.trunc(abs / 100));
  const fraction = abs % 100;
  const tail = decimals || fraction ? '.' + String(fraction).padStart(2, '0') : '';
  return `${sign}₹${rupees}${tail}`;
}

/** Plain rupee string for inputs/CSV, e.g. 125050 -> "1250.50". */
export function paiseToInput(paise) {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

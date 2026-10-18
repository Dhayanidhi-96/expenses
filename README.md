# Expense Tracker

A fast, private expense and budget tracker that works on phone and laptop, with your data synced between them.
It is built as an installable web app (PWA) with no frameworks and no build step.

**Live app:** https://dhayanidhi.me/expenses/

---

## Features

**Track**
- Add expenses in a few taps: amount, category, payment method (UPI, cash, card), date and an optional note.
- Record money in: income, savings, money given to home, and money taken back from savings.
- Edit or delete any entry, with undo after a delete.
- Create a new category straight from the add screen.

**Understand**
- **Dashboard:** money left this period, a safe amount to spend per day, a projected total, and plain-language alerts, for example *"At this speed you'll spend ₹5,600 – keep to ₹123/day"*.
- **Spent vs plan chart:** your running total against the ideal pace, with a daily view as well.
- **Category budgets** with progress bars and warnings when a budget is nearly used up (80%) or overspent.
- **Analytics:**
  - Any range: this period, last period, last 3 or 6 periods, this year, or custom dates.
  - Change compared with the previous range.
  - Spending by weekday.
  - A spending calendar.
  - Category trends.
  - Payment methods.
  - Top expenses.
  - A savings tracker.
  - Budget suggestions based on what you actually spend.
- **History:** search, filter by date, category or payment method, and sort.

**Your way**
- Budget periods can start on any day of the month, for example the 16th to the 15th, to match your pay date.
- Separate pots for **your own money** and **home money**: each category is paid from one of them.
- Light and dark themes.
- Works offline. Changes sync when you're back online.

**Your data**
- Sign in with Google. Your entries are visible only to you.
- Download a full backup (JSON) or export to Excel (CSV) at any time, and restore from a backup.

---

## How it works

| Part | Technology |
|---|---|
| App | Plain HTML, CSS and JavaScript (ES modules), no dependencies or build step |
| Charts | Hand-drawn inline SVG, sized to the screen, with tap/hover details |
| Sync & sign-in | [Firebase](https://firebase.google.com) Authentication (Google) and Cloud Firestore, free Spark plan |
| Hosting | GitHub Pages |
| Offline | Service worker (app shell) and Firestore offline cache (data) |

### Money accuracy
- Amounts are stored as **integer paise** (₹1 = 100 paise), never as floating-point numbers, so totals never drift by rounding.
- Every total, card and chart is computed in one place (`js/calc.js` and `js/analytics.js`), so all screens agree.
- Inputs are validated in the app and again by the database security rules.

### Project structure
```
index.html             App shell, navigation and icon set
styles.css             Theme (light/dark) and responsive layout
manifest.webmanifest   Install-to-home-screen settings
sw.js                  Offline cache (bump CACHE when files change)
firestore.rules        Database security rules (per-user access + validation)
js/
  app.js               Screens, routing and forms
  calc.js              Periods, dashboard totals, alerts, filters
  analytics.js         Analytics ranges, comparisons, budget review, trends
  model.js             Data model, default settings, validation
  money.js             Parsing and formatting of rupee amounts
  store.js             Storage: Firebase (synced) or browser-only
  backup.js            JSON backup and CSV export
  firebase-config.js   Firebase web app settings
```

---

## Privacy & security
- Every entry is stored under the signed-in user's account (`users/{uid}/…`). The Firestore rules in `firestore.rules` allow each user to read and write **only their own** data, and reject invalid amounts and dates.
- The Firebase values in `js/firebase-config.js` are public identifiers, not secrets. Access is controlled by the security rules.
- No analytics or tracking scripts are included.
- Text you type is escaped before display, and CSV exports are protected against spreadsheet formula injection.

---

## Run it yourself

### Locally
```bash
python -m http.server 8000
# open http://localhost:8000
```
Add `?mode=local` to the address (`http://localhost:8000/?mode=local`) to keep data in the browser only, with no sign-in.

### With your own Firebase project (free)
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com) (Analytics not needed).
2. **Authentication → Sign-in method:** enable **Google**.
3. **Firestore Database:** create a database in production mode, then paste `firestore.rules` into the **Rules** tab and click **Publish**.
4. **Project settings → Your apps → Web:** register an app and copy its config into `js/firebase-config.js`.
5. **Authentication → Settings → Authorized domains:** add the domain you host on.

### Deploy to GitHub Pages
Push this folder to a repository, then go to **Settings → Pages → Deploy from a branch → `main` / root**.
When you change any file, bump `CACHE` in `sw.js` so installed apps pick up the update.

---

## Using the app
1. Open the site and **sign in with Google**.
2. On a phone, use **Add to Home Screen** (Chrome ⋮ menu, or Safari's Share button) so it opens like an app.
3. In **Settings**, set the day your budget period starts, your categories and budgets, and your payment methods.
4. Add your **Money In** for the period, then add expenses as you spend.

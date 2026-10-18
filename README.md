# Expense Tracker

Static web app (no build step). Money is stored as integer paise; all totals come from `js/calc.js`.

## Run locally
```
python -m http.server 8000      # in this folder, then open http://localhost:8000
node --test tests/              # unit tests
```
Without Firebase config, data stays in the browser (local mode).

## Enable sync (free Firebase "Spark" plan)
1. console.firebase.google.com → Add project (Analytics off).
2. Build → Authentication → Get started → Sign-in method → enable **Google**.
3. Build → Firestore Database → Create database (production mode) → Rules tab → paste `firestore.rules` → Publish.
4. Project settings → Your apps → Web (`</>`) → register → copy the `firebaseConfig` object into `js/firebase-config.js`.
5. Authentication → Settings → Authorized domains → add `<your-github-username>.github.io`.

## Deploy (GitHub Pages)
Push this folder to a GitHub repo → Settings → Pages → Deploy from branch `main` / root.
Bump `CACHE` in `sw.js` when you change files so phones pick up the update.

Never commit backups or `import/` files – they contain your financial data.

// Persistence. Two adapters share one interface:
//   local    – browser localStorage (no account, this device only)
//   firebase – Firestore + Google sign-in (synced across devices, works offline)
import { cloneDefaults, validateTransaction, validateSettings } from './model.js';

const LOCAL_KEY = 'expense-tracker:v1';
const FIREBASE_VERSION = '10.12.2';

/**
 * onChange receives { ready, user, transactions, settings }.
 * onError receives a user-facing message.
 */
export async function createStore({ firebaseConfig, onChange, onError }) {
  return firebaseConfig
    ? createFirebaseStore(firebaseConfig, onChange, onError)
    : createLocalStore(onChange, onError);
}

function checkTransaction(tx) {
  const r = validateTransaction(tx);
  if (!r.ok) throw new Error(Object.values(r.errors).join(', '));
  return r.value;
}

function checkSettings(settings) {
  const r = validateSettings(settings);
  if (!r.ok) throw new Error(r.errors.join(', '));
  return r.value;
}

const applyRenames = (tx, renames) =>
  tx.kind === 'expense' && renames[tx.category] ? { ...tx, category: renames[tx.category], updatedAt: Date.now() } : tx;

// ---------------- Local

export function createLocalStore(onChange, onError, storage = globalThis.localStorage) {
  let data = load();

  function load() {
    try {
      const saved = JSON.parse(storage.getItem(LOCAL_KEY));
      if (saved && Array.isArray(saved.transactions)) return { settings: cloneDefaults(), ...saved };
    } catch { /* fall through to empty data */ }
    return { settings: cloneDefaults(), transactions: [] };
  }

  function commit(next) {
    try {
      storage.setItem(LOCAL_KEY, JSON.stringify(next));
    } catch {
      throw new Error('Could not save on this device (storage full or blocked)');
    }
    data = next;
    emit();
  }

  const emit = () => onChange({ ready: true, user: null, ...data });

  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === LOCAL_KEY) { data = load(); emit(); }
  });
  emit();

  return {
    mode: 'local',
    async saveTransactions(txs) {
      const clean = txs.map(checkTransaction);
      const byId = new Map(data.transactions.map((t) => [t.id, t]));
      for (const tx of clean) byId.set(tx.id, tx);
      commit({ ...data, transactions: [...byId.values()] });
    },
    async deleteTransaction(id) {
      commit({ ...data, transactions: data.transactions.filter((t) => t.id !== id) });
    },
    async saveSettings(settings, renames = {}) {
      commit({
        settings: checkSettings(settings),
        transactions: data.transactions.map((t) => applyRenames(t, renames)),
      });
    },
    signIn: async () => onError('Sync is not set up yet. See firebase-config.js.'),
    signOut: async () => {},
  };
}

// ---------------- Firebase

async function createFirebaseStore(config, onChange, onError) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const authApi = auth.getAuth(app);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });

  let state = { ready: false, user: null, settings: cloneDefaults(), transactions: [] };
  let unsubscribers = [];
  const emit = (patch) => { state = { ...state, ...patch }; onChange(state); };

  const userPath = () => {
    if (!state.user) throw new Error('Please sign in first');
    return `users/${state.user.uid}`;
  };
  const txDoc = (id) => fs.doc(db, `${userPath()}/transactions/${id}`);
  const settingsDoc = () => fs.doc(db, `${userPath()}/meta/settings`);

  // Writes apply locally at once and sync when online; only report failures.
  const report = (promise) => promise.catch((e) => onError('Sync failed: ' + friendlyError(e)));

  auth.onAuthStateChanged(authApi, (user) => {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    if (!user) {
      emit({ ready: true, user: null, transactions: [], settings: cloneDefaults() });
      return;
    }
    emit({ ready: false, user: { uid: user.uid, name: user.displayName, email: user.email } });
    let gotTx = false;
    let gotSettings = false;
    const maybeReady = () => gotTx && gotSettings && emit({ ready: true });
    unsubscribers.push(
      fs.onSnapshot(fs.collection(db, `users/${user.uid}/transactions`), (snap) => {
        gotTx = true;
        emit({ transactions: snap.docs.map((d) => d.data()) });
        maybeReady();
      }, (e) => onError('Could not load transactions: ' + friendlyError(e))),
      fs.onSnapshot(fs.doc(db, `users/${user.uid}/meta/settings`), (snap) => {
        gotSettings = true;
        emit({ settings: snap.exists() ? { ...cloneDefaults(), ...snap.data() } : cloneDefaults() });
        maybeReady();
      }, (e) => onError('Could not load settings: ' + friendlyError(e))),
    );
  });

  async function writeInBatches(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = fs.writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => op(batch));
      report(batch.commit());
    }
  }

  return {
    mode: 'firebase',
    async saveTransactions(txs) {
      const clean = txs.map(checkTransaction);
      await writeInBatches(clean.map((tx) => (b) => b.set(txDoc(tx.id), tx)));
    },
    async deleteTransaction(id) {
      report(fs.deleteDoc(txDoc(id)));
    },
    async saveSettings(settings, renames = {}) {
      const clean = checkSettings(settings);
      const renamed = state.transactions.filter((t) => t.kind === 'expense' && renames[t.category]);
      await writeInBatches([
        (b) => b.set(settingsDoc(), clean),
        ...renamed.map((t) => (b) => b.set(txDoc(t.id), applyRenames(t, renames))),
      ]);
    },
    async signIn() {
      try {
        await auth.signInWithPopup(authApi, new auth.GoogleAuthProvider());
      } catch (e) {
        if (e.code !== 'auth/popup-closed-by-user') onError('Sign-in failed: ' + friendlyError(e));
      }
    },
    signOut: () => auth.signOut(authApi),
  };
}

function friendlyError(e) {
  if (e?.code === 'permission-denied') return 'permission denied';
  if (e?.code === 'auth/unauthorized-domain') return 'this website address is not authorized in Firebase';
  return e?.message ?? String(e);
}

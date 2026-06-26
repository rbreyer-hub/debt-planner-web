/* ── Google Auth + Firestore cloud sync — Debt Planner ── */
(function () {
  'use strict';

  const SYNCED_USER_KEY  = 'debtPlanner.cloudSyncedUser';
  const LAST_PULL_TS_KEY = 'debtPlanner.lastCloudPullTs';
  const SESSION_KEY      = 'debtPlanner.sessionPulled';

  const auth = firebase.auth();
  const db   = firebase.firestore();
  let currentUser   = null;
  let unsubSnapshot = null;
  let saveCooldown  = false;
  let cooldownTimer = null;

  const debtDataRef = (uid) =>
    db.collection('users').doc(uid).collection('debtPlanner').doc('main');

  /* ── Toast ── */
  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._authTimer);
    el._authTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  /* ── Auth UI ── */
  function updateAuthUI(user) {
    const signInBtn = document.getElementById('authSignIn');
    const userChip  = document.getElementById('authUserChip');
    const avatar    = document.getElementById('authUserAvatar');
    const nameEl    = document.getElementById('authUserName');
    if (!signInBtn || !userChip) return;
    if (user) {
      signInBtn.style.display = 'none';
      userChip.style.display  = 'flex';
      if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = ''; }
      else { avatar.style.display = 'none'; }
      nameEl.textContent = user.displayName || user.email.split('@')[0];
    } else {
      signInBtn.style.display = '';
      userChip.style.display  = 'none';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authSignIn')?.addEventListener('click', () => {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .catch(e => alert('Sign-in failed: ' + e.message));
    });

    document.getElementById('authSignOut')?.addEventListener('click', () => {
      const ok = confirm('Sign out?\n\nYour data stays saved locally on this device.');
      if (!ok) return;
      auth.signOut().then(() => {
        localStorage.removeItem(SYNCED_USER_KEY);
        localStorage.removeItem(LAST_PULL_TS_KEY);
        toast('Signed out');
      });
    });

    document.getElementById('authSyncNow')?.addEventListener('click', () => {
      if (!currentUser) return;
      pullFromCloud(currentUser.uid, { force: true }).then(pulled => {
        if (!pulled) toast('☁ Already up to date');
      });
    });
  });

  /* ── Prevent reacting to our own writes ── */
  function markSaving() {
    saveCooldown = true;
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => { saveCooldown = false; }, 4000);
  }

  function syncLocalTsAfterWrite() {
    if (!currentUser) return;
    debtDataRef(currentUser.uid).get().then(snap => {
      const ts = snap.data()?.updatedAt?.toMillis?.();
      if (ts) localStorage.setItem(LAST_PULL_TS_KEY, String(ts));
    }).catch(() => {});
  }

  /* ── Push local → Firestore ──
     Safety: never push if debts list is empty. */
  async function pushLocalToCloud(uid) {
    const raw = localStorage.getItem('debtPlannerData');
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    if (!parsed.debts || parsed.debts.length === 0) {
      console.warn('[DebtSync] Push skipped: no debts in local data');
      return;
    }
    await debtDataRef(uid).set({
      data:      raw,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ── Pull cloud → localStorage ── */
  async function pullFromCloud(uid, options = {}) {
    let snap;
    try { snap = await debtDataRef(uid).get(); }
    catch (e) { console.warn('[DebtSync] Pull failed:', e); return false; }

    if (!snap.exists) {
      if (!options.silent) toast('No cloud data found');
      return false;
    }

    const d       = snap.data();
    const cloudTs = d.updatedAt?.toMillis?.() ?? 0;
    const localTs = parseInt(localStorage.getItem(LAST_PULL_TS_KEY) || '0');

    if (!options.force && cloudTs > 0 && cloudTs <= localTs) return false;

    if (d.data) localStorage.setItem('debtPlannerData', d.data);
    if (cloudTs > 0) localStorage.setItem(LAST_PULL_TS_KEY, String(cloudTs));
    sessionStorage.setItem(SESSION_KEY, uid);
    location.reload();
    return true;
  }

  /* ── Real-time cross-device listener ── */
  function startRealtimeSync(uid) {
    if (unsubSnapshot) unsubSnapshot();
    let initialTs;

    unsubSnapshot = debtDataRef(uid).onSnapshot(
      snap => {
        if (!snap.exists || snap.metadata.hasPendingWrites || saveCooldown) return;
        const cloudTs = snap.data()?.updatedAt?.toMillis?.() ?? 0;
        if (initialTs === undefined) { initialTs = cloudTs; return; }
        if (cloudTs > initialTs) {
          initialTs = cloudTs;
          pullFromCloud(uid, { silent: true });
        }
      },
      err => console.warn('[DebtSync] listener error:', err)
    );
  }

  /* ── First-time sign-in reconciliation ──
     Cloud exists → pull (cloud is source of truth).
     Cloud empty → offer to back up local data. */
  async function reconcile(user) {
    let snap;
    try { snap = await debtDataRef(user.uid).get(); }
    catch (e) { console.warn('[DebtSync] Firestore unreachable:', e); return; }

    if (snap.exists) {
      toast('☁ Loading your cloud data…', 3000);
      await pullFromCloud(user.uid, { force: true });
      return;
    }

    const raw = localStorage.getItem('debtPlannerData');
    let hasDebts = false;
    try { hasDebts = JSON.parse(raw).debts?.length > 0; } catch (_) {}

    if (hasDebts) {
      const doIt = confirm(
        `Welcome${user.displayName ? ', ' + user.displayName : ''}!\n\n` +
        `Back up your existing debts to the cloud so they sync across devices?`
      );
      if (doIt) {
        await pushLocalToCloud(user.uid);
        toast('☁ Data backed up to cloud');
      }
    }
  }

  /* ── Auth state listener ── */
  auth.onAuthStateChanged(async user => {
    currentUser = user;
    updateAuthUI(user);

    if (!user) {
      if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
      return;
    }

    const knownUser     = localStorage.getItem(SYNCED_USER_KEY) === user.uid;
    const pulledThisTab = sessionStorage.getItem(SESSION_KEY) === user.uid;

    localStorage.setItem(SYNCED_USER_KEY, user.uid);

    if (!knownUser) {
      await reconcile(user);
    } else if (!pulledThisTab) {
      sessionStorage.setItem(SESSION_KEY, user.uid);
      await pullFromCloud(user.uid, { silent: true });
    }

    startRealtimeSync(user.uid);
  });

  /* ── Public API: called from app.js on every save ── */
  window.cloudSync = {
    save(dataStr) {
      if (!currentUser || !dataStr) return;
      markSaving();
      debtDataRef(currentUser.uid)
        .set({ data: dataStr, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .then(syncLocalTsAfterWrite)
        .catch(e => console.warn('[DebtSync] save failed:', e));
    }
  };
})();

/*
  Debt Planner — Firebase config
  ─────────────────────────────────────────────────────────────────
  Reuses the same Firebase project as budget-planner-web.
  The authorized domain (rbreyer-hub.github.io) is already set.

  Firestore path: users/{uid}/debtPlanner/main
  Covered by the existing security rule:
    match /users/{userId}/{document=**} { allow read, write: if request.auth.uid == userId; }
  ─────────────────────────────────────────────────────────────────
*/

const firebaseConfig = {
  apiKey:            "AIzaSyDwagvEPiQDLre2k6rku_pkwyKcBOxBnwE",
  authDomain:        "budget-planner-fb.firebaseapp.com",
  projectId:         "budget-planner-fb",
  storageBucket:     "budget-planner-fb.firebasestorage.app",
  messagingSenderId: "682449918354",
  appId:             "1:682449918354:web:c132bcec3976ce1988094b"
};

firebase.initializeApp(firebaseConfig);

// ═══════════════════════════════════════════════════════
// CONFIGURAZIONE FIREBASE - L'Ancora HACCP
// ═══════════════════════════════════════════════════════
// 1. Vai su https://console.firebase.google.com
// 2. Crea un nuovo progetto (es. "lancora-haccp")
// 3. Aggiungi un'app Web (icona </> nella homepage del progetto)
// 4. Copia le credenziali qui sotto
// 5. Vai su Firestore Database → Crea database → Modalità produzione
// 6. Vai su Regole Firestore e incolla:
//
//    rules_version = '2';
//    service cloud.firestore {
//      match /databases/{database}/documents {
//        match /haccp/{document=**} {
//          allow read, write: if true;
//        }
//      }
//    }
// ═══════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyCiq4s0XNvXWe90VU1cYIZ8KyXLJpD3OXM",
  authDomain: "lancora-haccp.firebaseapp.com",
  databaseURL: "https://lancora-haccp-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "lancora-haccp",
  storageBucket: "lancora-haccp.firebasestorage.app",
  messagingSenderId: "263121790360",
  appId: "1:263121790360:web:18fbd1a9c0dff6809eb7ed"
};

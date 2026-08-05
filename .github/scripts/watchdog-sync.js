// Sorveglia che la sincronizzazione temperature sia viva.
// NON tocca eWeLink: se l'integrazione si rompe, questo continua a funzionare
// e avvisa. Un allarme che dipende dal sistema che sorveglia e inutile.
const admin = require('firebase-admin');

// Il cron di GitHub sul piano gratuito non e puntuale: chiediamo ogni ora ma
// consegna a 75-115 minuti. Una soglia di un'ora produrrebbe solo falsi allarmi.
// Tre ore = due giri saltati, cioe un guasto vero e non un ritardo.
const SOGLIA_MS = 3 * 60 * 60 * 1000;

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

function daQuanto(ms) {
  const min = Math.round(ms / 60000);
  if (min < 90) return min + ' minuti';
  const ore = Math.round(min / 60);
  if (ore < 48) return ore + ' ore';
  return Math.round(ore / 24) + ' giorni';
}

async function inviaPush(titolo, testo) {
  const snap = await db.collection('fcm_tokens').get();
  if (snap.empty) { console.log('Nessun dispositivo registrato'); return; }
  const tokens = snap.docs.map(d => d.id);
  const resp = await admin.messaging().sendEachForMulticast({
    notification: { title: titolo, body: testo },
    webpush: {
      headers: { Urgency: 'high', TTL: '3600' },
      notification: { title: titolo, body: testo, requireInteraction: true, vibrate: [400,200,400,200,400], tag: 'haccp-sync-fermo', renotify: true },
    },
    tokens,
  });
  console.log(`Push inviata: ${resp.successCount}/${tokens.length}`);
  resp.responses.forEach((r, i) => {
    if (!r.success && ['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(r.error?.code)) {
      db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
    }
  });
}

(async () => {
  const now = Date.now();
  const snap = await db.collection('config').doc('sync_status').get();
  const lastOk = snap.exists && snap.data().lastOk ? snap.data().lastOk.toDate().getTime() : null;

  if (!lastOk) {
    console.log('Nessun battito registrato: la sincronizzazione non e mai andata a buon fine');
    await inviaPush('Temperature celle non aggiornate',
      'Il sistema di rilevazione automatica non ha mai completato una sincronizzazione. Controlla le celle manualmente.');
    process.exit(0);
  }

  const eta = now - lastOk;
  console.log('Ultima sincronizzazione riuscita:', new Date(lastOk).toISOString(), '-', daQuanto(eta), 'fa');

  if (eta > SOGLIA_MS) {
    const msg = snap.data().lastErrorMsg ? ' Errore: ' + snap.data().lastErrorMsg : '';
    await inviaPush('Temperature celle non aggiornate',
      `Nessuna lettura da ${daQuanto(eta)}. Le celle non sono monitorate: controllale manualmente.${msg}`);
    console.log('ALLARME INVIATO');
  } else {
    console.log('Sincronizzazione regolare, nessun allarme');
  }
})().catch(e => { console.error('Errore watchdog:', e.message); process.exit(1); });

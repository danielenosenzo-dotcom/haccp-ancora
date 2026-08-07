// Legge le temperature dai display delle celle inquadrati dalla telecamera Tapo
// e le scrive su Firestore, dove l'app HACCP le usa come qualsiasi altra lettura.
//
// Principio guida: se la lettura non e certa, NON si inventa un numero.
// Si registra "lettura fallita" e si lascia che il watchdog se ne accorga.
// Un registro con valori sbagliati e peggio di un registro con un buco.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('firebase-admin');

const CONFIG = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH || '/config/config.json', 'utf8'));

admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebase) });
const db = admin.firestore();

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODELLO = 'claude-sonnet-5';

// ── Cattura di un fotogramma dalla telecamera ───────────────────────────
function catturaFotogramma() {
  const dest = path.join(os.tmpdir(), 'cella-' + Date.now() + '.jpg');
  const url = `rtsp://${encodeURIComponent(CONFIG.telecamera.utente)}:${encodeURIComponent(CONFIG.telecamera.password)}@${CONFIG.telecamera.ip}:554/stream1`;
  return new Promise((risolvi, rifiuta) => {
    execFile('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-frames:v', '1',
      '-q:v', '2',
      '-y', dest,
    ], { timeout: 45000 }, err => {
      if (err) return rifiuta(new Error('Cattura fallita: ' + err.message));
      if (!fs.existsSync(dest)) return rifiuta(new Error('Nessun fotogramma prodotto'));
      risolvi(dest);
    });
  });
}

// ── Lettura dei display tramite modello di visione ──────────────────────
async function leggiDisplay(fileImmagine) {
  const immagine = fs.readFileSync(fileImmagine).toString('base64');

  const elenco = CONFIG.celle.map((c, i) => `${i + 1}. ${c.etichetta} — ${c.posizione}`).join('\n');
  const istruzioni =
`Nell'immagine ci sono i display di controllo di alcune celle frigorifere.
Leggi il valore mostrato su ciascuno di questi display:

${elenco}

Rispondi SOLO con un oggetto JSON, senza testo attorno, in questa forma:
{"letture":[{"etichetta":"...","valore":-20.7,"certezza":"alta"}]}

Regole imprescindibili:
- "valore" deve essere il numero esattamente come appare sul display, segno compreso.
- Se un display non e leggibile con sicurezza (sfocato, coperto, appannato, tagliato,
  cifre ambigue), metti "valore": null e "certezza": "nulla". NON tirare a indovinare.
- Usa "certezza": "bassa" se leggi il numero ma qualche cifra e incerta.
- Non aggiungere celle che non sono nell'elenco.`;

  const risposta = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': CONFIG.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELLO,
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: immagine } },
          { type: 'text', text: istruzioni },
        ],
      }],
    }),
  });

  if (!risposta.ok) throw new Error('Modello di visione: HTTP ' + risposta.status + ' ' + (await risposta.text()).slice(0, 200));

  const j = await risposta.json();
  const testo = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = testo.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Risposta non interpretabile: ' + testo.slice(0, 200));
  return JSON.parse(m[0]).letture || [];
}

// ── Scrittura su Firestore ──────────────────────────────────────────────
const SOGLIA_ALLARME_MS = 60 * 60 * 1000;

async function inviaPush(titolo, testo, tag) {
  const snap = await db.collection('fcm_tokens').get();
  if (snap.empty) return;
  const tokens = snap.docs.map(d => d.id);
  try {
    const r = await admin.messaging().sendEachForMulticast({
      notification: { title: titolo, body: testo },
      webpush: {
        headers: { Urgency: 'high', TTL: '3600' },
        notification: { title: titolo, body: testo, requireInteraction: true, vibrate: [300, 150, 300], tag, renotify: true },
      },
      tokens,
    });
    console.log(`  push: ${r.successCount}/${tokens.length}`);
    r.responses.forEach((x, i) => {
      if (!x.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(x.error?.code)) {
        db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
      }
    });
  } catch (e) { console.error('  errore push:', e.message); }
}

async function registra(letture) {
  const now = new Date();
  const batch = db.batch();

  for (const cella of CONFIG.celle) {
    const lettura = letture.find(l => l.etichetta === cella.etichetta) || {};
    const valore = (typeof lettura.valore === 'number' && isFinite(lettura.valore)) ? lettura.valore : null;
    const certezza = lettura.certezza || 'nulla';

    // Guardia contro letture assurde: meglio nessun dato che un dato sbagliato.
    const plausibile = valore !== null && valore >= cella.plausibileMin && valore <= cella.plausibileMax;
    const valido = plausibile && certezza !== 'nulla';

    const liveRef = db.collection('celle_live').doc(cella.id);
    const prev = (await liveRef.get()).data() || {};

    let stato, anomaliaDa = null, notificaInviata = prev.notificaInviata || false;

    if (!valido) {
      stato = 'lettura_fallita';
    } else if (valore < cella.min || valore > cella.max) {
      const proseguiva = ['anomalia', 'sbrinamento'].includes(prev.status) && prev.anomaliaDa;
      anomaliaDa = proseguiva ? prev.anomaliaDa.toDate() : now;
      if ((now - anomaliaDa) >= SOGLIA_ALLARME_MS) {
        stato = 'anomalia';
        if (!notificaInviata) {
          await inviaPush('Allarme cella HACCP',
            `${cella.zona}: ${valore}°C (range ${cella.min}/${cella.max}°C) da oltre un'ora`,
            'haccp-cella-' + cella.id);
          notificaInviata = true;
        }
      } else {
        stato = 'sbrinamento';
      }
    } else {
      stato = 'ok';
      notificaInviata = false;
    }

    const ultimoLog = prev.ultimoLog ? prev.ultimoLog.toDate() : null;
    const daRegistrare = !ultimoLog || prev.status !== stato || (now - ultimoLog) >= 55 * 60 * 1000;

    const record = {
      zona: cella.zona, zona_gruppo: cella.zona_gruppo, deviceId: cella.id,
      temp: valido ? valore : null,
      min: cella.min, max: cella.max,
      status: stato, online: valido,
      certezza,
      anomaliaDa: anomaliaDa ? admin.firestore.Timestamp.fromDate(anomaliaDa) : null,
      notificaInviata,
      timestamp: admin.firestore.Timestamp.fromDate(now),
      ultimoLog: daRegistrare ? admin.firestore.Timestamp.fromDate(now) : (prev.ultimoLog || null),
      source: 'telecamera',
    };

    batch.set(liveRef, record);
    if (daRegistrare && valido) {
      batch.set(db.collection('temperature').doc(), { ...record, operatore: 'Lettura automatica telecamera' });
    }
    console.log(`  ${cella.zona}: ${valido ? valore + '°C' : 'NON LEGGIBILE'} [${stato}] certezza=${certezza}`);
  }

  await batch.commit();

  await db.collection('config').doc('sync_status').set({
    lastOk: admin.firestore.Timestamp.fromDate(now),
    lastError: null, lastErrorMsg: null, fonte: 'telecamera',
  }, { merge: true });
}

// ── Ciclo principale ────────────────────────────────────────────────────
async function unGiro() {
  console.log('\n[' + new Date().toLocaleString('it-IT') + '] lettura in corso');
  let file;
  try {
    file = await catturaFotogramma();
    const letture = await leggiDisplay(file);
    await registra(letture);
    console.log('  completato');
  } catch (e) {
    console.error('  ERRORE:', e.message);
    await db.collection('config').doc('sync_status').set({
      lastError: admin.firestore.Timestamp.now(),
      lastErrorMsg: String(e.message).slice(0, 300),
    }, { merge: true }).catch(() => {});
  } finally {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  }
}

(async () => {
  const intervallo = (CONFIG.intervalloMinuti || 60) * 60 * 1000;
  console.log('Lettore telecamera avviato — un giro ogni', CONFIG.intervalloMinuti || 60, 'minuti');
  await unGiro();
  setInterval(unGiro, intervallo);
})();

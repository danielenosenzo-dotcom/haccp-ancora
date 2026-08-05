const { createHmac } = require('crypto');
const admin = require('firebase-admin');

// Nomi in eWeLink: "CELLA 1 CANTINA", "CELLA 2 CANTINA", "CELLA FRESCO".
// Il vecchio 100072ac7d ("CELLA BT CANTINA") e offline da settimane: sostituito
// da 10024a6fcd, che e la sonda effettiva della seconda cella di cantina.
const DEVICES = [
  // CANTINA — Bassa Temperatura
  { id: '1000bcc9a0', zona: 'Cella BT Cantina 1', zona_gruppo: 'Cantina', min: -22, max: -15 },
  { id: '10024a6fcd', zona: 'Cella BT Cantina 2', zona_gruppo: 'Cantina', min: -22, max: -15 },
  // CUCINA — Temperature Positive
  { id: '100102f32a', zona: 'Cella Frigo Cucina', zona_gruppo: 'Cucina',  min: 0,   max: 4  },
  { id: '1000bcc977', zona: 'Frigo colonna',      zona_gruppo: 'Cucina',  min: 0,   max: 4  },
];

const NO_SENSOR = [
  { id: 'ns_dolci', zona: 'Cella Frigo Dolci', zona_gruppo: 'Cucina', min: 0, max: 4 },
];

// Un'anomalia deve durare almeno un'ora prima di far scattare l'allarme:
// lo sbrinamento alza la temperatura per 20-30 minuti ed e normale.
const ANOMALY_ALERT_DELAY_MS = 60 * 60 * 1000;

// Credenziali app: preferite da Firestore. I GitHub Secrets restano come
// ripiego, ma non sono affidabili — spazi o a capo invisibili nel valore
// fanno fallire la firma HMAC con un errore che non dice dov'e il problema.
let APP_ID     = process.env.EWELINK_APP_ID;
let APP_SECRET = process.env.EWELINK_APP_SECRET;
const BASE_URL = 'https://eu-apia.coolkit.cc';

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

const TOKENS_REF = db.collection('config').doc('ewelink');
const STATUS_REF = db.collection('config').doc('sync_status');

// I token vivono su Firestore, non nei GitHub Secrets: lo script non puo
// riscrivere i propri secret, quindi il token rinnovato andrebbe perso a ogni run.
const CODE_REF = db.collection('config').doc('oauth_code');

// Se l'app ha depositato un code di autorizzazione, lo scambia con i token.
// Sta qui e non in uno script a parte perche cosi la riautorizzazione funziona
// quando fa comodo all'utente: lui autorizza, il primo giro utile la completa.
async function consumaCodePendente() {
  const snap = await CODE_REF.get();
  if (!snap.exists || snap.data().usato || !snap.data().code) return null;

  const d = snap.data();
  console.log('Trovato un code di autorizzazione da consumare');
  const body = JSON.stringify({
    grantType: 'authorization_code',
    code: d.code,
    redirectUrl: 'https://danielenosenzo-dotcom.github.io/haccp-ancora/',
  });
  const sign = createHmac('sha256', APP_SECRET).update(body).digest('base64');
  const res = await fetch(`${BASE_URL}/v2/user/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Sign ' + sign, 'X-CK-Appid': APP_ID, 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  await CODE_REF.set({ usato: true, esito: json.error === 0 ? 'ok' : (json.msg || String(json.error)) }, { merge: true });

  if (json.error !== 0) { console.log('Scambio code fallito:', json.error, json.msg || ''); return null; }
  await salvaToken(json.data.accessToken, json.data.refreshToken);
  console.log('Riautorizzazione completata');
  return json.data.accessToken;
}

async function leggiToken() {
  const snap = await TOKENS_REF.get();
  const d = snap.exists ? snap.data() : {};

  if (d.appId)     APP_ID     = String(d.appId).trim();
  if (d.appSecret) APP_SECRET = String(d.appSecret).trim();
  if (APP_ID)     APP_ID     = APP_ID.trim();
  if (APP_SECRET) APP_SECRET = APP_SECRET.trim();

  if (d.refreshToken) {
    return { accessToken: d.accessToken, refreshToken: d.refreshToken, fonte: 'firestore' };
  }
  return {
    accessToken:  (process.env.EWELINK_ACCESS_TOKEN  || '').trim(),
    refreshToken: (process.env.EWELINK_REFRESH_TOKEN || '').trim(),
    fonte: 'secrets',
  };
}

async function salvaToken(accessToken, refreshToken) {
  await TOKENS_REF.set({
    accessToken, refreshToken,
    updatedAt: admin.firestore.Timestamp.now(),
  }, { merge: true }); // merge: non deve cancellare appId/appSecret
  console.log('Token aggiornati e salvati su Firestore');
}

// Endpoint corretto per il rinnovo: /v2/user/refresh con { rt }.
// NON /v2/user/oauth/token, che serve solo allo scambio del code OAuth iniziale.
async function refreshAccessToken(refreshToken) {
  const body = JSON.stringify({ rt: refreshToken });
  const sign = createHmac('sha256', APP_SECRET).update(body).digest('base64');
  const res = await fetch(`${BASE_URL}/v2/user/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Sign ' + sign, 'X-CK-Appid': APP_ID, 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`Refresh fallito (${json.error}): ${json.msg || ''}`);
  await salvaToken(json.data.at, json.data.rt);
  return json.data.at;
}

async function getDevices(token) {
  const res = await fetch(`${BASE_URL}/v2/device/thing?num=30`, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`Lettura dispositivi fallita (${json.error}): ${json.msg || ''}`);
  return json.data.thingList;
}

async function inviaPush(titolo, testo, tag) {
  const snap = await db.collection('fcm_tokens').get();
  if (snap.empty) { console.log('Nessun dispositivo registrato per le notifiche'); return; }
  const tokens = snap.docs.map(d => d.id);
  try {
    const resp = await admin.messaging().sendEachForMulticast({
      notification: { title: titolo, body: testo },
      webpush: {
        headers: { Urgency: 'high', TTL: '3600' },
        notification: { title: titolo, body: testo, requireInteraction: true, vibrate: [300,150,300], tag, renotify: true },
      },
      tokens,
    });
    console.log(`Push inviata: ${resp.successCount}/${tokens.length}`);
    resp.responses.forEach((r, i) => {
      if (!r.success && ['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(r.error?.code)) {
        db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
      }
    });
  } catch (e) { console.error('Errore invio push:', e.message); }
}

async function main() {
  const now = new Date();
  console.log('Sync temperature eWeLink -> Firebase', now.toISOString());

  // leggiToken per primo: imposta APP_ID/APP_SECRET da Firestore, che servono
  // a firmare lo scambio del code qui sotto.
  let { accessToken, refreshToken, fonte } = await leggiToken();
  console.log('Token letti da:', fonte);

  const daCode = await consumaCodePendente();
  if (daCode) accessToken = daCode;

  let thingList;
  try {
    thingList = await getDevices(accessToken);
  } catch (e) {
    console.log('Access token non valido, provo il refresh:', e.message);
    accessToken = await refreshAccessToken(refreshToken);
    thingList = await getDevices(accessToken);
  }

  const batch = db.batch();

  for (const device of DEVICES) {
    const thing  = thingList.find(t => t.itemData.deviceid === device.id);
    const online = thing ? thing.itemData.online : false;
    const params = thing ? thing.itemData.params : {};
    const raw    = params.currentTemperature;
    const temp   = raw !== undefined && raw !== 'unavailable' ? parseFloat(raw) : null;

    const fuoriSoglia = temp !== null && (temp < device.min || temp > device.max);

    const liveRef = db.collection('celle_live').doc(device.id);
    const prev = (await liveRef.get()).data() || {};

    let anomaliaDa = null;
    let notificaInviata = prev.notificaInviata || false;
    let status;

    // Una lettura isolata fuori soglia e quasi sempre uno sbrinamento (20-30 min).
    // Va registrata come tale, non come anomalia: un registro pieno di sforamenti
    // che non erano problemi e' piu' difficile da spiegare di uno pulito.
    // Diventa anomalia solo se lo sforamento persiste oltre l'ora.
    if (!online)            status = 'offline';
    else if (temp === null) status = 'no_data';
    else if (fuoriSoglia) {
      const proseguiva = (prev.status === 'anomalia' || prev.status === 'sbrinamento') && prev.anomaliaDa;
      anomaliaDa = proseguiva ? prev.anomaliaDa.toDate() : now;
      if ((now - anomaliaDa) >= ANOMALY_ALERT_DELAY_MS) {
        status = 'anomalia';
        if (!notificaInviata) {
          await inviaPush('Allarme cella HACCP',
            `${device.zona}: ${temp}°C (range ${device.min}/${device.max}°C) da oltre un'ora`,
            'haccp-cella-' + device.id);
          notificaInviata = true;
        }
      } else {
        status = 'sbrinamento';
      }
    } else {
      status = 'ok';
      notificaInviata = false;
    }

    const record = {
      zona: device.zona, zona_gruppo: device.zona_gruppo, deviceId: device.id,
      temp, min: device.min, max: device.max, status, online,
      anomaliaDa: anomaliaDa ? admin.firestore.Timestamp.fromDate(anomaliaDa) : null,
      notificaInviata,
      timestamp: admin.firestore.Timestamp.fromDate(now),
      source: 'ewelink-auto',
    };
    batch.set(liveRef, record);
    batch.set(db.collection('temperature').doc(), { ...record, operatore: 'Sistema automatico' });
    console.log(`${device.zona}: ${temp !== null ? temp + '°C' : 'N/D'} [${status}]`);
  }

  for (const ns of NO_SENSOR) {
    batch.set(db.collection('celle_live').doc(ns.id), {
      zona: ns.zona, zona_gruppo: ns.zona_gruppo, deviceId: ns.id,
      temp: null, min: ns.min, max: ns.max, status: 'no_sensor', online: false,
      timestamp: admin.firestore.Timestamp.fromDate(now), source: 'no-sensor',
    });
  }

  await batch.commit();

  // Battito: serve al watchdog per capire se la sincronizzazione e viva.
  await STATUS_REF.set({
    lastOk: admin.firestore.Timestamp.fromDate(now),
    lastError: null,
    lastErrorMsg: null,   // altrimenti un errore vecchio resta appiccicato agli allarmi futuri
    allarmeInviato: false,
  }, { merge: true });

  console.log('Sync completato');
}

main().catch(async err => {
  console.error('Errore:', err.message);
  try {
    await STATUS_REF.set({
      lastError: admin.firestore.Timestamp.now(),
      lastErrorMsg: String(err.message).slice(0, 300),
    }, { merge: true });
  } catch (_) {}
  process.exit(1);
});

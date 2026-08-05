const { createHmac } = require('crypto');
const admin = require('firebase-admin');

const DEVICES = [
  // CANTINA — Bassa Temperatura
  { id: '1000bcc9a0', zona: 'Cella BT Cantina 1', zona_gruppo: 'Cantina', min: -22, max: -15 },
  { id: '100072ac7d', zona: 'Cella BT Cantina 2', zona_gruppo: 'Cantina', min: -22, max: -15 },
  // CUCINA — Temperature Positive
  { id: '100102f32a', zona: 'Cella Frigo Cucina', zona_gruppo: 'Cucina',  min: 0,   max: 4  },
];

const NO_SENSOR = [
  { id: 'ns_dolci', zona: 'Cella Frigo Dolci', zona_gruppo: 'Cucina', min: 0, max: 4 },
];

// Un'anomalia deve durare almeno un'ora prima di far scattare l'allarme:
// lo sbrinamento alza la temperatura per 20-30 minuti ed e normale.
const ANOMALY_ALERT_DELAY_MS = 60 * 60 * 1000;

const APP_ID     = process.env.EWELINK_APP_ID;
const APP_SECRET = process.env.EWELINK_APP_SECRET;
const BASE_URL   = 'https://eu-apia.coolkit.cc';

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
async function leggiToken() {
  const snap = await TOKENS_REF.get();
  if (snap.exists && snap.data().refreshToken) {
    return { accessToken: snap.data().accessToken, refreshToken: snap.data().refreshToken, fonte: 'firestore' };
  }
  return {
    accessToken:  process.env.EWELINK_ACCESS_TOKEN,
    refreshToken: process.env.EWELINK_REFRESH_TOKEN,
    fonte: 'secrets',
  };
}

async function salvaToken(accessToken, refreshToken) {
  await TOKENS_REF.set({
    accessToken, refreshToken,
    updatedAt: admin.firestore.Timestamp.now(),
  });
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

  let { accessToken, refreshToken, fonte } = await leggiToken();
  console.log('Token letti da:', fonte);

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
    const status = !online ? 'offline' : (temp === null ? 'no_data' : (fuoriSoglia ? 'anomalia' : 'ok'));

    const liveRef = db.collection('celle_live').doc(device.id);
    const prev = (await liveRef.get()).data() || {};

    let anomaliaDa = null;
    let notificaInviata = prev.notificaInviata || false;

    if (status === 'anomalia') {
      anomaliaDa = (prev.status === 'anomalia' && prev.anomaliaDa) ? prev.anomaliaDa.toDate() : now;
      if ((now - anomaliaDa) >= ANOMALY_ALERT_DELAY_MS && !notificaInviata) {
        await inviaPush('Allarme cella HACCP',
          `${device.zona}: ${temp}°C (range ${device.min}/${device.max}°C) da oltre un'ora`,
          'haccp-cella-' + device.id);
        notificaInviata = true;
      }
    } else {
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

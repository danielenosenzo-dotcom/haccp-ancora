const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
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

const ANOMALY_ALERT_DELAY_MS = 60 * 60 * 1000; // 1 ora — evita falsi allarmi da sbrinamento

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

async function refreshAccessToken() {
  const body = JSON.stringify({ grantType: 'refresh_token', refreshToken: process.env.EWELINK_REFRESH_TOKEN });
  const sign = createHmac('sha256', APP_SECRET).update(body).digest('base64');
  const res = await fetch(`${BASE_URL}/v2/user/oauth/token`, {
    method: 'POST',
    headers: { 'Authorization': `Sign ${sign}`, 'X-CK-Appid': APP_ID, 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`Refresh failed: ${JSON.stringify(json)}`);
  return json.data.accessToken;
}

async function getDevices(token) {
  const res = await fetch(`${BASE_URL}/v2/device/thing?num=30`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`Get devices failed: ${JSON.stringify(json)}`);
  return json.data.thingList;
}

async function sendPushAlert(zona, temp, min, max) {
  const tokensSnap = await db.collection('fcm_tokens').get();
  if (tokensSnap.empty) { console.log('Nessun dispositivo registrato per le notifiche push'); return; }

  const tokens = tokensSnap.docs.map(d => d.id);
  const message = {
    notification: {
      title: '🚨 Allarme Cella HACCP',
      body: `${zona}: ${temp}°C (range ${min}/${max}°C) da oltre 1 ora`,
    },
    tokens,
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(message);
    console.log(`📲 Push inviata: ${resp.successCount}/${tokens.length} riuscite`);
    // Rimuovi token non più validi (app disinstallata, permesso revocato, ecc.)
    resp.responses.forEach((r, i) => {
      if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) {
        db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
      }
    });
  } catch (e) {
    console.error('Errore invio push:', e.message);
  }
}

async function main() {
  console.log('Sync temperature eWeLink → Firebase');
  let token = process.env.EWELINK_ACCESS_TOKEN;
  let thingList;
  try { thingList = await getDevices(token); }
  catch { token = await refreshAccessToken(); thingList = await getDevices(token); }

  const now = new Date();
  const batch = db.batch();

  for (const device of DEVICES) {
    const thing = thingList.find(t => t.itemData.deviceid === device.id);
    const online = thing ? thing.itemData.online : false;
    const params = thing ? thing.itemData.params : {};
    const tempRaw = params.currentTemperature;
    const temp = tempRaw !== undefined && tempRaw !== 'unavailable' ? parseFloat(tempRaw) : null;
    const outOfRange = temp !== null && (temp < device.min || temp > device.max);
    const status = !online ? 'offline' : outOfRange ? 'anomalia' : 'ok';

    // Leggi lo stato precedente per tracciare da quanto tempo dura l'anomalia
    const liveRef = db.collection('celle_live').doc(device.id);
    const prevSnap = await liveRef.get();
    const prev = prevSnap.exists ? prevSnap.data() : {};

    let anomaliaDa = null;
    let notificaInviata = prev.notificaInviata || false;

    if (status === 'anomalia') {
      anomaliaDa = prev.status === 'anomalia' && prev.anomaliaDa ? prev.anomaliaDa.toDate() : now;
      const durataMs = now - anomaliaDa;
      if (durataMs >= ANOMALY_ALERT_DELAY_MS && !notificaInviata) {
        await sendPushAlert(device.zona, temp, device.min, device.max);
        notificaInviata = true;
      }
    } else {
      anomaliaDa = null;
      notificaInviata = false;
    }

    const record = {
      zona: device.zona, zona_gruppo: device.zona_gruppo, deviceId: device.id,
      temp, min: device.min, max: device.max, status, online,
      anomaliaDa: anomaliaDa ? admin.firestore.Timestamp.fromDate(anomaliaDa) : null,
      notificaInviata,
      timestamp: admin.firestore.Timestamp.fromDate(now), source: 'ewelink-auto',
    };
    batch.set(liveRef, record);
    batch.set(db.collection('temperature').doc(), { ...record, operatore: 'Sistema automatico' });
    console.log(`${device.zona}: ${temp !== null ? temp+'°C' : 'N/D'} [${status}]`);
  }

  for (const ns of NO_SENSOR) {
    batch.set(db.collection('celle_live').doc(ns.id), {
      zona: ns.zona, zona_gruppo: ns.zona_gruppo, deviceId: ns.id,
      temp: null, min: ns.min, max: ns.max, status: 'no_sensor', online: false,
      timestamp: admin.firestore.Timestamp.fromDate(now), source: 'no-sensor',
    });
    console.log(`${ns.zona}: in attesa sensore`);
  }

  await batch.commit();
  console.log('Sync completato');
}

main().catch(err => { console.error('Errore:', err); process.exit(1); });

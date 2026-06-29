const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { createHmac } = require('crypto');
const admin = require('firebase-admin');

console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID ? 'OK' : 'MANCANTE');
console.log('FIREBASE_CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL ? 'OK' : 'MANCANTE');
console.log('FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'OK' : 'MANCANTE');
console.log('EWELINK_APP_ID:', process.env.EWELINK_APP_ID ? 'OK' : 'MANCANTE');

const DEVICES = [
  { id: '1000bcc9a0', name: 'Frigo porta',    zona: 'Frigo porta (Surgelati)',   min: -22, max: -15 },
  { id: '100102f32a', name: 'CELLA FRESCO',   zona: 'Cella Fresco',              min: -3,  max:  4  },
];

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
  const refreshToken = process.env.EWELINK_REFRESH_TOKEN;
  const body = JSON.stringify({ grantType: 'refresh_token', refreshToken });
  const sign = createHmac('sha256', APP_SECRET).update(body).digest('base64');
  const res = await fetch(`${BASE_URL}/v2/user/oauth/token`, {
    method: 'POST',
    headers: { 'Authorization': `Sign ${sign}`, 'X-CK-Appid': APP_ID, 'Content-Type': 'application/json' },
    body,
  });
  const json = await res.json();
  if (json.error !== 0) throw new Error(`Refresh token failed: ${JSON.stringify(json)}`);
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

async function main() {
  console.log('Sync temperature eWeLink → Firebase avviato');
  let token = process.env.EWELINK_ACCESS_TOKEN;
  let thingList;
  try {
    thingList = await getDevices(token);
  } catch {
    console.log('Access token scaduto, refresh in corso...');
    token = await refreshAccessToken();
    thingList = await getDevices(token);
  }

  const now = new Date();
  const batch = db.batch();

  for (const device of DEVICES) {
    const thing = thingList.find(t => t.itemData.deviceid === device.id);
    if (!thing) { console.log(`${device.name} non trovato`); continue; }

    const params = thing.itemData.params;
    const online = thing.itemData.online;
    const temp = params.currentTemperature !== undefined && params.currentTemperature !== 'unavailable'
      ? parseFloat(params.currentTemperature) : null;

    if (temp === null) { console.log(`${device.name} - temperatura non disponibile`); continue; }

    const outOfRange = temp < device.min || temp > device.max;
    const status = !online ? 'offline' : outOfRange ? 'anomalia' : 'ok';

    const record = {
      zona: device.zona, deviceId: device.id, temp, min: device.min, max: device.max,
      status, online, timestamp: admin.firestore.Timestamp.fromDate(now), source: 'ewelink-auto',
    };

    batch.set(db.collection('celle_live').doc(device.id), record);
    batch.set(db.collection('temperature').doc(), { ...record, operatore: 'Sistema automatico' });
    console.log(`${device.name}: ${temp}°C [${status}]`);
  }

  await batch.commit();
  console.log('Sync completato');
}

main().catch(err => { console.error('Errore:', err); process.exit(1); });

// Backup automatico dati HACCP: replica esattamente cosa fa il pulsante
// "Esporta dati (JSON)" in index.html, ma senza intervento manuale.
// Legge da Firestore via REST (stesse regole aperte usate dall'app web) e
// scrive nella stessa cartella Drive dove l'utente salvava a mano.
const https = require('https');
const fs = require('fs');

const PROJECT_ID = 'lancora-haccp';
const API_KEY = 'AIzaSyCiq4s0XNvXWe90VU1cYIZ8KyXLJpD3OXM';
const DEST = 'G:/Il mio Drive/SALVATAGGIO HACCP ANCORA/SALVATAGGIO DATI HACCP';

const DB_KEYS = [
  'temps','lotti','scadenze','labels','activity','ops',
  'customProducts','productOverrides','safimProducts',
  'pulizie_giornaliera','pulizie_settimanale','pulizie_mensile',
  'mag_entrate','mag_uscite','mag_inventari',
  'ingredienti','ricette','abbattimenti'
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Converte il formato campi Firestore REST (che avvolge ogni valore in {stringValue:..}
// o {arrayValue:{values:[...]}} ecc.) in JSON normale.
function daFirestoreValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(daFirestoreValue);
  if ('mapValue' in v) return daFirestoreFields(v.mapValue.fields || {});
  return null;
}
function daFirestoreFields(fields) {
  const out = {};
  Object.keys(fields).forEach(k => { out[k] = daFirestoreValue(fields[k]); });
  return out;
}

(async () => {
  const backup = { _version: '1.0', _date: new Date().toISOString(), _app: "L'Ancora HACCP" };
  let ok = 0, mancanti = [];

  for (const k of DB_KEYS) {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/haccp/${k}?key=${API_KEY}`;
    try {
      const j = await getJson(url);
      if (j.fields && j.fields.data) {
        backup[k] = daFirestoreValue(j.fields.data);
        ok++;
      } else {
        backup[k] = [];
        mancanti.push(k);
      }
    } catch (e) {
      backup[k] = [];
      mancanti.push(k + ' (errore: ' + e.message + ')');
    }
  }

  // Piatti salvati della Matrice Sensoriale: collezione a parte (un documento per
  // piatto, non un unico doc con array 'data' come le altre chiavi sopra).
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/piatti?key=${API_KEY}&pageSize=300`;
    const j = await getJson(url);
    backup.piattiSalvati = (j.documents || []).map(doc => {
      const id = doc.name.split('/').pop();
      return { _id: id, ...daFirestoreFields(doc.fields || {}) };
    });
    ok++;
  } catch (e) {
    backup.piattiSalvati = [];
    mancanti.push('piattiSalvati (errore: ' + e.message + ')');
  }

  const oggi = new Date().toISOString().slice(0, 10);
  const nomeFile = `LAncoraHACCP_backup_${oggi}_auto.json`;
  const percorso = DEST + '/' + nomeFile;
  fs.writeFileSync(percorso, JSON.stringify(backup, null, 2));

  console.log('Backup salvato:', percorso);
  console.log('Chiavi lette con successo:', ok, '/', DB_KEYS.length + 1);
  console.log('Piatti salvati inclusi:', backup.piattiSalvati.length);
  if (mancanti.length) console.log('Vuote o in errore:', mancanti.join(', '));
})();

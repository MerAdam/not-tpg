// Info trafic tpg.ch partagée entre l'app (/api/infotrafic) et les notifications (/api/check) :
// on interroge tpg.ch au plus une fois toutes les 5 minutes, résultat gardé dans Redis.
// Si tpg.ch refuse (ex. HTTP 403) on garde la dernière liste connue, et quand l'accès revient,
// les appareils « admin » reçoivent une notification (personne d'autre).
const crypto = require('crypto');
const { redis, getJSON, setJSON } = require('./_redis');
const { notifyAdmins, fmt, probe, record } = require('./_monitor');
const { parse } = require('./_infotrafic');

const EVERY = 5 * 60 * 1000;
const ADMIN_HASH = 'b7e933a9baa3a130e449fdcd483c7def68f8c6dac38158f0e17bd96d9c0e9610';
const isAdminCode = (code) => crypto.createHash('sha256').update(String(code || '').trim()).digest('hex') === ADMIN_HASH;

async function getAlerts(force) {
  const cur = (await getJSON('tpg:info')) || null;
  if (!force && cur && Date.now() - cur.checked < EVERY) return cur;
  // Une seule requête à la fois vers tpg.ch, même si plusieurs appels arrivent ensemble
  const lock = await redis('SET', 'tpg:lock', '1', 'NX', 'EX', 60);
  if (!lock && cur && !force) return cur;
  let next;
  const p = await probe('https://www.tpg.ch/fr/getInfoTrafic', 8000, { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } }, true);
  let items = null;
  if (p.ok) { try { items = parse(JSON.parse(p.body)).items; } catch { p.ok = false; p.kind = 'parse'; p.detail = 'Réponse illisible (pas le format attendu)'; } }
  delete p.body;
  if (p.ok) {
    next = { ok: true, items, at: Date.now(), checked: Date.now(), err: null, downSince: null, diag: p };
    if (cur && cur.ok === false) {
      await notifyAdmins('tpgBack', { title: 'tpg.ch répond de nouveau', body: 'L’info trafic est de nouveau accessible depuis l’app' + (cur.downSince ? ' (bloquée depuis le ' + fmt(cur.downSince) + ')' : '') + '.', tag: 'tpg-status' });
    }
  } else {
    const err = 'tpg.ch : ' + p.detail;
    if (!cur || cur.ok !== false) await notifyAdmins('tpgDown', { title: 'tpg.ch bloque l’info trafic', body: p.detail + '. La dernière liste connue reste affichée.', tag: 'tpg-status' });
    next = { ok: false, items: (cur && cur.items) || [], at: (cur && cur.at) || 0, checked: Date.now(), err: p.status ? 'tpg.ch HTTP ' + p.status : err, downSince: (cur && cur.downSince) || Date.now(), diag: p };
  }
  await record('tpg', p);
  await setJSON('tpg:info', next);
  await redis('DEL', 'tpg:lock');
  return next;
}

module.exports = { getAlerts, isAdminCode };

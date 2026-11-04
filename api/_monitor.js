// Petits tests de santé des services utilisés par l'app, et alertes « admin ».
const { redis, getJSON, setJSON } = require('./_redis');
const { send } = require('./_webpush');

const DEFAULT_PREFS = { tpgBack: true, tpgDown: true, odDown: true, odBack: true };
const getPrefs = async () => ({ ...DEFAULT_PREFS, ...((await getJSON('admin:prefs')) || {}) });

async function notifyAdmins(kind, payload) {
  const prefs = await getPrefs();
  if (kind && prefs[kind] === false) return;
  const sids = (await redis('SMEMBERS', 'admin:sids')) || [];
  for (const sid of sids) {
    const sub = await getJSON('sub:' + sid);
    if (sub) { try { await send(sub, payload); } catch {} }
  }
}

const fmt = (t) => new Date(t).toLocaleString('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

// Teste une URL : { ok, ms, err }
async function probe(url, ms = 6000, opts = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    return r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, err: 'HTTP ' + r.status };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: e.name === 'AbortError' ? 'pas de réponse en ' + ms / 1000 + ' s' : e.message }; }
  finally { clearTimeout(t); }
}

// Serveur des horaires : testé au plus toutes les 5 min par le robot ; alerte admin à la panne / au retour
async function watchOpendata(force) {
  const cur = (await getJSON('od:status')) || null;
  if (!force && cur && Date.now() - cur.checked < 5 * 60000) return cur;
  const p = await probe('https://transport.opendata.ch/v1/locations?query=Bel-Air&type=station');
  const next = { ...p, checked: Date.now(), since: cur && cur.ok === p.ok ? cur.since : Date.now() };
  if (cur && cur.ok && !p.ok) await notifyAdmins('odDown', { title: 'Serveur des horaires en panne', body: 'transport.opendata.ch ne répond plus (' + (p.err || '?') + ').', tag: 'od-status' });
  if (cur && !cur.ok && p.ok) await notifyAdmins('odBack', { title: 'Serveur des horaires de retour', body: 'transport.opendata.ch répond de nouveau (en panne depuis le ' + fmt(cur.since) + ').', tag: 'od-status' });
  await setJSON('od:status', next);
  return next;
}

module.exports = { notifyAdmins, probe, watchOpendata, getPrefs, DEFAULT_PREFS, fmt };

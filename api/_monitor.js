// Surveillance des services utilisés par l'app : tests avec diagnostic précis, historique 24 h,
// journal des incidents (30 jours) et alertes « admin ».
const { redis, pipeline, getJSON, setJSON } = require('./_redis');
const { send } = require('./_webpush');

const DEFAULT_PREFS = { tpgBack: true, tpgDown: true, odDown: true, odBack: true };
const getPrefs = async () => ({ ...DEFAULT_PREFS, ...((await getJSON('admin:prefs')) || {}) });
const SERVICES = { opendata: 'Horaires (transport.opendata.ch)', tpg: 'Info trafic (tpg.ch)', walk: 'Itinéraires à pied (OpenStreetMap)' };
const UA = 'Mozilla/5.0 (compatible; NotTPG/1.0; +https://github.com/MerAdam/not-tpg)';

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

// Explication en français d'un résultat de test
function describe(p) {
  if (p.ok) return 'OK';
  const extra = [p.protection ? 'protection ' + p.protection : '', p.retryAfter ? 'réessayer dans ' + p.retryAfter + ' s' : ''].filter(Boolean).join(' · ');
  const base = {
    timeout: 'Pas de réponse en ' + Math.round((p.limit || 6000) / 1000) + ' s (serveur saturé, ou nos requêtes ignorées)',
    refused: 'Connexion refusée (serveur arrêté ou port fermé)',
    dns: 'Nom de domaine introuvable (problème DNS)',
    reset: 'Connexion coupée en cours de route',
    tls: 'Erreur de certificat / connexion sécurisée',
    network: 'Erreur réseau',
    ratelimit: 'HTTP 429 : trop de requêtes, le serveur nous limite',
    blocked: 'HTTP ' + p.status + ' : accès refusé (blocage)',
    server: 'HTTP ' + p.status + ' : erreur interne de leur serveur',
    http: 'HTTP ' + p.status + ' : réponse inattendue',
    parse: 'Réponse illisible (pas le format attendu)'
  }[p.kind] || (p.err || 'Erreur');
  return base + (extra ? ' · ' + extra : '');
}

// Teste une URL et classe l'erreur : { ok, ms, status, kind, detail, protection, retryAfter, snippet, body? }
async function probe(url, ms = 6000, opts = {}, keepBody = false) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); const t0 = Date.now();
  const out = { ok: false, ms: 0, limit: ms, at: t0 };
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: c.signal });
    out.ms = Date.now() - t0; out.status = r.status;
    const h = (k) => r.headers.get(k);
    if (h('x-iinfo') || /incap_ses|visid_incap/.test(h('set-cookie') || '')) out.protection = 'anti-robots Imperva';
    else if (h('cf-ray')) out.protection = 'Cloudflare';
    else if (h('x-akamai-transformed') || /akamai/i.test(h('server') || '')) out.protection = 'Akamai';
    if (h('retry-after')) out.retryAfter = h('retry-after');
    const text = await r.text();
    if (r.ok) { out.ok = true; if (keepBody) out.body = text; }
    else {
      out.kind = r.status === 429 ? 'ratelimit' : r.status === 401 || r.status === 403 ? 'blocked' : r.status >= 500 ? 'server' : 'http';
      out.snippet = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  } catch (e) {
    out.ms = Date.now() - t0;
    const code = (e.cause && (e.cause.code || e.cause.name)) || e.code || '';
    out.kind = e.name === 'AbortError' ? 'timeout'
      : /ECONNREFUSED/.test(code) ? 'refused'
      : /ENOTFOUND|EAI_AGAIN/.test(code) ? 'dns'
      : /ECONNRESET|UND_ERR_SOCKET/.test(code) ? 'reset'
      : /CERT|TLS|SSL/.test(code) ? 'tls' : 'network';
    out.err = code || e.message;
  } finally { clearTimeout(t); }
  out.detail = describe(out);
  return out;
}

// Enregistre un résultat : historique 24 h + ouverture / fermeture des incidents
async function record(svc, p, where = 'vercel') {
  const now = p.at || Date.now();
  const cmds = [
    ['LPUSH', `mon:hist:${svc}`, [now, p.ok ? 1 : 0, p.ms || 0, p.kind || ''].join('|')],
    ['LTRIM', `mon:hist:${svc}`, 0, 700]
  ];
  const open = await getJSON(`mon:open:${svc}`);
  if (!p.ok && !open) {
    cmds.push(['SET', `mon:open:${svc}`, JSON.stringify({ svc, start: now, kind: p.kind, detail: p.detail, status: p.status || null, protection: p.protection || null, snippet: p.snippet || null, where, fails: 1 })]);
  } else if (!p.ok && open) {
    cmds.push(['SET', `mon:open:${svc}`, JSON.stringify({ ...open, fails: (open.fails || 1) + 1, last: now, detail: p.detail, kind: p.kind })]);
  } else if (p.ok && open) {
    cmds.push(['DEL', `mon:open:${svc}`],
      ['LPUSH', 'mon:inc', JSON.stringify({ ...open, end: now })], ['LTRIM', 'mon:inc', 0, 299]);
  }
  await pipeline(cmds);
}

// Serveur des horaires et itinéraires à pied : testés au plus toutes les 5 min par le robot
async function watchOpendata(force) {
  const cur = (await getJSON('od:status')) || null;
  if (!force && cur && Date.now() - cur.checked < 5 * 60000) return cur;
  const p = await probe('https://transport.opendata.ch/v1/locations?query=Bel-Air&type=station');
  const next = { ...p, checked: Date.now(), since: cur && cur.ok === p.ok ? cur.since : Date.now() };
  if (cur && cur.ok && !p.ok) await notifyAdmins('odDown', { title: 'Serveur des horaires en panne', body: 'transport.opendata.ch : ' + p.detail + '.', tag: 'od-status' });
  if (cur && !cur.ok && p.ok) await notifyAdmins('odBack', { title: 'Serveur des horaires de retour', body: 'transport.opendata.ch répond de nouveau (en panne depuis le ' + fmt(cur.since) + ').', tag: 'od-status' });
  await setJSON('od:status', next);
  await record('opendata', p);
  return next;
}
async function watchWalk(force) {
  const cur = (await getJSON('walk:status')) || null;
  if (!force && cur && Date.now() - cur.checked < 5 * 60000) return cur;
  const p = await probe('https://routing.openstreetmap.de/routed-foot/route/v1/driving/6.1432,46.2044;6.1450,46.2050?overview=false', 8000);
  const next = { ...p, checked: Date.now(), since: cur && cur.ok === p.ok ? cur.since : Date.now() };
  await setJSON('walk:status', next);
  await record('walk', p);
  return next;
}

module.exports = { notifyAdmins, probe, record, describe, watchOpendata, watchWalk, getPrefs, DEFAULT_PREFS, SERVICES, fmt };

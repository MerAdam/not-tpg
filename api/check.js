// Vérification appelée chaque minute (cron-job.org) : compare l'état des liaisons
// surveillées avec la vérification précédente et notifie les changements.
//  - trajets pendulaires : de 30 min avant le départ jusqu'au départ, les jours choisis ;
//  - cloches : un départ précis, jusqu'à son passage à l'arrêt.
// Un verrou Redis garantit au plus une exécution par minute, même si l'adresse est appelée plus souvent.
const { redis, pipeline, getJSON, setJSON } = require('./_redis');
const { send } = require('./_webpush');
const { parse: parseInfoTrafic } = require('./_infotrafic');

const API = 'https://transport.opendata.ch/v1';
const WINDOW = 30; // minutes avant le départ
const pad = (n) => String(n).padStart(2, '0');
const parseISO = (s) => (s ? new Date(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null);
const t2m = (t) => { const p = String(t || '0:0').split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); };
const m2t = (m) => { m = ((m % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const short = (n) => String(n || '').replace(/^Genève,\s*/, '');
const hmZ = (d) => d.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });

function zurich(now = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}

// Décalage d'heure de l'API (voir index.html) : mesuré sur Bel-Air à chaque vérification
// Renvoie -60, 0 ou 60, ou null si la mesure n'est pas fiable (nuit, API indisponible)
async function measureShift() {
  try {
    const z = zurich();
    if (z.min < 360 || z.min > 1380) return null; // la nuit, Bel-Air est trop peu desservi pour mesurer
    const j = await (await fetch(`${API}/stationboard?id=8587387&limit=6&datetime=${encodeURIComponent(z.date + ' ' + m2t(z.min))}`)).json();
    const first = Math.min(...(j.stationboard || []).map((d) => parseISO(d.stop.departure).getTime()));
    if (!isFinite(first)) return null;
    const diff = Math.round((first - Date.now()) / 60000);
    if (diff >= 45 && diff <= 75) return -60;
    if (diff <= -45 && diff >= -75) return 60;
    return diff >= -15 && diff <= 20 ? 0 : null;
  } catch { return null; }
}

// Décalage UTC de Genève en minutes (60 en hiver, 120 en été)
function zurichOffset(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', timeZoneName: 'shortOffset' }).formatToParts(now);
  const m = (p.find((x) => x.type === 'timeZoneName') || {}).value.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 60;
}

async function broadcast(payload) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis('SCAN', cursor, 'MATCH', 'sub:*', 'COUNT', 500);
    cursor = next; keys.push(...batch);
  } while (cursor !== '0');
  if (!keys.length) return 0;
  const subs = await pipeline(keys.map((k) => ['GET', k]));
  let ok = 0;
  await Promise.all(subs.map(async (v, i) => {
    if (!v) return;
    const r = await send(JSON.parse(v), payload);
    if (r === 'ok') ok++;
    if (r === 'gone') await redis('DEL', keys[i]);
  }));
  return ok;
}

// Suivi du changement d'heure et du décalage de l'API. Après un passage à l'heure
// d'été ou d'hiver, une notification confirme à tous les appareils que l'app s'est adaptée.
async function timeTick() {
  const st = (await getJSON('timecheck')) || {};
  const off = zurichOffset();
  let dirty = false;
  if (st.off == null) { st.off = off; dirty = true; }
  else if (st.off !== off) {
    st.pending = off > st.off ? 'été' : 'hiver';
    st.off = off; dirty = true;
  }
  if (!st.shiftAt || Date.now() - st.shiftAt > 10 * 60000 || st.pending) {
    const m = await measureShift();
    if (m != null) {
      const prev = st.shift;
      st.shift = m; st.shiftAt = Date.now(); dirty = true;
      if (st.pending) {
        const saison = st.pending; delete st.pending;
        await broadcast({
          title: `Passage à l’heure d’${saison}`,
          body: m
            ? 'Not TPG s’est adapté : l’horaire en ligne est décalé d’une heure, l’app compense automatiquement. Tes départs, itinéraires et notifications sont à la bonne heure.'
            : 'Not TPG s’est adapté : les horaires sont à la bonne heure, aucune correction n’est nécessaire.',
          tag: 'changement-heure'
        });
      } else if (prev != null && prev !== m) {
        await broadcast({
          title: 'Horaires',
          body: m
            ? 'L’horaire en ligne s’est décalé d’une heure : Not TPG compense automatiquement.'
            : 'L’horaire en ligne est revenu à la bonne heure : Not TPG a désactivé sa correction.',
          tag: 'changement-heure'
        });
      }
    }
  }
  if (dirty) await setJSON('timecheck', st);
  return st.shift || 0;
}
function shiftDT(date, time, delta) {
  if (!delta) return [date, time];
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d) + (t2m(time) + delta) * 60000);
  return [t.toISOString().slice(0, 10), m2t(t.getUTCHours() * 60 + t.getUTCMinutes())];
}

async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

// Perturbations tpg (même logique que l'app : ligne + direction)
const sameDir = (dir, to) => { if (!dir || !to) return true; const a = fold(dir), b = fold(to); return a.includes(b) || b.includes(a); };
const alertsFor = (alerts, line, to) => alerts.filter((a) => (a.lines || []).includes(String(line || '').toUpperCase()) && sameDir(a.direction, to));

// Compare deux états et produit les messages à envoyer
function diff(prev, cur) {
  const msgs = [];
  if (cur.gone && !(prev && prev.gone)) msgs.push(cur.goneText || 'Course supprimée ou introuvable dans l’horaire.');
  if (!cur.gone) {
    const d0 = prev && !prev.gone ? prev.delay || 0 : 0, d1 = cur.delay || 0;
    if (Math.abs(d1 - d0) >= 2 || (prev && prev.gone)) {
      if (d1 >= 2) msgs.push(`Retard : +${d1} min (départ à ${cur.realStr}).`);
      else if (d1 <= -2) msgs.push(`En avance : ${d1} min (départ à ${cur.realStr}).`);
      else if (Math.abs(d0) >= 2) msgs.push(`De nouveau à l’heure (départ à ${cur.realStr}).`);
    }
  }
  const old = new Set((prev && prev.alerts) || []);
  for (const a of cur.alertObjs || []) if (!old.has(a.id)) msgs.push(`${a.cause ? a.cause + ' : ' : ''}${a.title}${a.text ? ' ' + a.text : ''}`);
  return msgs;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const started = Date.now();
  try {
    const lock = await redis('SET', 'check:lock', String(started), 'NX', 'EX', 50);
    if (lock !== 'OK') return res.status(200).json({ skipped: 'déjà vérifié il y a moins d’une minute' });

    const SHIFT = await timeTick();
    const wids = (await redis('SMEMBERS', 'watches')) || [];
    if (!wids.length) return res.status(200).json({ watches: 0 });
    const raw = await pipeline(wids.map((w) => ['GET', `watch:${w}`]));
    const watches = [];
    const orphans = [];
    raw.forEach((v, i) => (v ? watches.push({ wid: wids[i], ...JSON.parse(v) }) : orphans.push(wids[i])));
    if (orphans.length) await pipeline(orphans.map((w) => ['SREM', 'watches', w]));

    const z = zurich();
    const now = Date.now();
    // Éléments à vérifier maintenant
    const tasks = [];
    for (const w of watches) {
      if (w.type === 'commute') {
        if (!w.days.includes(z.dow)) continue;
        w.picks.forEach((p, i) => {
          const until = t2m(p.dep) - z.min;
          if (until <= WINDOW && until >= -1) tasks.push({ w, kind: 'pick', p, i, sk: `state:${w.wid}:${z.date}:${i}` });
        });
      } else if (w.type === 'run') {
        const planned = Date.parse(w.planned);
        if (planned - now > 120 * 60000) continue; // trop tôt, on surveillera plus tard
        tasks.push({ w, kind: 'run', sk: `state:${w.wid}` });
      }
    }
    if (!tasks.length) return res.status(200).json({ watches: watches.length, active: 0 });

    let alerts = [];
    try {
      const r = await fetch('https://www.tpg.ch/fr/getInfoTrafic', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotTPG/1.0)', 'X-Requested-With': 'XMLHttpRequest' } });
      if (r.ok) alerts = parseInfoTrafic(await r.json()).items;
    } catch {}

    // Requêtes partagées entre utilisateurs
    const connCache = new Map(), boardCache = new Map();
    const getConns = (from, to, time) => {
      const k = [from, to, time].join('|');
      if (!connCache.has(k)) connCache.set(k, api(`/connections?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${z.date}&time=${time}&limit=4`).then((j) => j.connections || []).catch(() => null));
      return connCache.get(k);
    };
    const getBoard = (stopId, time) => {
      const k = stopId + '|' + time;
      if (!boardCache.has(k)) boardCache.set(k, api(`/stationboard?id=${encodeURIComponent(stopId)}&limit=15&datetime=${encodeURIComponent(shiftDT(...time.split(' '), SHIFT).join(' '))}`).then((j) => j.stationboard || []).catch(() => null));
      return boardCache.get(k);
    };

    const prevStates = await pipeline(tasks.map((t) => ['GET', t.sk]));
    const subsNeeded = [...new Set(tasks.map((t) => t.w.sid))];
    const subsRaw = await pipeline(subsNeeded.map((s) => ['GET', `sub:${s}`]));
    const subs = Object.fromEntries(subsNeeded.map((s, i) => [s, subsRaw[i] ? JSON.parse(subsRaw[i]) : null]));

    const writes = [], toSend = [], finished = [];
    await Promise.all(tasks.map(async (t, ti) => {
      const prev = prevStates[ti] ? JSON.parse(prevStates[ti]) : null;
      let cur = null, title = '';
      if (t.kind === 'pick') {
        const { w, p } = t;
        title = `${(p.legs || []).map((l) => l.num || l.cat).join(' + ')} · ${p.dep} ${short(w.from)} → ${short(w.to)}`;
        const list = await getConns(w.from, w.to, m2t(t2m(p.dep) - 2));
        if (!list) return; // API indisponible : on réessaiera
        const legsKey = (c) => (c.sections || []).filter((s) => s.journey).map((s) => s.journey.number || s.journey.category).join('+');
        const depOf = (c) => parseISO(c.from.departure);
        const m = list.find((c) => hmZ(depOf(c)) === p.dep && legsKey(c) === p.key)
          || list.find((c) => legsKey(c) === p.key && Math.abs((depOf(c).getTime() - now) / 60000 - (t2m(p.dep) - z.min)) <= 3);
        if (!m) {
          const others = list.filter((c) => depOf(c).getTime() > now).map((c) => hmZ(depOf(c)));
          cur = { gone: true, goneText: `Liaison de ${p.dep} introuvable (supprimée ?).${others.length ? ' Prochaines : ' + others.slice(0, 2).join(', ') + '.' : ''}`, alerts: [] };
        } else {
          const delay = m.from.delay || 0;
          const al = [];
          for (const s of m.sections || []) if (s.journey) al.push(...alertsFor(alerts, s.journey.number, s.journey.to));
          const uniq = [...new Map(al.map((a) => [a.id, a])).values()];
          cur = { delay, realStr: m2t(t2m(p.dep) + delay), alerts: uniq.map((a) => a.id), alertObjs: uniq };
        }
      } else {
        const { w } = t;
        const planned = new Date(w.planned);
        title = `${w.line} · ${hmZ(planned)} ${short(w.stopName)} → ${short(w.to)}`;
        const from = new Date(planned.getTime() - 2 * 60000);
        const z2 = zurich(from);
        const board = await getBoard(w.stopId, `${z2.date} ${m2t(z2.min)}`);
        if (!board) return;
        const m = board.find((d) => String(d.number || d.category) === w.line && Math.abs(parseISO(d.stop.departure) - planned) < 60000 && (!w.to || sameDir(w.to, d.to)));
        const real = m ? (parseISO(m.stop.prognosis && m.stop.prognosis.departure) || new Date(planned.getTime() + (m.stop.delay || 0) * 60000)) : planned;
        if (!m) {
          // Disparue de l'horaire alors que l'heure n'est pas passée : probablement supprimée
          cur = planned.getTime() > now ? { gone: true, goneText: 'Course supprimée ou introuvable dans l’horaire.', alerts: [] } : null;
        } else {
          const delay = m.stop.delay || 0;
          const uniq = alertsFor(alerts, w.line, w.to);
          cur = { delay, realStr: hmZ(real), alerts: uniq.map((a) => a.id), alertObjs: uniq };
        }
        if (real.getTime() < now - 2 * 60000) finished.push(w); // le bus est passé : fin du suivi
        if (!cur) return;
      }
      const msgs = diff(prev, cur);
      const { alertObjs, ...store } = cur;
      writes.push(['SET', t.sk, JSON.stringify(store), 'EX', 86400]);
      const sub = subs[t.w.sid];
      if (msgs.length && sub) toSend.push({ sub, sid: t.w.sid, payload: { title, body: msgs.join('\n'), tag: t.sk } });
    }));

    for (const w of finished) writes.push(['DEL', `watch:${w.wid}`], ['SREM', 'watches', w.wid], ['SREM', `user:${w.sid}:watches`, w.wid]);
    await pipeline(writes);

    const results = await Promise.all(toSend.map((m) => send(m.sub, m.payload).then((r) => ({ r, sid: m.sid }))));
    const gone = [...new Set(results.filter((x) => x.r === 'gone').map((x) => x.sid))];
    for (const sid of gone) {
      const ws = (await redis('SMEMBERS', `user:${sid}:watches`)) || [];
      await pipeline([...ws.flatMap((w) => [['DEL', `watch:${w}`], ['SREM', 'watches', w]]), ['DEL', `sub:${sid}`], ['DEL', `user:${sid}:watches`]]);
    }
    return res.status(200).json({ watches: watches.length, active: tasks.length, sent: results.filter((x) => x.r === 'ok').length, ms: Date.now() - started });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.diff = diff;
module.exports.zurich = zurich;

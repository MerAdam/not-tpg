// Panneau admin (code admin obligatoire) :
//   POST /api/admin?action=status {code, force}        -> état de tous les services + totaux
//   POST /api/admin?action=prefs  {code, prefs}        -> enregistre les alertes admin voulues
//   POST /api/admin?action=notify {code, sid}          -> notification de test à cet appareil
const { redis, getJSON, setJSON } = require('./_redis');
const { send } = require('./_webpush');
const { getAlerts, isAdminCode, setManual, clearManual } = require('./_tpgsource');
const { parse } = require('./_infotrafic');
const { watchOpendata, watchWalk, getPrefs, DEFAULT_PREFS, describe } = require('./_monitor');
const { pipeline } = require('./_redis');

async function count(pattern) {
  let cursor = '0', n = 0;
  do { const [c, keys] = await redis('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500); cursor = c; n += keys.length; } while (cursor !== '0');
  return n;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST attendu' });
  const action = (req.query && req.query.action) || '';
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!isAdminCode(body.code)) return res.status(403).json({ error: 'Code admin incorrect' });
  try {
    if (action === 'prefs') {
      const p = {}; for (const k of Object.keys(DEFAULT_PREFS)) if (k in (body.prefs || {})) p[k] = !!body.prefs[k];
      const next = { ...(await getPrefs()), ...p };
      await setJSON('admin:prefs', next);
      return res.status(200).json({ prefs: next });
    }
    if (action === 'import') {
      // Info trafic copiée depuis Safari (page tpg.ch/fr/getInfoTrafic) : on la lit avec le même système que d'habitude
      let json;
      try { json = JSON.parse(String(body.raw || '').trim()); } catch { return res.status(400).json({ error: 'Ce n’est pas le bon texte : copie tout le contenu de la page getInfoTrafic.' }); }
      let items;
      try { items = parse(json).items; } catch (e) { return res.status(400).json({ error: 'Format inattendu : ' + e.message }); }
      await setManual(items);
      await redis('DEL', 'tpg:lock');
      return res.status(200).json({ ok: true, count: items.length });
    }
    if (action === 'clearImport') { await clearManual(); return res.status(200).json({ ok: true }); }
    if (action === 'notify') {
      const sub = await getJSON('sub:' + String(body.sid || '').replace(/[^a-f0-9]/g, ''));
      if (!sub) return res.status(404).json({ error: 'Cet appareil n’est pas abonné aux notifications' });
      const r = await send(sub, { title: 'Not TPG · admin', body: 'Notification de test du panneau admin.', tag: 'admin-test' });
      return res.status(200).json({ ok: r === 'ok' });
    }
    if (action === 'status') {
      const force = !!body.force;
      const t0 = Date.now();
      let redisMs = null, redisOk = false;
      try { await redis('PING'); redisOk = true; redisMs = Date.now() - t0; } catch {}
      const [od, tpg, walk] = await Promise.all([
        watchOpendata(force).catch((e) => ({ ok: false, err: e.message })),
        getAlerts(force).catch((e) => ({ ok: false, err: e.message, items: [] })),
        watchWalk(force).catch((e) => ({ ok: false, err: e.message }))
      ]);
      const lastCheck = Number(await redis('GET', 'check:last')) || 0;
      const wids = (await redis('SMEMBERS', 'watches')) || [];
      const [subs, backups, admins] = await Promise.all([count('sub:*'), count('backup:*'), redis('SCARD', 'admin:sids')]);
      // Historique 24 h, incidents (en cours + journal), 2e point de vue (GitHub), erreurs vues dans l'app
      const SV = ['opendata', 'tpg', 'walk'];
      const day = Date.now() - 864e5;
      const [h1, h2, h3, o1, o2, o3, incRaw, cliRaw] = await pipeline([
        ...SV.map((k) => ['LRANGE', `mon:hist:${k}`, 0, 700]), ...SV.map((k) => ['GET', `mon:open:${k}`]),
        ['LRANGE', 'mon:inc', 0, 299], ['LRANGE', 'mon:cli', 0, 1999]]);
      const hist = {}; [h1, h2, h3].forEach((l, i) => { hist[SV[i]] = (l || []).map((x) => x.split('|')).filter((x) => +x[0] > day).map((x) => [+x[0], +x[1], +x[2], x[3]]); });
      const open = [o1, o2, o3].filter(Boolean).map((x) => JSON.parse(x));
      const month = Date.now() - 30 * 864e5;
      const incidents = (incRaw || []).map((x) => JSON.parse(x)).filter((x) => x.end > month);
      let ext = null;
      try {
        const r = await fetch('https://raw.githubusercontent.com/MerAdam/not-tpg/monitor-data/ext.json?t=' + Math.floor(Date.now() / 60000), { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const j = await r.json();
          ext = { at: j.at, results: (j.results || []).map((x) => {
            const code = Number(x.code) || 0, p = { svc: x.svc, ok: code >= 200 && code < 300, ms: x.ms, status: code || null, limit: 20000 };
            if (!p.ok) p.kind = !code ? ({ 28: 'timeout', 6: 'dns', 7: 'refused', 35: 'tls', 56: 'reset' }[x.curl] || 'network') : code === 429 ? 'ratelimit' : code === 401 || code === 403 ? 'blocked' : code >= 500 ? 'server' : 'http';
            p.detail = describe(p); return p;
          }) };
        }
      } catch {}
      const cli = (cliRaw || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter((x) => x && x.t > day);
      const agg = {};
      for (const e of cli) {
        const k = e.svc + '|' + e.kind; const a = agg[k] || (agg[k] = { svc: e.svc, kind: e.kind, msg: e.msg, n: 0, devs: new Set(), first: e.t, last: e.t });
        a.n++; a.devs.add(e.dev); a.first = Math.min(a.first, e.t); a.last = Math.max(a.last, e.t); a.msg = a.msg || e.msg;
      }
      const clientErrors = Object.values(agg).map((a) => ({ ...a, devs: a.devs.size })).sort((x, y) => y.last - x.last);
      return res.status(200).json({
        now: Date.now(), hist, open, incidents, ext, clientErrors,
        services: {
          opendata: od,
          tpg: { ok: tpg.ok, err: tpg.err, at: tpg.at, checked: tpg.checked, downSince: tpg.downSince, count: (tpg.items || []).length, diag: tpg.diag || null, manualAt: tpg.manualAt || null },
          walk,
          redis: { ok: redisOk, ms: redisMs },
          check: { ok: Date.now() - lastCheck < 3 * 60000, last: lastCheck }
        },
        totals: { subs, commutes: wids.filter((w) => w.includes(':c:')).length, bells: wids.filter((w) => w.includes(':r:')).length, backups, admins },
        prefs: await getPrefs()
      });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Panneau admin (code admin obligatoire) :
//   POST /api/admin?action=status {code, force}        -> état de tous les services + totaux
//   POST /api/admin?action=prefs  {code, prefs}        -> enregistre les alertes admin voulues
//   POST /api/admin?action=notify {code, sid}          -> notification de test à cet appareil
const { redis, getJSON, setJSON } = require('./_redis');
const { send } = require('./_webpush');
const { getAlerts, isAdminCode } = require('./_tpgsource');
const { probe, watchOpendata, getPrefs, DEFAULT_PREFS } = require('./_monitor');

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
        probe('https://routing.openstreetmap.de/routed-foot/route/v1/driving/6.1432,46.2044;6.1450,46.2050?overview=false', 8000,
          { headers: { 'User-Agent': 'NotTPG/1.0 (https://github.com/MerAdam/not-tpg)' } })
      ]);
      const lastCheck = Number(await redis('GET', 'check:last')) || 0;
      const wids = (await redis('SMEMBERS', 'watches')) || [];
      const [subs, backups, admins] = await Promise.all([count('sub:*'), count('backup:*'), redis('SCARD', 'admin:sids')]);
      return res.status(200).json({
        now: Date.now(),
        services: {
          opendata: od,
          tpg: { ok: tpg.ok, err: tpg.err, at: tpg.at, checked: tpg.checked, downSince: tpg.downSince, count: (tpg.items || []).length },
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

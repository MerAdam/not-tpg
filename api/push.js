// Abonnements aux notifications et éléments surveillés.
//   GET  /api/push?action=key                         -> clé publique VAPID
//   POST /api/push?action=subscribe   {subscription}  -> { sid }
//   POST /api/push?action=unsubscribe {sid}
//   POST /api/push?action=commutes    {sid, commutes} (remplace tous les trajets pendulaires)
//   POST /api/push?action=bell        {sid, run}      -> { wid }
//   POST /api/push?action=unbell      {sid, wid}
//   POST /api/push?action=test        {sid}
const crypto = require('crypto');
const { redis, pipeline, getJSON } = require('./_redis');
const { vapid, send } = require('./_webpush');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAY = 86400;

async function removeWatches(sid, filter) {
  const ids = (await redis('SMEMBERS', `user:${sid}:watches`)) || [];
  const del = ids.filter(filter);
  if (!del.length) return 0;
  await pipeline(del.flatMap((w) => [['DEL', `watch:${w}`], ['SREM', 'watches', w], ['SREM', `user:${sid}:watches`, w]]));
  return del.length;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && req.query.action) || '';
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    if (action === 'key') return res.status(200).json({ publicKey: (await vapid()).publicKey });
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST attendu' });

    if (action === 'subscribe') {
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Abonnement invalide' });
      const sid = sha(sub.endpoint).slice(0, 24);
      await redis('SET', `sub:${sid}`, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, created: Date.now() }));
      return res.status(200).json({ sid });
    }

    const sid = String(body.sid || '').replace(/[^a-f0-9]/g, '');
    const sub = sid && (await getJSON(`sub:${sid}`));
    if (!sub) return res.status(404).json({ error: 'Abonnement inconnu', resubscribe: true });

    if (action === 'unsubscribe') {
      await removeWatches(sid, () => true);
      await pipeline([['DEL', `sub:${sid}`], ['DEL', `user:${sid}:watches`]]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'commutes') {
      await removeWatches(sid, (w) => w.startsWith(`${sid}:c:`));
      const list = Array.isArray(body.commutes) ? body.commutes.slice(0, 30) : [];
      const cmds = [];
      for (const cm of list) {
        if (!cm || !cm.from || !cm.to || !Array.isArray(cm.picks) || !cm.picks.length) continue;
        const wid = `${sid}:c:${sha(JSON.stringify([cm.id, cm.from, cm.to])).slice(0, 12)}`;
        const watch = {
          type: 'commute', sid, from: String(cm.from).slice(0, 120), to: String(cm.to).slice(0, 120),
          days: (cm.days || []).map(Number).filter((d) => d >= 0 && d <= 6),
          picks: cm.picks.slice(0, 20).map((p) => ({ dep: p.dep, arr: p.arr, key: p.key, legs: (p.legs || []).slice(0, 6) }))
        };
        cmds.push(['SET', `watch:${wid}`, JSON.stringify(watch)], ['SADD', 'watches', wid], ['SADD', `user:${sid}:watches`, wid]);
      }
      await pipeline(cmds);
      return res.status(200).json({ ok: true, count: cmds.length / 3 });
    }

    if (action === 'bell') {
      const r = body.run || {};
      const planned = Date.parse(r.planned);
      if (!r.stopId || !r.line || isNaN(planned)) return res.status(400).json({ error: 'Départ invalide' });
      const wid = `${sid}:r:${sha([r.stopId, r.line, r.to, r.planned].join('|')).slice(0, 12)}`;
      const watch = {
        type: 'run', sid, stopId: String(r.stopId), stopName: String(r.stopName || '').slice(0, 120),
        line: String(r.line).slice(0, 8), cat: String(r.cat || '').slice(0, 8), to: String(r.to || '').slice(0, 120), planned: r.planned
      };
      const ttl = Math.max(600, Math.round((planned - Date.now()) / 1000) + 3 * 3600);
      await pipeline([['SET', `watch:${wid}`, JSON.stringify(watch), 'EX', ttl], ['SADD', 'watches', wid], ['SADD', `user:${sid}:watches`, wid]]);
      const t = new Date(planned).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });
      await send(sub, { title: 'Suivi activé', body: `Ligne ${watch.line} de ${t} à ${watch.stopName.replace(/^Genève,\s*/, '')} → ${watch.to.replace(/^Genève,\s*/, '')}. Tu seras prévenu de tout changement.`, tag: wid });
      return res.status(200).json({ wid });
    }

    if (action === 'unbell') {
      const wid = String(body.wid || '');
      await removeWatches(sid, (w) => w === wid);
      return res.status(200).json({ ok: true });
    }

    if (action === 'test') {
      const r = await send(sub, { title: 'Not TPG', body: 'Les notifications fonctionnent.', tag: 'test' });
      if (r === 'gone') return res.status(410).json({ error: 'Abonnement expiré', resubscribe: true });
      return res.status(200).json({ ok: r === 'ok' });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports.DAY = DAY;

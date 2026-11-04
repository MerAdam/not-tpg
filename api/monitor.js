// Erreurs vues dans l'app, envoyées anonymement par les téléphones :
//   POST /api/monitor?action=report {dev, errors:[{t, svc, kind, msg}]}      -> erreurs vues dans l'app (anonymes)
const { pipeline } = require('./_redis');

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const SVCS = ['opendata', 'tpg', 'walk', 'backup', 'push', 'infotrafic', 'app'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST attendu' });
  const action = (req.query && req.query.action) || '';
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    if (action === 'report') {
      const dev = clip(body.dev, 12).replace(/[^a-z0-9]/gi, '');
      const errs = (Array.isArray(body.errors) ? body.errors : []).slice(0, 20)
        .filter((e) => e && SVCS.includes(e.svc))
        .map((e) => JSON.stringify({ t: Math.min(Date.now(), Number(e.t) || Date.now()), dev, svc: e.svc, kind: clip(e.kind, 30), msg: clip(e.msg, 140) }));
      if (!dev || !errs.length) return res.status(200).json({ ok: true });
      await pipeline([['LPUSH', 'mon:cli', ...errs], ['LTRIM', 'mon:cli', 0, 1999]]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

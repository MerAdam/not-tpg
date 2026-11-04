// Erreurs vues dans l'app, envoyées anonymement par les téléphones :
//   POST /api/monitor?action=report {dev, errors:[{t, svc, kind, msg}]}      -> erreurs vues dans l'app (anonymes)
//   POST /api/monitor?action=ext                                             -> appelé par GitHub après son test : on relit
//        son résultat (branche monitor-data) et on prévient les admins (1er résultat, puis seulement si ça change)
const { pipeline, getJSON, setJSON } = require('./_redis');
const { notifyAdmins, describe } = require('./_monitor');

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const SVCS = ['opendata', 'tpg', 'walk', 'backup', 'push', 'infotrafic', 'app'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST attendu' });
  const action = (req.query && req.query.action) || '';
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    if (action === 'ext') {
      const r = await fetch('https://api.github.com/repos/MerAdam/not-tpg/contents/ext.json?ref=monitor-data', { headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'NotTPG' } });
      if (!r.ok) return res.status(200).json({ ok: false });
      const j = await r.json();
      const last = (await getJSON('mon:extnotified')) || null;
      if (last && last.at >= j.at) return res.status(200).json({ ok: true, already: true });
      const name = { opendata: 'Horaires', tpg: 'Info trafic tpg.ch', walk: 'Itinéraires à pied' };
      const lines = (j.results || []).map((x) => {
        const code = Number(x.code) || 0, ok = code >= 200 && code < 300;
        const p = { ok, status: code || null, limit: 20000, kind: ok ? null : !code ? ({ 28: 'timeout', 6: 'dns', 7: 'refused' }[x.curl] || 'network') : code === 429 ? 'ratelimit' : code === 401 || code === 403 ? 'blocked' : code >= 500 ? 'server' : 'http' };
        return { svc: x.svc, ok, txt: (name[x.svc] || x.svc) + ' : ' + (ok ? 'OK' : describe(p).split(' (')[0].split(' :')[0] + (code ? '' : '')) };
      });
      const sig = lines.map((l) => l.svc + (l.ok ? 1 : 0)).join(',');
      await setJSON('mon:extnotified', { at: j.at, sig });
      if (!last || last.sig !== sig) {
        await notifyAdmins('extResult', { title: last ? 'Test GitHub : la situation a changé' : 'Résultat du test GitHub', body: lines.map((l) => l.txt).join(' · ') + '. Détails dans le panneau admin.', tag: 'ext-result' });
      }
      return res.status(200).json({ ok: true, notified: !last || last.sig !== sig });
    }
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

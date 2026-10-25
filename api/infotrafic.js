// Info trafic tpg en cours (source : tpg.ch), mise en cache 60 s sur le CDN de Vercel.
const { parse } = require('./_infotrafic');

module.exports = async (req, res) => {
  try {
    const r = await fetch('https://www.tpg.ch/fr/getInfoTrafic', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NotTPG/1.0)',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json'
      }
    });
    if (!r.ok) throw Object.assign(new Error('tpg.ch HTTP ' + r.status), { status: r.status });
    const { items } = parse(await r.json());
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=86400');
    return res.status(200).json({ source: 'tpg.ch', fetchedAt: new Date().toISOString(), alerts: items });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: e.message });
  }
};

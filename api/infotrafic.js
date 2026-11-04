// Info trafic tpg en cours (source : tpg.ch, interrogé au plus toutes les 5 min, voir _tpgsource).
const { getAlerts } = require('./_tpgsource');

module.exports = async (req, res) => {
  try {
    const d = await getAlerts();
    if (!d.ok && !d.items.length) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: d.err || 'tpg.ch indisponible' });
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=120');
    // stale : liste gardée de la dernière réponse réussie de tpg.ch (at = son heure)
    return res.status(200).json({ source: 'tpg.ch', fetchedAt: new Date(d.at).toISOString(), at: d.at, stale: !d.ok, error: d.ok ? null : d.err, alerts: d.items });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: e.message });
  }
};

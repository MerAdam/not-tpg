// Info trafic tpg en cours (source : tpg.ch, interrogé au plus toutes les 5 min, voir _tpgsource).
const { getAlerts } = require('./_tpgsource');
const { parse } = require('./_infotrafic');

module.exports = async (req, res) => {
  // Test : le téléphone a lu tpg.ch lui-même et envoie la réponse brute, on la met au format de l'app
  // (rien n'est enregistré : la liste ne sert qu'à cet appareil)
  if (req.method === 'POST' && req.query && req.query.action === 'parse') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const raw = req.body && typeof req.body === 'object' ? req.body.raw : null;
      const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json({ alerts: parse(json).items });
    } catch (e) { return res.status(400).json({ error: 'Format inattendu : ' + e.message }); }
  }
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

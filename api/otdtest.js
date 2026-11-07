// Test temporaire : que contient le flux national de perturbations (opentransportdata.swiss) pour Genève / tpg ?
//   GET /api/otdtest
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const keyP = process.env.OTD_SIRI_SX_KEY || process.env.OTD_API_KEY, keyU = process.env.OTD_SIRI_SX_UNPLANNED_KEY || keyP;
  const feeds = [
    ['SIRI-SX (prévues)', 'https://api.opentransportdata.swiss/la/siri-sx', keyP],
    ['SIRI-SX (imprévues)', 'https://api.opentransportdata.swiss/la/siri-sx-unplanned', keyU],
    ['GTFS-RT alertes', 'https://api.opentransportdata.swiss/la/gtfs-sa', keyP],
    ['GTFS-RT alertes (clé 2)', 'https://api.opentransportdata.swiss/la/gtfs-sa', keyU]
  ];
  const out = { cles: { prevues: !!keyP, imprevues: !!keyU }, flux: [] };
  for (const [name, url, key] of feeds) {
    const f = { flux: name };
    if (!key) { f.resultat = 'pas de clé'; out.flux.push(f); continue; }
    try {
      const r = await fetch(url, { headers: { Authorization: key.startsWith('Bearer') ? key : 'Bearer ' + key, Accept: 'application/xml, application/json, */*' }, signal: AbortSignal.timeout(20000) });
      f.http = r.status; f.type = r.headers.get('content-type');
      const buf = Buffer.from(await r.arrayBuffer()); f.taille = buf.length;
      const txt = buf.toString('utf8');
      if (!r.ok) { f.resultat = 'erreur'; f.apercu = txt.slice(0, 200); out.flux.push(f); continue; }
      // Découpe grossière en « situations » / « alertes » et recherche de Genève / tpg
      const parts = txt.split(/<(?:\w+:)?PtSituationElement[\s>]/).slice(1);
      const items = parts.length ? parts : txt.split(/(?=\n?\s*entity\s*\{)|(?=\x0a\x12)/).slice(1);
      f.total = items.length;
      const geo = items.filter((x) => /tpg|Genève|Geneve|Genf|Cornavin|Carouge|Vernier|Meyrin|Lancy|Onex|Thônex/i.test(x));
      f.geneve = geo.length;
      f.tpgOperateur = items.filter((x) => /(OperatorRef|ParticipantRef|agency_id)[^<\n]{0,40}(tpg|881|85:881)/i.test(x)).length;
      f.exemples = geo.slice(0, 6).map((x) => {
        const sum = (x.match(/<(?:\w+:)?Summary[^>]*>([^<]{5,300})/) || [])[1] || (x.match(/<(?:\w+:)?Description[^>]*>([^<]{5,300})/) || [])[1];
        const clean = (sum || x.replace(/<[^>]+>/g, ' ')).replace(/[^\x20-\x7EÀ-ſ’'«»–-]/g, ' ').replace(/\s+/g, ' ').trim();
        return clean.slice(0, 220);
      });
      f.resultat = 'ok';
    } catch (e) { f.resultat = 'échec : ' + e.message; }
    out.flux.push(f);
  }
  return res.status(200).json(out);
};

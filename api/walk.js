// Itinéraires piétons. Avec une clé OpenRouteService (variable ORS_API_KEY), on l'utilise ;
// sinon, ou si elle échoue, on passe par le serveur piéton public d'OpenStreetMap
// (routing.openstreetmap.de, sans clé, usage modéré).
//   GET /api/walk?action=matrix&from=lat,lon&to=lat,lon|lat,lon|…  -> { durations:[s], distances:[m] }
//   GET /api/walk?action=route&from=lat,lon&to=lat,lon             -> { coords:[[lat,lon]], duration, distance }
const ORS = 'https://api.openrouteservice.org';

const pt = (s) => {
  const [a, b] = String(s || '').split(',').map(Number);
  if (!isFinite(a) || !isFinite(b) || a < 45 || a > 48 || b < 5 || b > 11) return null;
  return [Math.round(b * 1e4) / 1e4, Math.round(a * 1e4) / 1e4]; // [lon, lat], ~10 m
};

const OSRM = 'https://routing.openstreetmap.de/routed-foot';
const UA = { 'User-Agent': 'NotTPG/1.0 (https://github.com/MerAdam/not-tpg)' };

async function osrm(action, from, to) {
  if (action === 'matrix') {
    const coords = [from, ...to].map((c) => c.join(',')).join(';');
    const r = await fetch(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, { headers: UA });
    const j = await r.json();
    if (!r.ok || j.code !== 'Ok') throw new Error('OSRM ' + (j.message || r.status));
    return { durations: j.durations[0].slice(1), distances: j.distances[0].slice(1), source: 'osm' };
  }
  const r = await fetch(`${OSRM}/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson`, { headers: UA });
  const j = await r.json();
  if (!r.ok || j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('OSRM ' + (j.message || r.status));
  const rt = j.routes[0];
  return { coords: rt.geometry.coordinates.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]), duration: rt.duration, distance: rt.distance, source: 'osm' };
}

module.exports = async (req, res) => {
  const key = process.env.ORS_API_KEY;
  const q = req.query || {};
  const from = pt(q.from);
  if (!from) return res.status(400).json({ error: 'Point de départ invalide' });
  const fallback = async () => {
    const to = q.action === 'matrix' ? String(q.to || '').split('|').map(pt).filter(Boolean).slice(0, 24) : pt(q.to);
    if (!to || (Array.isArray(to[0]) && !to.length)) return res.status(400).json({ error: 'Destination invalide' });
    try {
      const out = await osrm(q.action, from, to);
      res.setHeader('Cache-Control', q.action === 'matrix' ? 'public, max-age=300, s-maxage=86400' : 'public, max-age=3600, s-maxage=604800');
      return res.status(200).json(out);
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: e.message });
    }
  };
  if (!key) return fallback();
  try {
    if (q.action === 'matrix') {
      const to = String(q.to || '').split('|').map(pt).filter(Boolean).slice(0, 24);
      if (!to.length) return res.status(400).json({ error: 'Destinations invalides' });
      const r = await fetch(`${ORS}/v2/matrix/foot-walking`, {
        method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations: [from, ...to], sources: [0], destinations: to.map((_, i) => i + 1), metrics: ['duration', 'distance'] })
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error((j.error && (j.error.message || j.error)) || 'ORS ' + r.status), { status: r.status });
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400');
      return res.status(200).json({ durations: j.durations[0], distances: j.distances[0] });
    }
    if (q.action === 'route') {
      const to = pt(q.to);
      if (!to) return res.status(400).json({ error: 'Arrivée invalide' });
      const r = await fetch(`${ORS}/v2/directions/foot-walking/geojson`, {
        method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: [from, to] })
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error((j.error && (j.error.message || j.error)) || 'ORS ' + r.status), { status: r.status });
      const f = j.features && j.features[0];
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=604800');
      return res.status(200).json({
        coords: f.geometry.coordinates.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]),
        duration: f.properties.summary.duration, distance: f.properties.summary.distance
      });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return fallback(); // clé invalide, quota dépassé ou service en panne
  }
};

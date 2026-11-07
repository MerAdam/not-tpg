// Sauvegarde des réglages (favoris, trajets pendulaires, filtres, préférences) dans Redis,
// protégée par un nom + un code PIN choisis par l'utilisateur.
//   POST /api/backup?action=save    {name, pin, data}  -> { ok, at }   (crée la sauvegarde si le nom est libre)
//   POST /api/backup?action=load    {name, pin}        -> { data, at }
//   POST /api/backup?action=delete  {name, pin}        -> { ok }  (supprime la sauvegarde : nom et code libérés)
const crypto = require('crypto');
const { redis, getJSON, setJSON } = require('./_redis');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST attendu' });
  const action = (req.query && req.query.action) || '';
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    const name = norm(body.name), pin = String(body.pin || '').replace(/\D/g, '');
    if (name.length < 3) return res.status(400).json({ error: 'Choisis un nom d’au moins 3 caractères.' });
    if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: 'Le code doit faire 4 à 8 chiffres.' });
    const key = 'backup:' + sha(name), failKey = 'backupfail:' + sha(name);
    const fails = Number(await redis('GET', failKey)) || 0;
    if (fails >= 10) return res.status(429).json({ error: 'Trop d’essais. Réessaie dans une heure.' });
    const cur = await getJSON(key);
    const pinOk = cur && cur.pin === sha(name + ':' + pin);
    if (cur && !pinOk) {
      await redis('INCR', failKey); await redis('EXPIRE', failKey, 3600);
      return res.status(403).json({ error: action === 'save' && body.create ? 'Ce nom est déjà utilisé. Choisis-en un autre (ou entre le bon code).' : 'Nom ou code incorrect.' });
    }

    if (action === 'delete') {
      if (!cur) return res.status(404).json({ error: 'Aucune sauvegarde à ce nom.' });
      await redis('DEL', key); await redis('DEL', failKey);
      return res.status(200).json({ ok: true });
    }
    if (action === 'load') {
      if (!cur) return res.status(404).json({ error: 'Aucune sauvegarde à ce nom.' });
      return res.status(200).json({ data: cur.data, at: cur.at });
    }
    if (action === 'save') {
      if (!body.create && !cur) return res.status(404).json({ error: 'Cette sauvegarde a été supprimée.', gone: true });
      if (body.create && cur) return res.status(409).json({ exists: true, at: cur.at, error: 'Une sauvegarde existe déjà à ce nom.' });
      const data = body.data && typeof body.data === 'object' ? body.data : null;
      if (!data) return res.status(400).json({ error: 'Rien à sauvegarder' });
      const json = JSON.stringify(data);
      if (json.length > 200000) return res.status(413).json({ error: 'Sauvegarde trop grosse' });
      const at = Date.now();
      await setJSON(key, { pin: sha(name + ':' + pin), data, at });
      return res.status(200).json({ ok: true, at, created: !cur });
    }
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

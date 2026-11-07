// Test simple, sans base de données : est-ce que ce serveur peut lire l'info trafic de tpg.ch ?
//   GET /api/tpgtest  -> { ok, status, ms, protection, apercu }
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  try {
    const r = await fetch('https://www.tpg.ch/fr/getInfoTrafic', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotTPG/1.0)', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const text = await r.text();
    const out = { ok: r.ok, status: r.status, ms: Date.now() - t0, region: process.env.VERCEL_REGION || null,
      protection: r.headers.get('x-iinfo') ? 'Imperva' : r.headers.get('cf-ray') ? 'Cloudflare' : null };
    if (r.ok) { try { const j = JSON.parse(text); out.resultat = 'Ça marche ! tpg.ch répond à ce serveur.'; out.taille = Array.isArray(j) ? j.length + ' éléments' : Object.keys(j).length + ' clés'; } catch { out.resultat = 'Réponse reçue mais pas au format attendu'; } }
    else out.resultat = 'Bloqué : tpg.ch refuse ce serveur (HTTP ' + r.status + ').';
    out.apercu = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, ms: Date.now() - t0, resultat: 'Pas de réponse : ' + (e.name === 'TimeoutError' ? 'délai dépassé' : e.message) });
  }
};

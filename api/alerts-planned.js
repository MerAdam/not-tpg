// Toutes les perturbations, travaux et déviations planifiés compris (SIRI-SX complet).
// Plan : 48 appels/jour, 10/heure -> cache CDN de 30 min.
const { handle } = require('./_siri');

module.exports = (req, res) => handle(req, res, {
  kind: 'all',
  key: process.env.OTD_SIRI_SX_KEY || process.env.OTD_API_KEY,
  urls: [process.env.OTD_SIRI_SX_URL, 'https://api.opentransportdata.swiss/la/siri-sx'].filter(Boolean),
  maxAge: 1800
});

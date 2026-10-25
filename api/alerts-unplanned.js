// Incidents imprévus en cours (SIRI-SX unplanned).
// Plan : 3000 appels/jour, 2/minute -> cache CDN de 60 s.
const { handle } = require('./_siri');

module.exports = (req, res) => handle(req, res, {
  kind: 'unplanned',
  key: process.env.OTD_SIRI_SX_UNPLANNED_KEY || process.env.OTD_API_KEY,
  urls: [
    process.env.OTD_SIRI_SX_UNPLANNED_URL,
    'https://api.opentransportdata.swiss/la/siri-sx-unplanned',
    'https://api.opentransportdata.swiss/la/siri-sx/unplanned'
  ].filter(Boolean),
  maxAge: 60
});

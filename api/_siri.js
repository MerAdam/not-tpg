// Lecture des perturbations SIRI-SX (opentransportdata.swiss) et filtrage réseau tpg.
// Utilisé par api/alerts-unplanned.js et api/alerts-planned.js.
// Aucune dépendance : le XML SIRI est lu avec des expressions régulières simples.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  })
  .replace(/<[^>]+>/g, ' ') // balises HTML éventuelles dans les textes
  .replace(/\s+/g, ' ')
  .trim();

// Retire les préfixes d'espace de noms (<siri:Foo> -> <Foo>)
const stripNs = (xml) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

function blocks(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1] || '');
  return out;
}
const first = (xml, tag) => { const b = blocks(xml, tag); return b.length ? b[0] : ''; };

// Textes multilingues : <SummaryText xml:lang="FR">…</SummaryText>
function texts(xml, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) {
    const lang = ((m[1].match(/lang="([^"]+)"/i) || [])[1] || '').toLowerCase();
    out.push({ lang, text: decode(m[2]) });
  }
  return out.filter((t) => t.text);
}
function pickLang(list) {
  if (!list.length) return [];
  for (const l of ['fr', 'de', 'en', 'it', '']) {
    const hit = list.filter((t) => t.lang.startsWith(l));
    if (hit.length) return [...new Set(hit.map((t) => t.text))];
  }
  return [...new Set(list.map((t) => t.text))];
}

// « ch:1:sloid:87387:0:1 » ou « 8587387 » -> identifiant DIDOK « 8587387 »
function didok(ref) {
  const s = String(ref || '');
  let m = s.match(/sloid:(\d+)/);
  if (m) return '85' + m[1].padStart(5, '0');
  m = s.match(/(?:^|:)(85\d{5})(?::|$)/);
  if (m) return m[1];
  m = s.match(/^\d{7}$/);
  return m ? s : null;
}

function parseSituation(x) {
  const progress = decode(first(x, 'Progress')).toLowerCase();
  const periods = blocks(x, 'ValidityPeriod').map((p) => [decode(first(p, 'StartTime')) || null, decode(first(p, 'EndTime')) || null]);
  const lines = new Set(), operators = new Set(), stops = new Set(), stopNames = new Set();
  for (const al of blocks(x, 'AffectedLine')) {
    const name = pickLang(texts(al, 'PublishedLineName'))[0] || decode(first(al, 'PublishedLineName'));
    if (name) lines.add(name.trim().toUpperCase());
    for (const op of blocks(al, 'OperatorRef')) operators.add(decode(op));
  }
  for (const op of blocks(x, 'AffectedOperator')) { const r = decode(first(op, 'OperatorRef')); if (r) operators.add(r); }
  for (const tag of ['StopPointRef', 'StopPlaceRef']) {
    for (const r of blocks(x, tag)) { const d = didok(decode(r)); if (d) stops.add(d); }
  }
  for (const tag of ['StopPointName', 'StopPlaceName', 'PlaceName']) for (const n of pickLang(texts(x, tag))) stopNames.add(n);

  const summary = pickLang(texts(x, 'SummaryText')).concat(pickLang(texts(x, 'Summary')));
  const description = pickLang(texts(x, 'DescriptionText')).concat(pickLang(texts(x, 'Description')));
  return {
    id: decode(first(x, 'SituationNumber')) || null,
    version: decode(first(x, 'Version')) || null,
    participant: decode(first(x, 'ParticipantRef')) || null,
    closed: progress === 'closed',
    planned: decode(first(x, 'Planned')).toLowerCase() === 'true',
    cause: decode(first(x, 'AlertCause')) || null,
    updated: decode(first(x, 'VersionedAtTime')) || decode(first(x, 'CreationTime')) || null,
    periods,
    lines: [...lines], operators: [...operators], stops: [...stops], stopNames: [...stopNames].slice(0, 30),
    title: summary[0] || null,
    text: [...new Set(description)].filter((t) => t !== summary[0]).join('\n\n') || null,
    reason: pickLang(texts(x, 'ReasonText'))[0] || null,
    consequence: pickLang(texts(x, 'ConsequenceText')).join('\n') || null,
    recommendation: pickLang(texts(x, 'RecommendationText')).join('\n') || null,
    duration: pickLang(texts(x, 'DurationText'))[0] || null
  };
}

function parseSiri(xmlRaw) {
  const xml = stripNs(xmlRaw);
  return blocks(xml, 'PtSituationElement').map(parseSituation).filter((s) => !s.closed);
}

// Garde les perturbations du réseau tpg :
//  1. celles qui touchent au moins un arrêt tpg (liste officielle data/stops.json) ;
//  2. celles qui n'ont que des lignes : on reconnaît l'opérateur tpg à partir des
//     perturbations du cas 1 (même OperatorRef) et on vérifie que la ligne existe chez les tpg.
function filterTpg(situations, tpgStops, tpgLines) {
  const tpgOps = new Set();
  const byStop = situations.filter((s) => s.stops.some((d) => tpgStops.has(d)));
  for (const s of byStop) if (s.lines.length && s.lines.every((l) => tpgLines.has(l))) s.operators.forEach((o) => tpgOps.add(o));
  const kept = situations.filter((s) => {
    if (s.stops.some((d) => tpgStops.has(d))) return true;
    if (!s.stops.length && s.lines.length && s.operators.some((o) => tpgOps.has(o) || /tpg|genevois/i.test(o))) return true;
    return false;
  });
  // On ne garde que les arrêts tpg et les lignes tpg dans chaque perturbation
  return kept.map((s) => ({
    ...s,
    stops: s.stops.filter((d) => tpgStops.has(d)),
    lines: s.lines.filter((l) => tpgLines.has(l)),
    operators: undefined, participant: undefined, closed: undefined
  }));
}

let refCache = null;
async function loadRefs(req) {
  if (refCache && Date.now() - refCache.at < 6 * 3600e3) return refCache;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const [stops, lines] = await Promise.all([
    fetch(base + '/data/stops.json').then((r) => r.json()),
    fetch(base + '/data/lines.json').then((r) => r.json()).catch(() => ({ lines: {} }))
  ]);
  refCache = {
    at: Date.now(),
    stops: new Set((stops.stops || []).map((s) => String(s.id))),
    lines: new Set(Object.keys(lines.lines || {}).map((k) => k.toUpperCase()))
  };
  return refCache;
}

async function fetchSiri(urls, key) {
  let last = null;
  for (const url of urls) {
    for (const auth of [`Bearer ${key}`, key]) {
      const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/xml', 'Accept-Encoding': 'gzip' } });
      if (r.status === 401 || r.status === 403) { last = r.status; continue; }
      if (r.status === 404) { last = 404; break; }
      if (!r.ok) { const e = new Error('SIRI HTTP ' + r.status); e.status = r.status; throw e; }
      return r.text();
    }
  }
  const e = new Error('SIRI HTTP ' + last); e.status = last; throw e;
}

async function handle(req, res, { urls, key, maxAge, kind }) {
  if (!key) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'Clé API manquante dans Vercel' });
  }
  try {
    const [xml, refs] = await Promise.all([fetchSiri(urls, key), loadRefs(req)]);
    const all = parseSiri(xml);
    const alerts = filterTpg(all, refs.stops, refs.lines);
    // Cache sur le CDN de Vercel : protège les quotas de l'API
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}, stale-if-error=86400`);
    const body = { kind, fetchedAt: new Date().toISOString(), total: all.length, alerts };
    if (req.query && req.query.debug) {
      body.debug = {
        participants: count(all.map((s) => s.participant)),
        operators: count(all.flatMap((s) => s.operators || [])),
        sample: all.slice(0, 2)
      };
    }
    return res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.status === 429 ? 429 : 502).json({ error: e.message });
  }
}
function count(arr) {
  const m = {}; for (const a of arr) if (a) m[a] = (m[a] || 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15));
}

module.exports = { handle, parseSiri, filterTpg, didok };

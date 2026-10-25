// Lecture de l'info trafic publiée par les tpg (même source que la page
// https://www.tpg.ch/fr/voyager/info-trafic/info-trafic).
// Le flux national SIRI-SX ne contient pas les perturbations tpg, d'où cette source.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', eacute: 'é', egrave: 'è', agrave: 'à' };
const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  })
  .replace(/\s+/g, ' ')
  .trim();

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return (h >>> 0).toString(36); }

// « Travaux - La ligne est déviée en direction de X entre A et B. Arrêt(s) non-desservi(s) : … »
function parseDescription(desc) {
  let cause = null, body = desc;
  const m = desc.match(/^([^-–]{2,40}?)\s+[-–]\s+(.*)$/s);
  if (m) { cause = m[1].trim(); body = m[2].trim(); }
  // Retire les mentions vides du type « Arrêt(s) déplacé(s) : . »
  body = body.replace(/Arrêt\(s\)[^:.]*:\s*\.\s*/g, '').replace(/\s+\./g, '.').trim();
  const sentences = body.split(/(?<=\.)\s+(?=[A-ZÀ-Ý])/);
  const title = sentences.shift() || body;
  const text = sentences.join(' ').trim() || null;
  const dir = (body.match(/en direction (?:de |d’|d'|du |des )?(.+?)(?:,| entre | est | n’est | n'est |\.|$)/i) || [])[1] || null;
  const stopLists = [];
  for (const mm of body.matchAll(/Arrêt\(s\)\s+([^:]+?)\s*:\s*([^.]+)\./g)) stopLists.push({ kind: mm[1].trim(), names: [mm[2].trim()] }); // la virgule fait partie des noms (« Grand-Saconnex, Crêts-Morillon »)
  const single = body.match(/^Arrêt (.+?) en direction/);
  if (single) stopLists.push({ kind: /déplacé/.test(body) ? 'déplacé' : 'non desservi', names: [single[1].trim()] });
  return { cause, title, text, direction: dir ? dir.trim() : null, stopLists };
}

function parse(json) {
  const html = json.disruptions_full_html || '';
  const items = [];
  for (const li of html.split(/<li\b[^>]*>/).slice(1)) {
    const lines = [...li.matchAll(/class="[^"]*line-logo[^"]*"[^>]*>\s*<span>([^<]+)<\/span>/g)].map((m) => decode(m[1]).toUpperCase());
    const descM = li.match(/disruptions-container__description[^>]*>([\s\S]*?)<\/div>/);
    const desc = descM ? decode(descM[1]) : '';
    if (!desc) continue;
    const p = parseDescription(desc);
    items.push({ id: 't' + hash(lines.join(',') + '|' + desc), lines, raw: desc, ...p, periods: [] });
  }
  // Heure de début par ligne (champ « time » de disruptions_raw), à titre indicatif
  const since = {};
  for (const r of Object.values(json.disruptions_raw || {})) {
    const l = String(r.line_id || '').toUpperCase();
    if (l && r.time && (!since[l] || r.time < since[l])) since[l] = r.time;
  }
  return { items, since };
}

module.exports = { parse, parseDescription };

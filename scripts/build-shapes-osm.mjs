#!/usr/bin/env node
// scripts/build-shapes-osm.mjs
//
// Tracés des lignes tpg depuis OpenStreetMap (relations « route » bus/tram/trolleybus
// autour de Genève, via l'API Overpass). Sortie : data/shapes.json
//   { generated, lines: { "<ligne>": [ { from, to, t: [[lat,lon], …] } ] } }
// Le fichier n'est pas écrasé si le résultat paraît incomplet.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const BBOX = '46.05,5.85,46.40,6.40'; // Genève + France voisine
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const QUERY = `[out:json][timeout:240];
(
  relation["type"="route"]["route"~"^(bus|tram|trolleybus)$"]["network"~"tpg|unireso|Léman",i](${BBOX});
  relation["type"="route"]["route"~"^(bus|tram|trolleybus)$"]["operator"~"tpg|Transports Publics Genevois",i](${BBOX});
);
out geom;`;

const lines = existsSync('data/lines.json') ? Object.keys(JSON.parse(readFileSync('data/lines.json', 'utf8')).lines || {}) : [];
const tpgLines = new Set(lines.map((l) => l.toUpperCase()));

async function overpass() {
  let last;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(QUERY), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NotTPG/1.0 (github.com/MerAdam/not-tpg)' } });
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; console.log('• ' + e.message); }
  }
  throw last;
}

const key = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);
// Assemble les tronçons d'une relation dans l'ordre, en les retournant si besoin
function stitch(ways) {
  const segs = ways.map((w) => w.geometry.map((g) => [g.lat, g.lon])).filter((g) => g.length > 1);
  if (!segs.length) return [];
  let line = segs[0].slice();
  for (let i = 1; i < segs.length; i++) {
    let s = segs[i];
    const end = key(line[line.length - 1]), start = key(line[0]);
    if (key(s[0]) === end) line.push(...s.slice(1));
    else if (key(s[s.length - 1]) === end) line.push(...s.slice().reverse().slice(1));
    else if (i === 1 && (key(s[0]) === start || key(s[s.length - 1]) === start)) {
      line.reverse(); // le premier tronçon était à l'envers
      if (key(s[0]) === key(line[line.length - 1])) line.push(...s.slice(1)); else line.push(...s.slice().reverse().slice(1));
    } else {
      // trou dans la relation : on raccorde au plus proche des deux bouts
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const last = line[line.length - 1];
      if (d(last, s[s.length - 1]) < d(last, s[0])) s = s.slice().reverse();
      line.push(...s);
    }
  }
  return line;
}
// Simplification (Douglas-Peucker, ~4 m)
function simplify(pts, tol = 0.00004) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let idx = -1, max = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L; if (d > max) { max = d; idx = i; } }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
}

const j = await overpass();
const out = {};
let n = 0;
for (const el of j.elements || []) {
  if (el.type !== 'relation') continue;
  const ref = String(el.tags.ref || '').trim().toUpperCase();
  if (!ref || (tpgLines.size && !tpgLines.has(ref))) continue;
  const ways = (el.members || []).filter((m) => m.type === 'way' && m.geometry && !/platform|stop/.test(m.role || ''));
  const t = simplify(stitch(ways));
  if (t.length < 2) continue;
  (out[ref] ||= []).push({ from: el.tags.from || '', to: el.tags.to || '', t });
  n++;
}
console.log(`• OSM : ${n} parcours, ${Object.keys(out).length} lignes`);
if (n < 40) { console.log('• shapes.json non mis à jour (résultat incomplet)'); process.exit(0); }
writeFileSync('data/shapes.json', JSON.stringify({ generated: new Date().toISOString(), source: 'OpenStreetMap', lines: out }));

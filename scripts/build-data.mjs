#!/usr/bin/env node
// scripts/build-data.mjs
//
// Génère les données statiques de Not TPG à partir des sources officielles :
//   data/stops.json  — arrêts desservis par au moins une course tpg
//                      (GTFS officiel suisse, opentransportdata.swiss)
//   data/lines.json  — couleurs des lignes tpg (liste des lignes sur tpg.ch,
//                      complétée par le GTFS si celui-ci contient des couleurs)
//   data/build-report.json — rapport de la dernière génération
//
// Lancé automatiquement par .github/workflows/update-data.yml (aucune dépendance,
// Node 20+, `curl` et `unzip` requis). Un fichier n'est jamais écrasé si le
// résultat paraît incomplet.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import vm from 'node:vm';

const OUT = 'data';
const ZIP = process.env.GTFS_ZIP || '/tmp/gtfs.zip';
const MIN_STOPS = 200;
const MIN_LINES = 20;
const AGENCY_RE = /genevois|\btpg\b|tpg\.ch/i;

mkdirSync(OUT, { recursive: true });
const report = { startedAt: new Date().toISOString(), gtfsUrl: null, agencies: [], counts: {}, colors: {}, notes: [] };
const note = (m) => { console.log('• ' + m); report.notes.push(m); };

// ---------- CSV ----------
function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function readTable(file, onRow) {
  const proc = spawn('unzip', ['-p', ZIP, file]);
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let idx = null; let n = 0;
  for await (let line of rl) {
    if (!line) continue;
    if (!idx) {
      line = line.replace(/^﻿/, '');
      idx = Object.fromEntries(splitCsv(line).map((h, i) => [h.trim(), i]));
      continue;
    }
    n++;
    onRow(splitCsv(line), idx);
  }
  return n;
}

// ---------- GTFS ----------
function timetableYears() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const ty = d.getUTCMonth() === 11 && d.getUTCDate() >= 13 ? y + 1 : y;
  return [ty, ty - 1];
}

function downloadGtfs() {
  if (process.env.GTFS_URL) {
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', ZIP, process.env.GTFS_URL], { stdio: 'inherit' });
    return process.env.GTFS_URL;
  }
  for (const y of timetableYears()) {
    const url = `https://data.opentransportdata.swiss/dataset/timetable-${y}-gtfs2020/permalink`;
    try {
      execFileSync('curl', ['-sSfL', '--retry', '3', '-o', ZIP, url], { stdio: 'inherit' });
      execFileSync('unzip', ['-l', ZIP], { stdio: 'ignore' });
      return url;
    } catch { note(`GTFS ${y} indisponible`); }
  }
  throw new Error('Aucun GTFS téléchargeable');
}

function kindOf(t) {
  t = Number(t);
  if (t === 0 || (t >= 900 && t < 1000)) return 't'; // tram
  if (t === 3 || (t >= 700 && t < 800)) return 'b';  // bus
  if (t === 4 || (t >= 1000 && t < 1100) || t === 1200) return 'n'; // bateau
  return 'b';
}

async function buildFromGtfs() {
  report.gtfsUrl = downloadGtfs();
  note(`GTFS : ${report.gtfsUrl} (${Math.round(statSync(ZIP).size / 1e6)} Mo)`);

  const agencyIds = new Set();
  await readTable('agency.txt', (r, i) => {
    const hay = [r[i.agency_name], r[i.agency_id], r[i.agency_url]].join(' ');
    if (AGENCY_RE.test(hay)) { agencyIds.add(r[i.agency_id]); report.agencies.push(`${r[i.agency_name]} [${r[i.agency_id]}]`); }
  });
  if (!agencyIds.size) throw new Error('Agence tpg introuvable dans agency.txt');

  const routes = new Map(); // route_id -> { short, kind, color, text }
  await readTable('routes.txt', (r, i) => {
    if (!agencyIds.has(r[i.agency_id])) return;
    routes.set(r[i.route_id], {
      short: (r[i.route_short_name] || '').trim(),
      kind: kindOf(r[i.route_type]),
      color: i.route_color != null ? r[i.route_color] : '',
      text: i.route_text_color != null ? r[i.route_text_color] : ''
    });
  });
  report.counts.routes = routes.size;

  const tripKind = new Map(), tripLine = new Map();
  await readTable('trips.txt', (r, i) => {
    const rt = routes.get(r[i.route_id]);
    if (rt) { tripKind.set(r[i.trip_id], rt.kind); tripLine.set(r[i.trip_id], rt.short.toUpperCase()); }
  });
  report.counts.trips = tripKind.size;

  const all = new Map();
  await readTable('stops.txt', (r, i) => {
    all.set(r[i.stop_id], {
      id: r[i.stop_id], name: r[i.stop_name], lat: +r[i.stop_lat], lon: +r[i.stop_lon],
      parent: i.parent_station != null ? r[i.parent_station] : '',
      didok: i.didok != null ? r[i.didok] : ''
    });
  });

  const didokOf = (id) => {
    const quay = all.get(id);
    const d = ((quay && quay.didok) || String(id).replace(/^Parent/i, '').split(':')[0]).trim();
    return /^\d{6,9}$/.test(d) ? d : null;
  };
  const toMin = (t) => { const p = String(t || '').split(':').map(Number); return p.length >= 2 ? p[0] * 60 + p[1] + (p[2] || 0) / 60 : NaN; };

  // Parcours types par ligne (suite d'arrêts + minutes depuis le départ), pour
  // afficher le parcours complet d'une course, arrêts déjà passés compris.
  const patterns = new Map(); // ligne -> Map(clé -> { s, o, n })
  let curTrip = null, curRows = [], flushed = 0;
  const flush = () => {
    const rows = curRows; curRows = [];
    if (!curTrip || rows.length < 2) return;
    flushed++;
    rows.sort((a, b) => a.q - b.q);
    const seq = [], off = [], t0 = rows[0].t;
    for (const r of rows) {
      const d = didokOf(r.id);
      if (!d || seq[seq.length - 1] === d) continue;
      seq.push(d); off.push(Math.max(0, Math.round(r.t - t0)));
    }
    if (seq.length < 2) return;
    const line = tripLine.get(curTrip);
    let m = patterns.get(line); if (!m) patterns.set(line, (m = new Map()));
    const key = seq.join(',');
    const e = m.get(key);
    if (e) e.n++; else m.set(key, { s: seq, o: off, n: 1 });
  };

  const stopKinds = new Map(); // stop_id -> Set(kind)
  await readTable('stop_times.txt', (r, i) => {
    const trip = r[i.trip_id];
    const k = tripKind.get(trip);
    if (!k) return;
    const id = r[i.stop_id];
    let s = stopKinds.get(id);
    if (!s) stopKinds.set(id, (s = new Set()));
    s.add(k);
    if (trip !== curTrip) { flush(); curTrip = trip; }
    curRows.push({ id, q: Number(r[i.stop_sequence]), t: toMin(r[i.departure_time] || r[i.arrival_time]) });
  });
  flush();
  report.counts.stopIdsUsed = stopKinds.size;
  report.counts.patternTrips = flushed;

  const patternsOut = {};
  for (const [line, m] of patterns) {
    const list = [...m.values()].sort((a, b) => b.n - a.n);
    const min = Math.max(2, Math.round(list[0].n * 0.02));
    patternsOut[line] = list.filter((p) => p.n >= min).slice(0, 12);
  }
  report.counts.patternLines = Object.keys(patternsOut).length;
  report.counts.patterns = Object.values(patternsOut).reduce((a, l) => a + l.length, 0);

  const out = new Map();
  for (const [id, kinds] of stopKinds) {
    const quay = all.get(id);
    if (!quay) continue;
    const didok = (quay.didok || String(id).replace(/^Parent/i, '').split(':')[0]).trim();
    if (!/^\d{6,9}$/.test(didok)) continue;
    const parent = all.get(quay.parent) || quay;
    const e = out.get(didok) || { id: didok, name: parent.name, lat: +parent.lat.toFixed(5), lon: +parent.lon.toFixed(5), k: '' };
    for (const k of kinds) if (!e.k.includes(k)) e.k += k;
    out.set(didok, e);
  }
  const stops = [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  report.counts.stops = stops.length;

  const gtfsColors = {};
  for (const rt of routes.values()) {
    if (rt.short && /^[0-9a-f]{6}$/i.test(rt.color)) {
      gtfsColors[rt.short.toUpperCase()] = { bg: '#' + rt.color.toUpperCase(), fg: /^[0-9a-f]{6}$/i.test(rt.text) ? '#' + rt.text.toUpperCase() : null };
    }
  }
  report.colors.gtfs = Object.keys(gtfsColors).length;
  const lineNames = [...new Set([...routes.values()].map((r) => r.short.toUpperCase()).filter(Boolean))];
  return { stops, gtfsColors, lineNames, patterns: patternsOut };
}

// ---------- tpg.ch ----------
function extractObject(src, marker) {
  let at = src.indexOf(marker);
  while (at >= 0) {
    const start = src.indexOf('{', at);
    const arrStart = src.indexOf('[', at);
    const s = arrStart >= 0 && arrStart < start ? arrStart : start;
    if (s < 0) return null;
    const open = src[s], close = open === '{' ? '}' : ']';
    let depth = 0, str = null;
    for (let i = s; i < src.length; i++) {
      const c = src[i];
      if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return src.slice(s, i + 1);
    }
    at = src.indexOf(marker, at + 1);
  }
  return null;
}

const HEXV = /^#?[0-9a-f]{6}$/i;
const LINE_V = /^[A-Z0-9+]{1,5}$/i;
function walk(node, key, found) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, null, found)); return; }
  if (!node || typeof node !== 'object') return;
  let color = null, name = null, text = null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (!color && HEXV.test(s) && (s.startsWith('#') || /coul|color|colour|fond|bg|back/i.test(k))) color = '#' + s.replace('#', '').toUpperCase();
    if (/^(blanc|white)$/i.test(s)) text = '#FFFFFF';
    if (/^(noir|black)$/i.test(s)) text = '#000000';
    if (!name && /^(ligne|line|nom|name|code|numero|num|short|label|titre|title|id)/i.test(k) && LINE_V.test(s) && !HEXV.test(s)) name = s.toUpperCase();
  }
  if (!name && key && LINE_V.test(key)) name = key.toUpperCase();
  if (color && name && !found[name]) found[name] = { bg: color, fg: text };
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, k, found);
}

async function colorsFromTpgCh() {
  const found = {};
  try {
    const res = await fetch('https://www.tpg.ch/fr/lignes', { headers: { 'User-Agent': 'Mozilla/5.0 (not-tpg data build)', 'Accept-Language': 'fr' } });
    const html = await res.text();
    report.colors.tpgChStatus = res.status;
    const objText = extractObject(html, 'lignes=') || extractObject(html, 'lignes =') || extractObject(html, '"lignes"');
    report.colors.tpgChSample = objText ? objText.slice(0, 1500) : html.slice(0, 600);
    if (objText) {
      const obj = vm.runInNewContext('(' + objText + ')', Object.create(null), { timeout: 1000 });
      // Format constaté : { "12": { type, couleur: { classes: "noir line-logo …", color: "#F5A300" }, … } }
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [line, v] of Object.entries(obj)) {
          const c = v && v.couleur;
          if (!c || !HEXV.test(String(c.color || '').trim())) continue;
          const cls = String(c.classes || '');
          found[line.trim().toUpperCase()] = {
            bg: '#' + String(c.color).trim().replace('#', '').toUpperCase(),
            fg: /\bblanc\b/.test(cls) ? '#FFFFFF' : /\bnoir\b/.test(cls) ? '#000000' : null
          };
        }
      }
      if (!Object.keys(found).length) walk(obj, null, found);
    } else note('Objet « lignes » introuvable sur tpg.ch');
  } catch (e) { note('tpg.ch : ' + e.message); }
  report.colors.tpgCh = Object.keys(found).length;
  return found;
}

// ---------- contraste ----------
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function textFor(bg, fg) {
  // Texte officiel conservé tant qu'il reste lisible (badges en gras : seuil 3:1).
  if (fg && contrast(bg, fg) >= 3) return fg;
  return contrast(bg, '#FFFFFF') >= contrast(bg, '#1A1200') ? '#FFFFFF' : '#1A1200';
}

// ---------- main ----------
async function main() {
  let gtfs = null;
  try { gtfs = await buildFromGtfs(); } catch (e) { note('GTFS : ' + e.message); }

  if (gtfs && gtfs.stops.length >= MIN_STOPS) {
    writeFileSync(`${OUT}/stops.json`, JSON.stringify({ generated: new Date().toISOString(), source: report.gtfsUrl, stops: gtfs.stops }));
    note(`stops.json : ${gtfs.stops.length} arrêts`);
    if (report.counts.patterns > 50) {
      writeFileSync(`${OUT}/patterns.json`, JSON.stringify({ generated: new Date().toISOString(), lines: gtfs.patterns }));
      note(`patterns.json : ${report.counts.patterns} parcours`);
    }
  } else note('stops.json non mis à jour (résultat incomplet)');

  const tpgch = await colorsFromTpgCh();
  const merged = {};
  for (const [k, v] of Object.entries({ ...tpgch, ...(gtfs ? gtfs.gtfsColors : {}) })) merged[k] = { bg: v.bg, fg: textFor(v.bg, v.fg) };
  report.colors.total = Object.keys(merged).length;
  if (gtfs) report.colors.missing = gtfs.lineNames.filter((n) => !merged[n]).slice(0, 80);

  if (Object.keys(merged).length >= MIN_LINES || !existsSync(`${OUT}/lines.json`)) {
    if (Object.keys(merged).length) {
      writeFileSync(`${OUT}/lines.json`, JSON.stringify({ generated: new Date().toISOString(), lines: merged }, null, 1));
      note(`lines.json : ${Object.keys(merged).length} lignes`);
    }
  } else note('lines.json non mis à jour (résultat incomplet)');

  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/build-report.json`, JSON.stringify(report, null, 2));
}

main().catch((e) => {
  note('Erreur : ' + e.message);
  writeFileSync(`${OUT}/build-report.json`, JSON.stringify(report, null, 2));
});

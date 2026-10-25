#!/usr/bin/env node
// scripts/build-shapes.mjs
//
// Copie les tracés détaillés des lignes depuis Atlas RCT (Firestore, collection
// « lignes ») vers data/shapes.json. Seuls les tracés sont copiés (aucune autre
// donnée d'Atlas). Lancé automatiquement par .github/workflows/update-shapes.yml.
//
// Format de sortie :
//   { generated, lines: { "<ligne>": [ { v: "<variante>", d: "aller"|"retour", t: [[lat,lng], …] } ] } }

import { writeFileSync, mkdirSync } from 'node:fs';

const PROJECT = process.env.ATLAS_PROJECT || 'atlas-rct';
const KEY = process.env.ATLAS_API_KEY || '';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/lignes`;

const r5 = (n) => Math.round(Number(n) * 1e5) / 1e5;

async function fetchAll() {
  const docs = [];
  let token = '';
  for (let i = 0; i < 50; i++) {
    const url = `${BASE}?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}${KEY ? '&key=' + KEY : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore HTTP ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    docs.push(...(j.documents || []));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return docs;
}

// Même logique de compatibilité qu'Atlas (anciens formats sans « variantes »)
function variantesOf(l) {
  if (Array.isArray(l.variantes) && l.variantes.length) return l.variantes;
  if (l.directions) return [{ nom: '', directions: l.directions }];
  if (l.carteParcours) return [{ nom: '', directions: { aller: { carte: l.carteParcours } } }];
  return [];
}

function cleanTrace(t) {
  if (!Array.isArray(t)) return [];
  const out = [];
  for (const p of t) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]), lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const q = [r5(lat), r5(lng)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

async function main() {
  const docs = await fetchAll();
  const lines = {};
  let count = 0;
  for (const doc of docs) {
    const id = decodeURIComponent(doc.name.split('/').pop()).trim().toUpperCase();
    const raw = doc.fields && doc.fields.data && doc.fields.data.stringValue;
    if (!raw) continue;
    let l;
    try { l = JSON.parse(raw); } catch { continue; }
    const shapes = [];
    variantesOf(l).forEach((v) => {
      for (const d of ['aller', 'retour']) {
        const dir = v.directions && v.directions[d];
        const t = cleanTrace(dir && dir.carte && dir.carte.trace);
        if (t.length >= 2) shapes.push({ v: (v.nom || '').trim(), d, t });
      }
    });
    if (shapes.length) { lines[id] = shapes; count += shapes.length; }
  }
  if (!count) throw new Error('Aucun tracé trouvé — fichier non modifié');
  mkdirSync('data', { recursive: true });
  writeFileSync('data/shapes.json', JSON.stringify({ generated: new Date().toISOString(), source: 'Atlas RCT', lines }));
  console.log(`shapes.json : ${Object.keys(lines).length} lignes, ${count} tracés`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

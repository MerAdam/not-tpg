// Accès à Upstash Redis via son API REST (variables ajoutées par l'intégration Vercel).
function cfg() {
  const env = process.env;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL
    || Object.entries(env).find(([k]) => /REST_API_URL$|REDIS_REST_URL$/.test(k))?.[1];
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN
    || Object.entries(env).find(([k]) => /REST_API_TOKEN$|REDIS_REST_TOKEN$/.test(k) && !/READ_ONLY/.test(k))?.[1];
  if (!url || !token) throw new Error('Base Redis non configurée dans Vercel');
  return { url: url.replace(/\/$/, ''), token };
}

async function redis(...cmd) {
  const { url, token } = cfg();
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error('Redis : ' + j.error);
  return j.result;
}

async function pipeline(cmds) {
  if (!cmds.length) return [];
  const { url, token } = cfg();
  const r = await fetch(url + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('Redis : ' + (j.error || 'réponse inattendue'));
  return j.map((x) => (x.error ? null : x.result));
}

const getJSON = async (key) => { const v = await redis('GET', key); return v ? JSON.parse(v) : null; };
const setJSON = (key, val, ttl) => (ttl ? redis('SET', key, JSON.stringify(val), 'EX', ttl) : redis('SET', key, JSON.stringify(val)));

module.exports = { redis, pipeline, getJSON, setJSON };

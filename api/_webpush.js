// Envoi des notifications Web Push. Les clés VAPID sont générées au premier usage
// et conservées dans Redis : rien à configurer à la main.
const webpush = require('web-push');
const { redis, getJSON } = require('./_redis');

let ready = null;
async function vapid() {
  if (ready) return ready;
  let keys = await getJSON('vapid');
  if (!keys) {
    const k = webpush.generateVAPIDKeys();
    await redis('SET', 'vapid', JSON.stringify(k), 'NX'); // une seule paire, même si deux appels arrivent ensemble
    keys = await getJSON('vapid');
  }
  webpush.setVapidDetails('https://github.com/MerAdam/not-tpg', keys.publicKey, keys.privateKey);
  ready = keys;
  return keys;
}

// Renvoie 'ok', 'gone' (abonnement expiré : à supprimer) ou 'error'
async function send(subscription, payload) {
  await vapid();
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 1800, urgency: 'high' });
    return 'ok';
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return 'gone';
    console.error('push error', e.statusCode, e.body);
    return 'error';
  }
}

module.exports = { vapid, send };

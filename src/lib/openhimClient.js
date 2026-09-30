const axios = require('axios');
const https = require('https');
const logger = require('./logger');

// The OpenHIM core management API, over http:// or https:// (OPENHIM_TRUST_SELF_SIGNED=true accepts
// a self-signed certificate; axios only uses httpsAgent for https:// URLs). Registration and the
// heartbeat used to go through openhim-mediator-utils, which always passes an https.Agent and so
// fails against an http:// API.
const client = axios.create({
  baseURL: process.env.OPENHIM_API_URL,
  auth: {
    username: process.env.OPENHIM_USERNAME,
    password: process.env.OPENHIM_PASSWORD
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: process.env.OPENHIM_TRUST_SELF_SIGNED !== 'true'
  })
});

// Creates or updates the mediator (keyed by its urn). OpenHIM answers 201.
async function registerMediator(mediatorConfig) {
  await client.post('/mediators', mediatorConfig);
}

// Sends one heartbeat now and then every intervalMs, so OpenHIM shows the mediator as up. A failed
// heartbeat is logged and the next one tried as usual.
function activateHeartbeat(urn, intervalMs = 10000) {
  const beat = () => client
    .post(`/mediators/${urn}/heartbeat`, { uptime: process.uptime() })
    .catch((err) => logger.warn('OpenHIM heartbeat failed', { error: err.message }));
  beat();
  return setInterval(beat, intervalMs);
}

module.exports = { client, registerMediator, activateHeartbeat };

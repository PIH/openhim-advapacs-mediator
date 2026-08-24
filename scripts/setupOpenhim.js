require('dotenv').config();
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const mediatorConfig = require('../mediatorConfig.json');

// Channels aren't auto-created when the mediator registers -- OpenHIM only
// stores mediatorConfig.json's defaultChannelConfig as a console-importable
// suggestion. This script actually creates/updates them via the admin API so
// to produce a working setup.
const CHANNEL_NAMES = [
  'OpenMRS to Mediator Order Push',
  'Mediator to AdvaPACS Order Push'
];

const OUTBOUND_CHANNEL_NAME = 'Mediator to AdvaPACS Order Push';

// OpenHIM channels can't read env vars themselves, so mediatorConfig.json's
// route host is just a documentation placeholder (example.api.integration.advapacs.com).
// This resolves the real destination from ADVAPACS_BASE_URL at setup time --
// the one place that has to happen.
function withRealAdvapacsRoute(channelDef) {
  if (channelDef.name !== OUTBOUND_CHANNEL_NAME) return channelDef;

  const advapacsUrl = new URL(process.env.ADVAPACS_BASE_URL);
  const secured = advapacsUrl.protocol === 'https:';
  const port = advapacsUrl.port ? Number(advapacsUrl.port) : (secured ? 443 : 80);
  const basePath = advapacsUrl.pathname === '/' ? '' : advapacsUrl.pathname.replace(/\/$/, '');
  const pathTransform = `s/^\\/advapacs/${basePath.replace(/\//g, '\\/')}/`;

  return {
    ...channelDef,
    routes: channelDef.routes.map((route) => ({
      ...route,
      host: advapacsUrl.hostname,
      port,
      secured,
      pathTransform
    }))
  };
}

const api = axios.create({
  baseURL: process.env.OPENHIM_API_URL,
  auth: {
    username: process.env.OPENHIM_USERNAME,
    password: process.env.OPENHIM_PASSWORD
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: process.env.OPENHIM_TRUST_SELF_SIGNED !== 'true'
  })
});

// Defensive: don't trust compose healthcheck timing alone (the reference
// healthcheck this project is modeled on was silently broken -- see the
// openhim service fragment in distro-tools) -- poll the admin API directly
// until it responds.
async function waitForOpenhim(retries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await api.get(`/authenticate/${process.env.OPENHIM_USERNAME}`);
      return;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`OpenHIM core never became reachable at ${process.env.OPENHIM_API_URL}: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// The inbound channel's authType: "private" (mediatorConfig.json) requires an
// OpenHIM Client matching its "allow" list ("openmrs") to exist -- this is
// what orderPoller.js authenticates as via Basic auth. Password is hashed
// here (sha512(password + salt)) since OpenHIM's Clients API expects a
// precomputed hash, not a plaintext password, unlike the Users API.
// "allow" matches either a Client's clientID or its roles -- roles must stay
// empty here since OpenHIM rejects a Client whose clientID duplicates one of
// its own role names ("ClientID 'openmrs' cannot be the same as a role name"),
// and clientID alone already satisfies the "openmrs" allow entry.
function buildInboundClient() {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha512')
    .update(process.env.OPENHIM_INBOUND_CLIENT_PASSWORD)
    .update(salt)
    .digest('hex');
  return {
    clientID: process.env.OPENHIM_INBOUND_CLIENT_ID || 'openmrs',
    name: 'OpenMRS / order poller',
    roles: [],
    passwordAlgorithm: 'sha512',
    passwordSalt: salt,
    passwordHash: hash
  };
}

async function upsertClient(clientDef) {
  const { data: existing } = await api.get('/clients');
  const match = existing.find((c) => c.clientID === clientDef.clientID);

  if (match) {
    await api.put(`/clients/${match._id}`, clientDef);
    console.log(`Updated client "${clientDef.clientID}"`);
  } else {
    await api.post('/clients', clientDef);
    console.log(`Created client "${clientDef.clientID}"`);
  }
}

// A fresh OpenHIM Mongo volume always seeds root@openhim.org with this known
// default, regardless of .env's OPENHIM_PASSWORD -- so a strong password set
// in .env before first boot would otherwise break every subsequent script run
// until someone manually fixes it via the console. Self-heals by rotating the
// account to match .env the first time it detects the mismatch.
const DEFAULT_ADMIN_PASSWORD = 'openhim-password';

async function rotateDefaultAdminPassword() {
  const email = process.env.OPENHIM_USERNAME;
  const targetPassword = process.env.OPENHIM_PASSWORD;

  if (!targetPassword) {
    console.warn('OPENHIM_PASSWORD is not set -- skipping admin password rotation.');
    return;
  }

  try {
    await api.get('/users');
    return; // .env credentials already work -- nothing to rotate.
  } catch (err) {
    if (!err.response || err.response.status !== 401) throw err;
  }

  // .env's credentials didn't work -- try the known fresh-volume default, and
  // if that works, rotate the account's password to match .env. OpenHIM's
  // Users API takes the plaintext password directly (hashed server-side) and
  // expects the full user document back, not a sparse patch -- read first.
  const defaultAuthApi = axios.create({
    baseURL: process.env.OPENHIM_API_URL,
    auth: { username: email, password: DEFAULT_ADMIN_PASSWORD },
    httpsAgent: new https.Agent({ rejectUnauthorized: process.env.OPENHIM_TRUST_SELF_SIGNED !== 'true' })
  });

  const { data: existing } = await defaultAuthApi.get(`/users/${encodeURIComponent(email)}`);
  const { _id, ...userData } = existing;
  await defaultAuthApi.put(`/users/${encodeURIComponent(email)}`, { ...userData, password: targetPassword });
  console.log(`Rotated OpenHIM admin password for ${email} to match .env`);
}

async function upsertChannel(channelDef) {
  // channelDef's autoRetryEnabled/autoRetryPeriodMinutes/autoRetryMaxAttempts
  // (set in mediatorConfig.json's defaultChannelConfig) only cover connection
  // failures/timeouts talking to the route host -- OpenHIM does NOT retry a
  // 4xx/5xx *response* from AdvaPACS itself (that only auto-retries when the
  // response is shaped like OpenHIM's own mediator-error envelope, which a
  // plain external FHIR API won't send). A real AdvaPACS error today just
  // surfaces as a normal failed transaction with no further retry or
  // alerting -- see the comment above advapacsClient.js's createServiceRequest.
  const { data: existing } = await api.get('/channels');
  const match = existing.find((c) => c.name === channelDef.name);

  if (match) {
    await api.put(`/channels/${match._id}`, channelDef);
    console.log(`Updated channel "${channelDef.name}"`);
  } else {
    await api.post('/channels', channelDef);
    console.log(`Created channel "${channelDef.name}"`);
  }
}

async function main() {
  await waitForOpenhim();
  await rotateDefaultAdminPassword();
  await upsertClient(buildInboundClient());
  const channels = mediatorConfig.defaultChannelConfig
    .filter((c) => CHANNEL_NAMES.includes(c.name))
    .map(withRealAdvapacsRoute);
  for (const channel of channels) {
    await upsertChannel(channel);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to set up OpenHIM channels:', err.message);
    process.exit(1);
  });
}

module.exports = { main };

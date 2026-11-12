require('dotenv').config();
const crypto = require('crypto');
const { client: api } = require('../src/lib/openhimClient');
const { resultsClientId } = require('../src/lib/resultsClient');
const mediatorConfig = require('../mediatorConfig.json');

// Channels aren't auto-created when the mediator registers -- OpenHIM only
// stores mediatorConfig.json's defaultChannelConfig as a console-importable
// suggestion. This script actually creates/updates them via the admin API so
// to produce a working setup.
const CHANNEL_NAMES = [
  'OpenMRS to Mediator Order Push',
  'Mediator to AdvaPACS Order Push',
  'AdvaPACS to Mediator Study and Report Webhook',
  'Mediator to OpenMRS Radiology Results',
  'AdvaPACS Event Processing'
];

const OUTBOUND_CHANNEL_NAME = 'Mediator to AdvaPACS Order Push';
const WEBHOOK_CHANNEL_NAME = 'AdvaPACS to Mediator Study and Report Webhook';
const RESULTS_CHANNEL_NAME = 'Mediator to OpenMRS Radiology Results';
const EVENT_CHANNEL_NAME = 'AdvaPACS Event Processing';

// The OpenHIM Client AdvaPACS calls the webhook channel as -- mediatorConfig.json's channel allows
// "advapacs", replaced here when ADVAPACS_WEBHOOK_CLIENT_ID names another (e.g. one per instance).
function webhookClientId() {
  return process.env.ADVAPACS_WEBHOOK_CLIENT_ID || 'advapacs';
}

function withWebhookClient(channelDef) {
  if (channelDef.name !== WEBHOOK_CHANNEL_NAME) return channelDef;
  return { ...channelDef, allow: [webhookClientId()] };
}

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

function withResultsClient(channelDef) {
  if (channelDef.name !== RESULTS_CHANNEL_NAME && channelDef.name !== EVENT_CHANNEL_NAME) return channelDef;
  return { ...channelDef, allow: [resultsClientId()] };
}

// Like withRealAdvapacsRoute: resolves the results channel's route from OPENMRS_BASE_URL, and sets
// the OpenMRS login on the route (OpenHIM drops the mediator's own Authorization header,
// forwardAuthHeader: false, and calls OpenMRS with these). OpenHIM and OpenMRS are assumed to run
// on the same server, so an http OPENMRS_BASE_URL gives a plain http route on the local network.
function withRealOpenmrsRoute(channelDef) {
  if (channelDef.name !== RESULTS_CHANNEL_NAME) return channelDef;

  const openmrsUrl = new URL(process.env.OPENMRS_BASE_URL);
  const secured = openmrsUrl.protocol === 'https:';
  const port = openmrsUrl.port ? Number(openmrsUrl.port) : (secured ? 443 : 80);
  const basePath = openmrsUrl.pathname === '/' ? '' : openmrsUrl.pathname.replace(/\/$/, '');
  const pathTransform = `s/^\\/openmrs/${basePath.replace(/\//g, '\\/')}/`;

  return {
    ...channelDef,
    routes: channelDef.routes.map((route) => ({
      ...route,
      host: openmrsUrl.hostname,
      port,
      secured,
      pathTransform,
      username: process.env.OPENMRS_USERNAME,
      password: process.env.OPENMRS_PASSWORD
    }))
  };
}

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

// An OpenHIM Client definition that authenticates with Basic auth. The password is hashed here
// (sha512(password + salt)) since OpenHIM's Clients API expects a precomputed hash, not a plaintext
// password, unlike the Users API. A channel's "allow" matches either a Client's clientID or its
// roles -- roles stay empty since OpenHIM rejects a Client whose clientID duplicates one of its own
// role names ("ClientID 'openmrs' cannot be the same as a role name"), and the clientID alone
// already satisfies a channel's allow entry.
function clientWithHashedPassword(clientID, name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha512')
    .update(password)
    .update(salt)
    .digest('hex');
  return {
    clientID,
    name,
    roles: [],
    passwordAlgorithm: 'sha512',
    passwordSalt: salt,
    passwordHash: hash
  };
}

// The Client orderPoller.js (or, in push mode, OpenMRS) sends orders to the inbound channel as --
// that channel's authType: "private" (mediatorConfig.json) allows only "openmrs".
function orderPollerClient() {
  return clientWithHashedPassword(
    process.env.OPENHIM_INBOUND_CLIENT_ID || 'openmrs',
    'OpenMRS / order poller',
    process.env.OPENHIM_INBOUND_CLIENT_PASSWORD
  );
}

// The Client AdvaPACS's webhook (Configuration > Webhooks, Basic Authentication) calls the webhook
// channel as, sending this Client's id and ADVAPACS_WEBHOOK_SECRET as its username and password.
// Without ADVAPACS_WEBHOOK_SECRET no Client is created, so the webhook channel accepts no one.
function advapacsWebhookClient() {
  return clientWithHashedPassword(webhookClientId(), 'AdvaPACS webhook', process.env.ADVAPACS_WEBHOOK_SECRET);
}

// The Client the mediator POSTs its results to OpenMRS as, through the results channel.
// Without OPENHIM_RESULTS_CLIENT_PASSWORD no Client is created, so that channel accepts no one.
function resultsClient() {
  return clientWithHashedPassword(
    resultsClientId(),
    'AdvaPACS mediator (results to OpenMRS)',
    process.env.OPENHIM_RESULTS_CLIENT_PASSWORD
  );
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

async function upsertChannel(channelDef) {
  // channelDef's autoRetryEnabled/autoRetryPeriodMinutes/autoRetryMaxAttempts
  // (set in mediatorConfig.json's defaultChannelConfig) only cover connection
  // failures/timeouts talking to the route host -- OpenHIM does NOT retry a
  // 4xx/5xx *response* from AdvaPACS itself (that only auto-retries when the
  // response is shaped like OpenHIM's own mediator-error envelope, which a
  // plain external FHIR API won't send). The inbound channel's auto-retry does
  // work for this mediator's own retryable failures (e.g. an order arriving
  // before the modality map has loaded), which routes/serviceRequest.js answers
  // with that envelope (UHM-9616). A real AdvaPACS error today just
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
  await upsertClient(orderPollerClient());
  if (process.env.ADVAPACS_WEBHOOK_SECRET) {
    await upsertClient(advapacsWebhookClient());
  } else {
    console.log('ADVAPACS_WEBHOOK_SECRET not set: no AdvaPACS webhook client, so the webhook channel accepts no one');
  }
  if (process.env.OPENHIM_RESULTS_CLIENT_PASSWORD) {
    await upsertClient(resultsClient());
  } else {
    console.log('OPENHIM_RESULTS_CLIENT_PASSWORD not set: no results client, so the OpenMRS results channel accepts no one, and not provisioning the "' + EVENT_CHANNEL_NAME + '" channel');
  }
  const missingOpenmrs = ['OPENMRS_BASE_URL', 'OPENMRS_USERNAME', 'OPENMRS_PASSWORD'].filter((v) => !process.env[v]);
  if (missingOpenmrs.length) {
    console.log(`${missingOpenmrs.join(', ')} not set: not provisioning the "${RESULTS_CHANNEL_NAME}" channel`);
  }
  const channels = mediatorConfig.defaultChannelConfig
    .filter((c) => CHANNEL_NAMES.includes(c.name))
    .filter((c) => c.name !== EVENT_CHANNEL_NAME || process.env.OPENHIM_RESULTS_CLIENT_PASSWORD)
    .filter((c) => c.name !== RESULTS_CHANNEL_NAME || !missingOpenmrs.length)
    .map(withRealAdvapacsRoute)
    .map(withRealOpenmrsRoute)
    .map(withWebhookClient)
    .map(withResultsClient);
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

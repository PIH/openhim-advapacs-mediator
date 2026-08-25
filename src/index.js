require('dotenv').config();
const express = require('express');
const bodyParser = express.json;
const medUtils = require('openhim-mediator-utils').default;

const logger = require('./lib/logger');
const orderPoller = require('./lib/orderPoller');
const mediatorConfig = require('../mediatorConfig.json');
const { main: setupOpenhim } = require('../scripts/setupOpenhim');

const serviceRequestRoute = require('./routes/serviceRequest');
// DISABLED (for now): the AdvaPACS result-delivery path (routes/subscriptionWebhook.js
// + advapacsClient.ensureSubscription below) hasn't been tested at all yet --
// all effort so far has gone into the outbound order-push path. Commented out
// rather than deleted so it's easy to re-enable once that path is ready to test.
// const subscriptionWebhookRoute = require('./routes/subscriptionWebhook');
// const advapacs = require('./lib/advapacsClient');

const openhimConfig = {
  username: process.env.OPENHIM_USERNAME,
  password: process.env.OPENHIM_PASSWORD,
  apiURL: process.env.OPENHIM_API_URL,
  trustSelfSigned: process.env.OPENHIM_TRUST_SELF_SIGNED === 'true',
  urn: mediatorConfig.urn
};

function startServer() {
  const app = express();
  app.use(bodyParser({ type: ['application/json', 'application/fhir+json'] }));

  // DISABLED (for now) -- see the commented-out require above.
  // app.use('/', subscriptionWebhookRoute);

  // routes/serviceRequest.js's POST /fhir/ServiceRequest is always mounted:
  // in 'push' mode OpenMRS (or an event listener) hits it via OpenHIM's
  // inbound channel directly; in 'poll' mode orderPoller.js hits the same
  // endpoint the same way, on an interval -- see .env.example.
  app.use('/', serviceRequestRoute);

  if (process.env.ORDER_INGESTION_MODE === 'poll') {
    orderPoller.start(Number(process.env.ORDER_POLL_INTERVAL_MS) || 60000);
  }

  app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));

  const port = process.env.MEDIATOR_PORT || 3500;
  app.listen(port, () => {
    logger.info(`OpenMRS-AdvaPACS mediator listening on port ${port}`);
  });
}

async function registerAndStart() {
  medUtils.registerMediator(openhimConfig, mediatorConfig, (err) => {
    if (err) {
      logger.error('Failed to register mediator with OpenHIM core', { error: err.message || err });
      process.exit(1);
    }

    medUtils.activateHeartbeat(openhimConfig);
    logger.info('Registered with OpenHIM core and activated heartbeat');

    // Provisions the AdvaPACS-specific channels/client via the admin API --
    // registerMediator above only stores mediatorConfig.json's
    // defaultChannelConfig as a console-importable suggestion, it doesn't
    // create anything. Non-fatal on failure and re-run on every boot
    // (idempotent) so a transient admin-API hiccup doesn't crash-loop the
    // whole mediator -- it'll just retry next restart, or can be re-run
    // on demand via `node scripts/setupOpenhim.js`.
    setupOpenhim()
      .then(() => logger.info('OpenHIM channels/clients provisioned'))
      .catch((err) => logger.warn('Failed to provision OpenHIM channels/clients -- continuing startup', { error: err.message }))
      .finally(() => startServer());

    // DISABLED (for now) -- see the commented-out require above. This was
    // also the source of the "Could not confirm AdvaPACS subscription on
    // startup" warning logged on every boot.
    //
    // One-time setup: make sure AdvaPACS has a live Subscription pointed at
    // our webhook. Safe to leave in on every boot; AdvaPACS treats repeat
    // registration of an equivalent Subscription as idempotent-ish, but
    // consider gating this behind an explicit CLI flag in production.
    // const webhookUrl = `${process.env.OPENHIM_API_URL}/webhooks/advapacs`;
    // advapacs
    //   .ensureSubscription(webhookUrl, process.env.ADVAPACS_WEBHOOK_SECRET, 'ImagingStudy')
    //   .catch((e) => logger.warn('Could not confirm AdvaPACS subscription on startup', { error: e.message }));
  });
}

registerAndStart();

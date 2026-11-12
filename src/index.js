require('dotenv').config();
const express = require('express');
const bodyParser = express.json;
const logger = require('./lib/logger');
const openhim = require('./lib/openhimClient');
const orderPoller = require('./lib/orderPoller');
const modalityMap = require('./lib/modalityMap');
const mediatorConfig = require('../mediatorConfig.json');
const { main: setupOpenhim } = require('../scripts/setupOpenhim');

const serviceRequestRoute = require('./routes/serviceRequest');
const advapacsWebhookRoute = require('./routes/advapacsWebhook');
const healthRoute = require('./routes/health');

function startServer() {
  const app = express();
  app.use(bodyParser({ type: ['application/json', 'application/fhir+json'] }));

  // routes/serviceRequest.js's POST /fhir/ServiceRequest is always mounted:
  // in 'push' mode OpenMRS (or an event listener) hits it via OpenHIM's
  // inbound channel directly; in 'poll' mode orderPoller.js hits the same
  // endpoint the same way, on an interval -- see .env.example.
  app.use('/', serviceRequestRoute);

  // AdvaPACS's webhook, behind OpenHIM's ^/webhooks/advapacs$ channel; creates radiologyapp studies and reports in OpenMRS.
  app.use('/', advapacsWebhookRoute);

  if (process.env.ORDER_INGESTION_MODE === 'poll') {
    orderPoller.start(Number(process.env.ORDER_POLL_INTERVAL_MS) || 60000);
  }

  // Unhealthy until the modality map has loaded: orders are held (not relayed) until then
  app.use('/', healthRoute);

  const port = process.env.MEDIATOR_PORT || 3500;
  app.listen(port, () => {
    logger.info(`OpenMRS-AdvaPACS mediator listening on port ${port}`);
  });
}

async function registerAndStart() {
  try {
    await openhim.registerMediator(mediatorConfig);
  } catch (err) {
    logger.error('Failed to register mediator with OpenHIM core', { error: err.message || err });
    process.exit(1);
  }

  // If openhim-core later loses the registration (e.g. it comes up on an empty database), the
  // heartbeat gets a 404: register again and re-provision the channels and client, which went with it.
  openhim.activateHeartbeat(mediatorConfig.urn, 10000, async () => {
    await openhim.registerMediator(mediatorConfig);
    await setupOpenhim();
    logger.info('Registered with OpenHIM core again and re-provisioned channels/clients');
  });
  logger.info('Registered with OpenHIM core and activated heartbeat');

  // Provisions the AdvaPACS-specific channels/client via the admin API --
  // registerMediator above only stores mediatorConfig.json's
  // defaultChannelConfig as a console-importable suggestion, it doesn't
  // create anything. Non-fatal on failure and re-run on every boot
  // (idempotent) so a transient admin-API hiccup doesn't crash-loop the
  // whole mediator -- it'll just retry next restart, or can be re-run
  // on demand via `node scripts/setupOpenhim.js`.
  //
  // Also loads the modality map (concept -> DICOM modality, from OpenMRS) before orders start flowing,
  // and keeps it refreshed. That never fails startup: if OpenMRS isn't up yet it retries in the
  // background, and orders are held (not relayed) until it has loaded (see modalityMap.js).
  Promise.allSettled([
    setupOpenhim()
      .then(() => logger.info('OpenHIM channels/clients provisioned'))
      .catch((err) => logger.warn('Failed to provision OpenHIM channels/clients -- continuing startup', { error: err.message })),
    modalityMap.start()
  ]).finally(() => startServer());
}

registerAndStart();

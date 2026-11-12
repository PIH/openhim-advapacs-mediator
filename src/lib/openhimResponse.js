const { urn: MEDIATOR_URN } = require('../../mediatorConfig.json');

// A failure worth retrying (e.g. the modality map not loaded yet), answered as an OpenHIM mediator
// response: OpenHIM only queues a transaction for auto-retry (on a channel with autoRetryEnabled) when
// the route answers with Content-Type application/json+openhim and an "error" field (openhim-core's
// router.js). A plain error response is just marked Failed, to be re-run by hand.
function sendRetryableFailure(res, err) {
  const body = JSON.stringify({ status: 'error', message: err.message });
  res.status(503).type('application/json+openhim').send(JSON.stringify({
    'x-mediator-urn': MEDIATOR_URN,
    status: 'Failed',
    response: {
      status: 503,
      headers: { 'content-type': 'application/json' },
      body,
      timestamp: new Date().toISOString()
    },
    error: { message: err.message }
  }));
}

module.exports = { sendRetryableFailure };

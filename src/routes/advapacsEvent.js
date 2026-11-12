const express = require('express');
const logger = require('../lib/logger');
const { handleEvent } = require('../lib/resultHandler');
const { sendRetryableFailure } = require('../lib/openhimResponse');
const { requireSharedSecret } = require('../lib/sharedSecretAuth');

const router = express.Router();

// OpenHIM doesn't forward the caller's Authorization header on this channel; this is the mediator's own
// backstop, as for orders.
const verifyInboundSecret = requireSharedSecret({
  headerName: 'x-mediator-secret',
  envVar: 'MEDIATOR_INBOUND_SECRET',
  label: 'AdvaPACS event'
});

/**
 * Processes one AdvaPACS webhook event, routed here by OpenHIM's ^/results/advapacs-event$ channel (auto-retry on).
 * A handled or skipped event is a 200; a failure is answered as an OpenHIM mediator error so OpenHIM retries it.
 */
router.post('/results/advapacs-event', verifyInboundSecret, async (req, res) => {
  // OpenHIM gives up on the route after 10s but the request stays queued; res 'close' without a finished
  // response means the caller is gone (req 'close' fires once the body is read, so it can't be used).
  let abandoned = false;
  res.on('close', () => { if (!res.writableEnded) abandoned = true; });
  try {
    const { outcome, reason } = await handleEvent(req.body, { isAbandoned: () => abandoned });
    res.status(200).json(reason ? { status: 'ok', outcome, reason } : { status: 'ok', outcome });
  } catch (err) {
    // the message only, never the error object (it can carry credentials) or any patient details
    logger.error('Failed to process AdvaPACS event', { error: err.message });
    sendRetryableFailure(res, err);
  }
});

module.exports = router;

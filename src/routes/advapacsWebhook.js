const express = require('express');
const logger = require('../lib/logger');
const { timingSafeEqualStrings } = require('../lib/sharedSecretAuth');
const { handleEvent } = require('../lib/resultHandler');

const router = express.Router();

// The fields AdvaPACS's docs describe for a webhook event (https://docs.advapacs.com/webhooks).
const EVENT_FIELDS = ['timestamp', 'eventId', 'eventType', 'data'];
const DATA_FIELDS = ['type', 'id'];

/**
 * The OpenHIM client AdvaPACS calls the webhook channel as (ADVAPACS_WEBHOOK_CLIENT_ID, default
 * "advapacs"), with ADVAPACS_WEBHOOK_SECRET as its password; scripts/setupOpenhim.js creates that
 * client. OpenHIM checks these credentials first; the channel forwards the Authorization header so
 * this route checks them again, a backstop in case the mediator's port is ever reached without going
 * through OpenHIM. Rejects everything when ADVAPACS_WEBHOOK_SECRET isn't set.
 */
function verifyWebhookCredentials(req, res, next) {
  const password = process.env.ADVAPACS_WEBHOOK_SECRET;
  const expected = `${process.env.ADVAPACS_WEBHOOK_CLIENT_ID || 'advapacs'}:${password}`;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const provided = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString() : '';
  if (!password || !timingSafeEqualStrings(provided, expected)) {
    logger.warn('Rejected AdvaPACS webhook with invalid credentials');
    return res.status(401).json({ status: 'error', message: 'unauthorized' });
  }
  next();
}

/**
 * AdvaPACS's webhook (Configuration > Webhooks), behind the OpenHIM channel ^/webhooks/advapacs$.
 * Logs each event, then hands it to lib/resultHandler, which creates the radiologyapp study or report
 * in OpenMRS (LSO-209). 200 means the event was handled or deliberately skipped; 500 means AdvaPACS or
 * OpenMRS failed (or config is missing), so AdvaPACS may retry. An event carries only a reference to
 * the resource, e.g. { eventType: "REPORT_UPDATED", data: { type: "report", id } }. Fields the docs
 * don't describe are logged by name only, so nothing unexpected (patient details, say) reaches the logs.
 */
router.post('/webhooks/advapacs', verifyWebhookCredentials, async (req, res) => {
  const event = req.body || {};
  const data = event.data || {};
  if (!event.eventType || !data.id) {
    // AdvaPACS's own webhook test (Configuration > Webhooks) sends an event like this, and rejects the
    // webhook ("Invalid webhook response", 27108) unless it gets a 2xx. So acknowledge it, and log
    // which fields it had (names only) so the shape can be seen.
    logger.warn('Received AdvaPACS webhook event without an eventType and data.id (e.g. a test event)', {
      fields: Object.keys(event),
      dataFields: data && typeof data === 'object' ? Object.keys(data) : [],
      hasEventType: Boolean(event.eventType)
    });
    return res.status(200).json({ status: 'ok' });
  }

  logger.info('Received AdvaPACS webhook event', {
    eventType: event.eventType,
    eventId: event.eventId,
    timestamp: event.timestamp,
    resourceType: data.type,
    resourceId: data.id,
    ...unexpected('otherFields', event, EVENT_FIELDS),
    ...unexpected('otherDataFields', data, DATA_FIELDS)
  });

  try {
    const { outcome } = await handleEvent(event);
    res.status(200).json({ status: 'ok', outcome });
  } catch (err) {
    // The handler's errors are plain and safe to log by message; never log the object itself.
    logger.error('Failed to process AdvaPACS webhook event', {
      eventType: event.eventType,
      eventId: event.eventId,
      resourceId: data.id,
      error: err && err.message
    });
    res.status(500).json({ status: 'error' });
  }
});

function unexpected(name, object, known) {
  const others = Object.keys(object).filter((key) => !known.includes(key));
  return others.length ? { [name]: others } : {};
}

module.exports = router;

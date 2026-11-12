const express = require('express');
const logger = require('../lib/logger');
const { timingSafeEqualStrings } = require('../lib/sharedSecretAuth');
const { submitEvent } = require('../lib/eventQueueClient');
const { SUPPORTED_EVENTS } = require('../lib/supportedEvents');

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
 * Logs each event, then hands it to OpenHIM's "AdvaPACS Event Processing" channel (lib/eventQueueClient),
 * which retries it against the mediator's processing route (LSO-209). 200 means OpenHIM has the event;
 * 503 means it didn't, so AdvaPACS may retry. An event carries only a reference to
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

  if (!SUPPORTED_EVENTS.includes(event.eventType)) {
    // nothing to process, so don't make an OpenHIM transaction of it
    logger.info('Acknowledged an AdvaPACS webhook event of an unsupported type without processing it', {
      eventType: event.eventType,
      eventId: event.eventId
    });
    return res.status(200).json({ status: 'ok' });
  }

  // Hand the event to OpenHIM, which queues it and retries until the mediator has processed it. Only
  // once OpenHIM has answered do we acknowledge AdvaPACS; otherwise a 503 makes AdvaPACS retry.
  // Only the documented fields go on, never the raw body.
  const submitted = { timestamp: event.timestamp, eventId: event.eventId, eventType: event.eventType, data: { type: data.type, id: data.id } };
  const result = await submitEvent(submitted);
  if (result.accepted) {
    return res.status(200).json({ status: 'ok' });
  }
  logger.warn('OpenHIM did not accept AdvaPACS webhook event', {
    eventType: event.eventType,
    eventId: event.eventId,
    status: result.status,
    code: result.code,
    // names of the unset variables when code is NOT_CONFIGURED
    ...(result.missing ? { missing: result.missing } : {})
  });
  res.status(503).json({ status: 'error' });
});

function unexpected(name, object, known) {
  const others = Object.keys(object).filter((key) => !known.includes(key));
  return others.length ? { [name]: others } : {};
}

module.exports = router;

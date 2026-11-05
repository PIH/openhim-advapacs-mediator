const express = require('express');
const logger = require('../lib/logger');
const { timingSafeEqualStrings } = require('../lib/sharedSecretAuth');

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
 * Log-only for now (UHM-9458/UHM-9459): records each event so the real event sequence and payloads
 * can be seen before anything is written to OpenMRS. An event carries only a reference to the
 * resource, e.g. { eventType: "REPORT_UPDATED", data: { type: "report", id } }. Fields the docs don't
 * describe are logged by name only, so nothing unexpected (patient details, say) reaches the logs.
 */
router.post('/webhooks/advapacs', verifyWebhookCredentials, (req, res) => {
  const event = req.body || {};
  const data = event.data || {};
  if (!event.eventType || !data.id) {
    logger.warn('Rejected AdvaPACS webhook event without an eventType and data.id', {
      fields: Object.keys(event)
    });
    return res.status(400).json({ status: 'error', message: 'expected an eventType and data.id' });
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
  res.status(200).json({ status: 'ok' });
});

function unexpected(name, object, known) {
  const others = Object.keys(object).filter((key) => !known.includes(key));
  return others.length ? { [name]: others } : {};
}

module.exports = router;

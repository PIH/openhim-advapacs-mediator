const axios = require('axios');
const logger = require('./logger');
const openmrs = require('./openmrsClient');
const { splitOrders } = require('./orderBundle');
const modalityMap = require('./modalityMap');

let lastPolledAt = null;
let timer = null;

/**
 * Pull-based alternative to routes/serviceRequest.js's push endpoint, for
 * sites where OpenMRS has no event/module hook to POST new orders to us.
 * Cursors on _lastUpdated rather than tracking processed ids, so a
 * mediator restart re-anchors to "now" and will not replay a backlog --
 * any ServiceRequest created while the mediator was down is missed.
 * TODO: this will need to be improved if we want to use in Production!
 *
 * Each poll is one OpenMRS request per page of results, carrying everything
 * the relay needs for each order (see ORDER_INCLUDES in openmrsClient.js), so
 * relaying an order makes no further OpenMRS calls. If any page fails, nothing
 * is submitted and the cursor stays where it was, so the next poll searches the
 * same window again (submitting some orders twice would duplicate them in AdvaPACS).
 *
 * Submits each polled order, as an order Bundle (see orderBundle.js), to
 * OpenHIM's inbound channel (same urlPattern routes/serviceRequest.js's push
 * endpoint sits behind) rather than calling orderRelay.js directly, so this hop
 * is logged/retryable as an OpenHIM transaction instead of being invisible
 * in-process. A re-run replays the order as it was polled.
 */
async function pollOnce() {
  // Orders aren't relayed until the modality map has loaded (see orderRelay.js), so don't fetch them
  // yet either: the cursor stays put, and the first poll after it loads covers everything since
  if (!modalityMap.isLoaded()) return;

  const since = lastPolledAt;
  const polledAt = new Date().toISOString();

  let orders;
  try {
    orders = splitOrders(await openmrs.searchServiceRequests({
      lastUpdatedAfter: since
    }));
  } catch (err) {
    logger.error('OpenMRS ServiceRequest poll failed', { error: err.message });
    return;
  }
  lastPolledAt = polledAt;

  for (const order of orders) {
    const serviceRequest = order.entry[0].resource;
    try {
      await axios.post(
        `${process.env.OPENHIM_ROUTER_URL}/fhir/ServiceRequest`,
        order,
        {
          headers: {
            'Content-Type': 'application/fhir+json',
            'X-Mediator-Secret': process.env.MEDIATOR_INBOUND_SECRET
          },
          auth: {
            username: process.env.OPENHIM_INBOUND_CLIENT_ID,
            password: process.env.OPENHIM_INBOUND_CLIENT_PASSWORD
          }
        }
      );
    } catch (err) {
      logger.error('Failed to submit polled ServiceRequest to OpenHIM', {
        openmrsServiceRequestId: serviceRequest.id,
        error: err.message
      });
    }
  }

  if (orders.length) {
    logger.info(`Polled ${orders.length} ServiceRequest(s) from OpenMRS`);
  }
}

function start(intervalMs) {
  if (timer) return;
  lastPolledAt = new Date().toISOString();
  timer = setInterval(pollOnce, intervalMs);
  logger.info(`Started OpenMRS ServiceRequest poller (every ${intervalMs}ms)`);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, pollOnce };

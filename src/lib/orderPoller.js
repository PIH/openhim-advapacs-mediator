const axios = require('axios');
const logger = require('./logger');
const openmrs = require('./openmrsClient');
const { splitOrders } = require('./orderBundle');
const modalityMap = require('./modalityMap');
const radiologyOrders = require('./radiologyOrders');

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
 * Only radiology orders are submitted (LSO-263): the search returns every test order, lab orders
 * included, and FHIR2 can't filter them by order type, so each order's type is looked up in OpenMRS
 * (see radiologyOrders.js). TODO LSO-312: search for radiology orders only, once FHIR2 can.
 *
 * Submits each polled radiology order, as an order Bundle (see orderBundle.js), to
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

  // Before the cursor moves: if any order's type can't be read, nothing is submitted and the next poll
  // searches the same window again, so no radiology order is skipped. TODO LSO-312: drop this lookup
  // and filter in the search instead, once FHIR2 sends the order type as ServiceRequest.category
  const polledCount = orders.length;
  try {
    const radiology = [];
    for (const order of orders) {
      if (await radiologyOrders.isRadiologyOrder(order.entry[0].resource.id)) radiology.push(order);
    }
    orders = radiology;
  } catch (err) {
    logger.error('Could not tell which polled ServiceRequests are radiology orders; will search the same window again', {
      error: err.message
    });
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

  if (polledCount) {
    logger.info(`Polled ${polledCount} ServiceRequest(s) from OpenMRS, ${orders.length} of them radiology orders`);
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

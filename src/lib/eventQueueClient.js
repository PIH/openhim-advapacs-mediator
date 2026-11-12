const axios = require('axios');
const logger = require('./logger');

// Longer than the OpenHIM channel's 10s route timeout, so OpenHIM answers before we give up.
// validateStatus accepts every status: we judge the answer ourselves.
const client = axios.create({ timeout: 30000, validateStatus: () => true });

// Accepted = a 2xx, or a 5xx: OpenHIM routed the event, stored the transaction and queued any retry
// (500 on a route timeout or connection error, 503 mediator-error, 504). Every 4xx (401/403 login or
// access, 404 no channel, 400/413/429...) means OpenHIM did not take it, and OpenHIM does not retry those.
function isAccepted(status) {
  return (status >= 200 && status < 300) || status >= 500;
}

/**
 * Hands an AdvaPACS event to OpenHIM's "AdvaPACS Event Processing" channel, which routes it to the
 * mediator's processing endpoint with auto-retry. A 2xx or 5xx answer means OpenHIM stored
 * the transaction (and queued a retry if the route failed), so the event is accepted; any 4xx is not. Never throws and
 * never returns an axios object (they carry the password and the event body).
 * Resolves {accepted, status?, code?}.
 */
async function submitEvent(event) {
  try {
    const { status } = await client.post(`${process.env.OPENHIM_ROUTER_URL}/results/advapacs-event`, event, {
      auth: {
        username: process.env.OPENHIM_RESULTS_CLIENT_ID || 'advapacs-mediator',
        password: process.env.OPENHIM_RESULTS_CLIENT_PASSWORD
      },
      headers: { 'X-Mediator-Secret': process.env.MEDIATOR_INBOUND_SECRET },
      timeout: 30000
    });
    const accepted = isAccepted(status);
    if (accepted && status >= 300) {
      logger.warn('OpenHIM accepted an AdvaPACS event but the transaction failed and is queued for retry', { status });
    }
    return { accepted, status };
  } catch (err) {
    const result = { accepted: false };
    if (err && err.code) result.code = String(err.code);
    return result;
  }
}

module.exports = { submitEvent };

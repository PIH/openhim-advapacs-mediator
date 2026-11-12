const axios = require('axios');
const logger = require('./logger');
const { resultsClientId } = require('./resultsClient');

// Longer than the OpenHIM channel's 10s route timeout, so OpenHIM answers before we give up.
// validateStatus accepts every status: we judge the answer ourselves.
const client = axios.create({ timeout: 30000, validateStatus: () => true });

// All are needed to hand an event to OpenHIM; without them every event would fail or only get a 401.
const RESULTS_ENV_VARS = ['OPENHIM_ROUTER_URL', 'MEDIATOR_INBOUND_SECRET', 'OPENHIM_RESULTS_CLIENT_PASSWORD'];

// Accepted = a 2xx, or a 5xx that carries X-OpenHIM-TransactionID: OpenHIM sets that header only once it
// has stored the transaction, so it will queue the retry (500 on a route timeout or connection error, 503
// mediator-error, 504). A 5xx without it (a proxy 502/504, an OpenHIM error before storing) was not stored,
// and every 4xx (401/403 login or access, 404 no channel, 400/413/429...) was not taken and is not retried.
function isAccepted(status, headers) {
  if (status >= 200 && status < 300) return true;
  return status >= 500 && Boolean(headers && headers['x-openhim-transactionid']);
}

/**
 * Hands an AdvaPACS event to OpenHIM's "AdvaPACS Event Processing" channel, which routes it to the
 * mediator's processing endpoint with auto-retry. A 2xx answer, or a 5xx carrying X-OpenHIM-TransactionID, means
 * OpenHIM stored the transaction (and queued a retry if the route failed), so the event is accepted; anything else is not. Never throws and
 * never returns an axios object (they carry the password and the event body).
 * Resolves {accepted, status?, code?, missing?} (missing: names of unset variables, with code NOT_CONFIGURED).
 */
async function submitEvent(event) {
  const missing = RESULTS_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length) return { accepted: false, code: 'NOT_CONFIGURED', missing };
  try {
    const { status, headers } = await client.post(`${process.env.OPENHIM_ROUTER_URL}/results/advapacs-event`, event, {
      auth: {
        username: resultsClientId(),
        password: process.env.OPENHIM_RESULTS_CLIENT_PASSWORD
      },
      headers: { 'X-Mediator-Secret': process.env.MEDIATOR_INBOUND_SECRET }
    });
    const accepted = isAccepted(status, headers);
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

module.exports = { submitEvent, RESULTS_ENV_VARS };

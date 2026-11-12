const axios = require('axios');

// Longer than the OpenHIM channel's 10s route timeout, so OpenHIM answers before we give up.
// validateStatus accepts every status: we judge the answer ourselves.
const client = axios.create({ timeout: 30000, validateStatus: () => true });

// OpenHIM answers these when it did not take the event: our login was rejected or there is no channel.
const REJECTED = [401, 403, 404];

/**
 * Hands an AdvaPACS event to OpenHIM's "AdvaPACS Event Processing" channel, which routes it to the
 * mediator's processing endpoint with auto-retry. Any answer except 401/403/404 means OpenHIM stored
 * the transaction (and queued a retry if the route failed), so the event is accepted. Never throws and
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
    return { accepted: !REJECTED.includes(status), status };
  } catch (err) {
    const result = { accepted: false };
    if (err && err.code) result.code = String(err.code);
    return result;
  }
}

module.exports = { submitEvent };

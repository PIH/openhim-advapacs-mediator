const axios = require('axios');
const logger = require('./logger');

// Goes through the private OpenHIM results channel, authenticating as the
// results client. Never log request bodies: they hold patient identifiers
// and report text.
const client = axios.create({
  baseURL: `${process.env.OPENMRS_RESULTS_CHANNEL_URL}/ws/rest/v1/radiologyapp`,
  auth: {
    username: process.env.OPENHIM_RESULTS_CLIENT_ID || 'advapacs-mediator',
    password: process.env.OPENHIM_RESULTS_CLIENT_PASSWORD
  },
  timeout: 30000
});

async function post(path, body) {
  try {
    const { data } = await client.post(path, body);
    logger.info('radiologyapp import', { path, outcome: data && data.outcome });
    return data;
  } catch (err) {
    // Never let an axios error escape: it carries config.data (request body)
    // and config.auth (password). Throw a fresh Error with plain fields only.
    const status = err.response && err.response.status;
    const serverMessage = err.response && err.response.data && err.response.data.error;
    let message = `radiologyapp ${path} failed (${status || err.code || 'no response'})`;
    if (typeof serverMessage === 'string') message += `: ${serverMessage}`;
    const wrapped = new Error(message);
    if (status) wrapped.status = status;
    if (err.code) wrapped.code = err.code;
    throw wrapped;
  }
}

/** POST a study import. Resolves {outcome, encounterUuid}; rejects on any non-2xx. */
function importStudy(body) {
  return post('/studyimport', body);
}

/** POST a report import. Same contract as importStudy. */
function importReport(body) {
  return post('/reportimport', body);
}

module.exports = { importStudy, importReport };

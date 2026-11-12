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
    const serverMessage = err.response && err.response.data && err.response.data.error;
    if (serverMessage) {
      const wrapped = new Error(`radiologyapp ${path} failed (${err.response.status}): ${serverMessage}`);
      wrapped.response = err.response;
      throw wrapped;
    }
    throw err;
  }
}

/** POST a study import. Resolves {outcome, encounterUuid, studyCreated}; rejects on any non-2xx. */
function importStudy(body) {
  return post('/study', body);
}

/** POST a report import. Same contract as importStudy. */
function importReport(body) {
  return post('/report', body);
}

module.exports = { importStudy, importReport };

const axios = require('axios');
const logger = require('./logger');

const client = axios.create({
  baseURL: process.env.ADVAPACS_CHANNEL_URL,
  headers: {
    'Content-Type': 'application/fhir+json',
    // AdvaPACS uses its own ID/Secret scheme rather than OAuth2 bearer tokens.
    Authorization: `ID=${process.env.ADVAPACS_CLIENT_ID},Secret=${process.env.ADVAPACS_CLIENT_SECRET}`
  }
});

/**
 * Push a ServiceRequest (radiology order) into AdvaPACS. AdvaPACS creates
 * the corresponding worklist entry and returns the resource with its
 * own id, TODO: (should we?) store against the OpenMRS order for reconciliation.
 *
 * Goes through OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), which
 * auto-retries connection failures/timeouts to the real AdvaPACS host (see
 * scripts/setupOpenhim.js). It does NOT retry a 4xx/5xx *response* from
 * AdvaPACS itself -- that surfaces here as a normal rejected promise, caught
 * by callers (orderRelay.js's callers) with no further retry or alerting.
 */
async function createServiceRequest(serviceRequest) {
  const { data } = await client.post('/ServiceRequest', serviceRequest);
  logger.info('Pushed ServiceRequest to AdvaPACS', { advapacsId: data.id });
  return data;
}

/**
 * Push a Patient into AdvaPACS ahead of the ServiceRequest that references
 * it, so AdvaPACS has a matching patient record before it needs to resolve
 * the ServiceRequest.subject reference (see orderRelay.js).
 *
 * AdvaPACS's FHIR server doesn't support conditional update (PUT to a
 * search-qualified URL with no id) -- it 400s with HAPI-0418, insisting on
 * an id in the URL path. So the search-then-decide is done here instead:
 * search by identifierSystem|identifierValue, then PUT /Patient/{id} if
 * AdvaPACS already has that patient, or POST /Patient (create) if not.
 */
async function upsertPatient(patient, identifierSystem, identifierValue) {
  const { data: searchResults } = await client.get('/Patient', {
    params: { identifier: `${identifierSystem}|${identifierValue}` }
  });
  const existingId = searchResults.total > 0 ? searchResults.entry[0].resource.id : undefined;

  // FHIR update requires the body's id to match the URL's id (HAPI-0420
  // otherwise) -- `patient` still carries its origin system's id, so it must
  // be overwritten with AdvaPACS's own id here, not just addressed via URL.
  const { data } = existingId
    ? await client.put(`/Patient/${existingId}`, { ...patient, id: existingId })
    : await client.post('/Patient', patient);
  logger.info('Upserted Patient in AdvaPACS', { advapacsId: data.id });
  return data;
}

/**
 * Fetch a resource by absolute reference URL, used when a Subscription
 * notification arrives as a lightweight ping rather than a full resource
 * payload and we need to go fetch the ImagingStudy/DiagnosticReport ourselves.
 */
async function getResourceByUrl(url) {
  const { data } = await axios.get(url, { headers: client.defaults.headers });
  return data;
}

// TODO: currently disabled, test
/**
 * Register (or refresh) a FHIR Subscription with AdvaPACS so it will
 * rest-hook our webhook endpoint whenever an ImagingStudy or DiagnosticReport
 * changes. Run this once at mediator startup / deploy time, not per-request.
 */
async function ensureSubscription(webhookUrl, webhookSecret, criteria = 'ImagingStudy') {
  const subscription = {
    resourceType: 'Subscription',
    status: 'active',
    reason: 'openhim-advapacs-mediator result delivery',
    criteria,
    channel: {
      type: 'rest-hook',
      endpoint: webhookUrl,
      payload: 'application/fhir+json',
      header: [`Authorization: Bearer ${webhookSecret}`]
    }
  };
  const { data } = await client.post('/Subscription', subscription);
  logger.info('Registered AdvaPACS subscription', { criteria, id: data.id });
  return data;
}

module.exports = { createServiceRequest, upsertPatient, getResourceByUrl, ensureSubscription };

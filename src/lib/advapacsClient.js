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
 * Push the ordering clinician into AdvaPACS ahead of the ServiceRequest that
 * references it as its requester (see orderRelay.js). Same search-then-decide
 * as upsertPatient, for the same reason (no conditional update).
 */
async function upsertPractitioner(practitioner, identifierSystem, identifierValue) {
  const { data: searchResults } = await client.get('/Practitioner', {
    params: { identifier: `${identifierSystem}|${identifierValue}` }
  });
  const existingId = searchResults.total > 0 ? searchResults.entry[0].resource.id : undefined;

  const { data } = existingId
    ? await client.put(`/Practitioner/${existingId}`, { ...practitioner, id: existingId })
    : await client.post('/Practitioner', practitioner);
  logger.info('Upserted Practitioner in AdvaPACS', { advapacsId: data.id });
  return data;
}

/**
 * Search AdvaPACS's Organisations by identifier. Organisations (groups of
 * Sites) are read-only over FHIR -- they're set up in AdvaPACS admin.
 */
async function searchOrganizations(identifier) {
  const { data } = await client.get('/Organization', { params: { identifier } });
  return (data.entry || []).map((entry) => entry.resource);
}

/**
 * Search AdvaPACS's Sites (FHIR Locations) by identifier, limited to one
 * Organisation when organizationId is given. Like Organisations, Sites are
 * read-only over FHIR and set up in AdvaPACS admin.
 */
async function searchLocations(identifier, organizationId) {
  const params = { identifier };
  if (organizationId) params.organization = `Organization/${organizationId}`;
  const { data } = await client.get('/Location', { params });
  return (data.entry || []).map((entry) => entry.resource);
}

/**
 * Read a single resource (ImagingStudy, DiagnosticReport, ServiceRequest,
 * Patient, Practitioner, ...) from AdvaPACS by type and id. Resolves null when
 * AdvaPACS answers 404; any other error rejects. Logs only the type and id --
 * never anything from the body, which holds patient data.
 */
async function readResource(resourceType, id) {
  try {
    const { data } = await client.get(`/${resourceType}/${id}`);
    logger.info('Read resource from AdvaPACS', { resourceType, id });
    return data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      logger.info('Resource not found in AdvaPACS', { resourceType, id });
      return null;
    }
    throw err;
  }
}

module.exports = {
  readResource,
  createServiceRequest,
  upsertPatient,
  upsertPractitioner,
  searchOrganizations,
  searchLocations
};

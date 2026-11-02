const axios = require('axios');
const logger = require('./logger');

const baseURL = `${process.env.OPENMRS_BASE_URL}${process.env.OPENMRS_FHIR_PATH || '/ws/fhir2/R4'}`;

const client = axios.create({
  baseURL,
  auth: {
    username: process.env.OPENMRS_USERNAME,
    password: process.env.OPENMRS_PASSWORD
  },
  headers: { 'Content-Type': 'application/fhir+json' }
});

/**
 * Fetch a single FHIR resource from OpenMRS by type + id.
 * Used when the mediator only receives an id/reference and needs the full
 * ServiceRequest (e.g. to read the imaging modality, ordering provider, patient).
 */
async function getResource(resourceType, id) {
  const { data } = await client.get(`/${resourceType}/${id}`);
  return data;
}

/**
 * Look up the OpenMRS Patient resource so we can carry the right patient
 * identifier (not just the internal UUID) over to AdvaPACS.
 */
async function getPatient(patientId) {
  return getResource('Patient', patientId);
}

// TODO: not yet tested
/**
 * Write a result resource (DiagnosticReport or ImagingStudy) into OpenMRS.
 * OpenMRS FHIR2 module supports create via PUT-with-id or POST; POST is
 * used here and OpenMRS assigns the id.
 */
async function createResource(resourceType, resource) {
  const { data } = await client.post(`/${resourceType}`, resource);
  logger.info('Created resource in OpenMRS', { resourceType, id: data.id });
  return data;
}

// TODO: not yet tested
/**
 * Update the status of an existing ServiceRequest in OpenMRS, e.g. moving
 * it from "active" to "completed" once AdvaPACS reports the study is read.
 */
async function updateServiceRequestStatus(serviceRequestId, status) {
  const current = await getResource('ServiceRequest', serviceRequestId);
  current.status = status;
  const { data } = await client.put(`/ServiceRequest/${serviceRequestId}`, current);
  return data;
}

// Everything the relay needs for an order, fetched in the same request as the order itself: its
// Patient, ordering Practitioner, Encounter and, through Encounter.partOf, its Visit (FHIR2 represents a
// Visit as an Encounter; the Visit's location is the Visit Location). Encounter:part-of needs an OpenMRS
// whose FHIR2 has FM2-708 -- an older one rejects the search
const ORDER_INCLUDES = [
  ['_include', 'ServiceRequest:patient'],
  ['_include', 'ServiceRequest:requester'],
  ['_include', 'ServiceRequest:encounter'],
  ['_include:iterate', 'Encounter:part-of']
];

// A URLSearchParams rather than a plain object, so the repeated _include is sent as FHIR expects
// (axios would send an array as _include[]=...)
function orderSearchParams(params) {
  const searchParams = new URLSearchParams(params);
  ORDER_INCLUDES.forEach(([name, value]) => searchParams.append(name, value));
  return searchParams;
}

/**
 * Search for ServiceRequests with their ORDER_INCLUDES, used by lib/orderPoller.js to find orders
 * created/updated since the last poll. Follows the search's next links, so the result holds every
 * page's entries (each page carries the resources included for its own orders); rejects if any
 * page fails.
 */
async function searchServiceRequests({ status, lastUpdatedAfter } = {}) {
  const params = {};
  if (status) params.status = status;
  if (lastUpdatedAfter) params._lastUpdated = `gt${lastUpdatedAfter}`;

  let { data: page } = await client.get('/ServiceRequest', { params: orderSearchParams(params) });
  const entry = [...(page.entry || [])];

  for (let next = nextPageQuery(page); next; next = nextPageQuery(page)) {
    ({ data: page } = await client.get(`?${next}`));
    entry.push(...(page.entry || []));
  }

  return { resourceType: 'Bundle', type: 'searchset', entry };
}

// The query of a search Bundle's next link, if it has one. Only the query is used: FHIR2 builds the link
// from fhir2.uriPrefix or forwarded headers, so it can name a host this mediator can't (or shouldn't)
// reach, and a paging link addresses the FHIR base rather than /ServiceRequest
function nextPageQuery(bundle) {
  const next = (bundle.link || []).find((link) => link.relation === 'next');
  const queryStart = next && next.url ? next.url.indexOf('?') : -1;
  return queryStart >= 0 ? next.url.slice(queryStart + 1) : undefined;
}

/**
 * Fetch a single order with its ORDER_INCLUDES, as the same shape of Bundle a poll returns. A search by
 * _id rather than a read, as a read can't return included resources.
 */
async function getOrderBundle(serviceRequestId) {
  const { data } = await client.get('/ServiceRequest', { params: orderSearchParams({ _id: serviceRequestId }) });
  return data;
}

module.exports = {
  getResource,
  getPatient,
  createResource,
  updateServiceRequestStatus,
  searchServiceRequests,
  getOrderBundle
};

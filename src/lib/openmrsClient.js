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

// OpenMRS's own REST API, for what FHIR2 doesn't expose as needed: a concept's mappings (see
// getConceptsMappedToSource). With a timeout, so a hung OpenMRS can't hold up the mediator's startup
// or stop lib/modalityMap.js's refreshes for good
const restClient = axios.create({
  baseURL: `${process.env.OPENMRS_BASE_URL}/ws/rest/v1`,
  auth: {
    username: process.env.OPENMRS_USERNAME,
    password: process.env.OPENMRS_PASSWORD
  },
  timeout: 30000
});

/**
 * Fetch a single FHIR resource from OpenMRS by type + id. Not used to relay orders, which arrive
 * with everything they need (see getOrderBundle); used by updateServiceRequestStatus.
 */
async function getResource(resourceType, id) {
  const { data } = await client.get(`/${resourceType}/${id}`);
  return data;
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

  // A next link that repeats would page forever; rejecting leaves the poller's cursor where it was
  const seen = new Set();
  for (let next = nextPageQuery(page); next; next = nextPageQuery(page)) {
    if (seen.has(next)) throw new Error(`ServiceRequest search's next link repeats (${next})`);
    seen.add(next);
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
  if (!next) return undefined;
  // Rejected rather than treated as the last page, which would skip the remaining pages' orders
  const queryStart = next.url ? next.url.indexOf('?') : -1;
  if (queryStart < 0) throw new Error(`ServiceRequest search's next link has no query (${next.url})`);
  return next.url.slice(queryStart + 1);
}

/**
 * Fetch a single order with its ORDER_INCLUDES, as the same shape of Bundle a poll returns. A search by
 * _id rather than a read, as a read can't return included resources.
 */
async function getOrderBundle(serviceRequestId) {
  const { data } = await client.get('/ServiceRequest', { params: orderSearchParams({ _id: serviceRequestId }) });
  return data;
}

const CONCEPT_MAPPINGS_REP = 'custom:(uuid,mappings:(conceptReferenceTerm:(code,conceptSource:(uuid,name))))';
// webservices.rest's usual absolute maximum page size
const CONCEPT_PAGE_SIZE = 100;

/**
 * Every non-retired concept with a mapping to a concept source (by name or uuid), with its mappings, as
 * webservices.rest's concept search by source returns them: once per mapping to the source, so a
 * concept can appear more than once. Follows every page; rejects if any page fails. Used by
 * lib/modalityMap.js to load the concept -> DICOM modality table.
 */
async function getConceptsMappedToSource(source) {
  const concepts = [];
  const seen = new Set();
  let startIndex = 0;
  for (;;) {
    const { data: page } = await restClient.get('/concept', {
      params: { source, v: CONCEPT_MAPPINGS_REP, limit: CONCEPT_PAGE_SIZE, startIndex }
    });
    concepts.push(...(page.results || []));

    const next = nextStartIndex(page);
    if (next === undefined) return concepts;
    // A next link that repeats would page forever
    if (seen.has(next)) throw new Error(`Concept search's next link repeats (startIndex=${next})`);
    seen.add(next);
    startIndex = next;
  }
}

// The startIndex of a REST search page's next link, if it has one. Only its startIndex is used: like
// FHIR2's, the link can name a host this mediator can't (or shouldn't) reach
function nextStartIndex(page) {
  const next = (page.links || []).find((link) => link.rel === 'next');
  if (!next) return undefined;
  const queryStart = next.uri ? next.uri.indexOf('?') : -1;
  const startIndex = queryStart < 0 ? null : new URLSearchParams(next.uri.slice(queryStart + 1)).get('startIndex');
  if (startIndex === null || !/^\d+$/.test(startIndex)) {
    throw new Error(`Concept search's next link has no startIndex (${next.uri})`);
  }
  return Number(startIndex);
}

module.exports = {
  getResource,
  createResource,
  updateServiceRequestStatus,
  searchServiceRequests,
  getOrderBundle,
  getConceptsMappedToSource
};

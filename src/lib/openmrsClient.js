const axios = require('axios');
const logger = require('./logger');

const baseURL = `${process.env.OPENMRS_BASE_URL}${process.env.OPENMRS_FHIR_PATH || '/ws/fhir2/R4'}`;
const restBaseURL = `${process.env.OPENMRS_BASE_URL}/ws/rest/v1`;

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

// TODO: not yet tested
/**
 * Search for ServiceRequests, used by lib/orderPoller.js to find orders
 * created/updated since the last poll instead of waiting for a push.
 */
async function searchServiceRequests({ status, lastUpdatedAfter } = {}) {
  const params = {};
  if (status) params.status = status;
  if (lastUpdatedAfter) params._lastUpdated = `gt${lastUpdatedAfter}`;
  const { data } = await client.get('/ServiceRequest', { params });
  return data;
}

/**
 * The order's clinical history (indications), from the OpenMRS REST API: fhir2 doesn't put
 * TestOrder.clinicalHistory on the ServiceRequest. The FHIR ServiceRequest id is the order uuid.
 * Resolves to the text, or null when the order has none.
 */
async function getOrderClinicalHistory(orderUuid) {
  const { data } = await client.get(`${restBaseURL}/order/${orderUuid}`, {
    params: { v: 'custom:(clinicalHistory)' },
    headers: { Accept: 'application/json' }
  });
  return (data && data.clinicalHistory) || null;
}

module.exports = {
  getOrderClinicalHistory,
  getResource,
  getPatient,
  createResource,
  updateServiceRequestStatus,
  searchServiceRequests
};

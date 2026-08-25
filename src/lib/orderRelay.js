const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

// TODOs:UHM-9437, UHM-9439, UHM-9440

const ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;

const PLACER_ORDER_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-order-number';
const ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

const PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE = 'PI';

const ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM = 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code';

/**
 * Core order-relay logic, independent of how the ServiceRequest arrived
 * (HTTP push from routes/serviceRequest.js, or a scheduled poll from
 * lib/orderPoller.js). Accepts either a full ServiceRequest resource or
 * a minimal { serviceRequestId } reference.
 */
async function relayServiceRequest(input) {
  const serviceRequest = input.resourceType === 'ServiceRequest'
    ? input
    : await openmrs.getResource('ServiceRequest', input.serviceRequestId);

  const patientRef = serviceRequest.subject && serviceRequest.subject.reference;
  const patientId = patientRef && patientRef.split('/').pop();

  // fetch the patient from OpenMRS
  const patient = patientId ? await openmrs.getPatient(patientId) : null;

  if (!patient) {
    throw new Error(`ServiceRequest ${serviceRequest.id} references non-existent Patient ${patientId}`);
  }
  const emrIdentifier = (patient.identifier || []).find(
    (identifier) => identifier.system === ADVAPACS_PATIENT_IDENTIFIER_SYSTEM
  );
  if (!emrIdentifier) {
    throw new Error(`Patient ${patient.id} has no identifier for system ${ADVAPACS_PATIENT_IDENTIFIER_SYSTEM}`);
  }
  // Stamp the same emrIdentifier found above with the HL7 PI coding, then
  // substitute it back into place (by reference) among the patient's other
  // identifiers, which are otherwise sent through unchanged.
  const stampedEmrIdentifier = withPatientInternalIdentifierTypeCoding(emrIdentifier);
  const outboundPatient = {
    ...patient,
    identifier: patient.identifier.map(
      (identifier) => identifier === emrIdentifier ? stampedEmrIdentifier : identifier
    )
  };

  // Send the Patient first so AdvaPACS has a matching record before it
  // needs to resolve the ServiceRequest's subject reference. Upserted
  // (matched on emrIdentifier) rather than always created
  const createdPatient = await advapacs.upsertPatient(outboundPatient, emrIdentifier.system, emrIdentifier.value);

  // create a new subject reference unsing the AdvaPACS-assigned patient id
  const outboundSubject = {
    reference: `Patient/${createdPatient.id}`,
    display: patientNameOf(patient)
  };

  // TODO: OpenMRS ServiceRequests are arriving here already marked "completed"
  // due to a workaround in the Radiology app module
  // (this mediator can't filter orderPoller.js's search by status server-side --
  // this OpenMRS FHIR2 module doesn't support a status search param on
  // ServiceRequest at all). Any other status currently (cancelled, on-hold, etc.) passes
  // through unchanged. We will need to build support for different status
  const outboundStatus = serviceRequest.status === 'completed' ? 'draft' : serviceRequest.status;

  // strip out the OpenMRS-specific and OpenMRS Reference fields we don't want to send to AdvaPACS
  const { encounter, requester, occurrencePeriod, id, meta, text, ...serviceRequestWithoutStrippedFields } = serviceRequest;

  const outboundServiceRequest = {
    ...serviceRequestWithoutStrippedFields,
    identifier: withAccessionNumber(serviceRequest.identifier),
    subject: outboundSubject,
    status: outboundStatus,
    // AdvaPACS's R5 endpoint models ServiceRequest.code as a CodeableReference,
    // not R4's flat CodeableConcept -- wrap it under "concept".
    code: toCodeableReference(withoutSystemlessCoding(serviceRequest.code)),
    // AdvaPACS only accepts the occurrenceDateTime variant of this FHIR choice
    // type, not occurrencePeriod -- collapse to a single instant via .start
    // (OpenMRS only ever sends a point-in-time period, start === end).
    occurrenceDateTime: serviceRequest.occurrenceDateTime || (occurrencePeriod && occurrencePeriod.start),
    // TODO(UHM-9445): hardcoded to X-ray (modality "CR") -- every order this
    // integration currently handles is an X-ray. OpenMRS's ServiceRequest
    // carries no field indicating imaging modality today, so there's nothing
    // to derive this from yet. Replace with a real per-order-type modality
    // mapping once that ticket is scoped.
    orderDetail: [{
      parameter: [{
        code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code: 'modality' }] },
        valueString: 'CR'
      }]
    }]
  };

  // send ServiceRequest to AdvaPACS
  const created = await advapacs.createServiceRequest(outboundServiceRequest);

  logger.info('Order relayed to AdvaPACS', {
    openmrsServiceRequestId: serviceRequest.id,
    advapacsServiceRequestId: created.id
  });

  return { serviceRequest, created };
}

// TODO: generate an accession number in OpenMRS, till then:
// Stamps the placer (order-number) identifier with our own system, and adds
// a separate accession-number identifier carrying the same value (with the
// HL7 "ACSN" type coding) alongside it -- AdvaPACS expects the accession
// number as its own identifier
function withAccessionNumber(identifiers = []) {
  const stamped = identifiers.map((identifier) => {
    const isPlacer = identifier.type && identifier.type.coding &&
      identifier.type.coding.some((coding) => coding.code === 'PLAC');
    return isPlacer ? { ...identifier, system: PLACER_ORDER_NUMBER_SYSTEM } : identifier;
  });

  const placer = stamped.find((identifier) => identifier.system === PLACER_ORDER_NUMBER_SYSTEM);
  return placer
    ? [...stamped, {
      system: ACCESSION_NUMBER_SYSTEM,
      value: placer.value,
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }] }
    }]
    : stamped;
}

// TODO(UHM-9443): temporary stopgap until OpenMRS itself emits a correctly
// coded identifier type. AdvaPACS requires the patient's EMR-ID identifier
// to carry the standard HL7 "PI" (Patient Internal Identifier) coding in its
// type.coding array -- OpenMRS's own type.coding only has its internal
// concept UUID, no system. Added alongside the existing coding(s), not
// replacing them: CodeableConcept is designed to hold multiple equivalent
// representations of the same concept. Prepended rather than appended:
// live-testing against the real AdvaPACS API showed it only validates
// type.coding[0], so the added coding has to come first or AdvaPACS never
// sees it.
function withPatientInternalIdentifierTypeCoding(identifier) {
  const existingCoding = (identifier.type && identifier.type.coding) || [];
  const alreadyPresent = existingCoding.some(
    (coding) => coding.system === PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM &&
      coding.code === PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE
  );
  if (alreadyPresent) return identifier;

  return {
    ...identifier,
    type: {
      ...identifier.type,
      coding: [{ system: PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM, code: PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE }, ...existingCoding]
    }
  };
}

// OpenMRS's ServiceRequest.code includes its own system-less internal concept coding alongside the mapped
// LOINC/SNOMED codings -- drop this and any other system-less codings.
// TODO: do we really need this?
function withoutSystemlessCoding(code) {
  if (!code || !Array.isArray(code.coding)) return code;
  return { ...code, coding: code.coding.filter((coding) => coding.system) };
}

// AdvaPACS's R5 ServiceRequest.code is a CodeableReference ({ concept, reference }),
// not R4's flat CodeableConcept -- wrap the CodeableConcept under "concept".
function toCodeableReference(concept) {
  return concept ? { concept } : undefined;
}

function patientNameOf(patient) {
  const name = patient.name && patient.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };

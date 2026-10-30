const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

// TODOs:UHM-9437, UHM-9439, UHM-9440

const ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
const ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM;

const PLACER_ORDER_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-order-number';
const ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

const PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE = 'PI';

const ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM = 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code';

const DICOM_CODE_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM';
const DEFAULT_MODALITY = 'CR';

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
  // identifiers. System-less identifiers are dropped (see withoutSystemlessIdentifiers);
  // the rest are sent through unchanged.
  const stampedEmrIdentifier = withPatientInternalIdentifierTypeCoding(emrIdentifier);
  const outboundPatient = {
    ...patient,
    identifier: withoutSystemlessIdentifiers(patient.identifier).map(
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
    display: displayNameOf(patient)
  };

  // Likewise send the ordering clinician (if any) first, and reference them by
  // their AdvaPACS-assigned Practitioner id
  const outboundRequester = await relayRequester(serviceRequest.requester);

  // TODO: OpenMRS ServiceRequests are arriving here already marked "completed"
  // due to a workaround in the Radiology app module
  // (this mediator can't filter orderPoller.js's search by status server-side --
  // this OpenMRS FHIR2 module doesn't support a status search param on
  // ServiceRequest at all). Any other status currently (cancelled, on-hold, etc.) passes
  // through unchanged. We will need to build support for different status
  const outboundStatus = serviceRequest.status === 'completed' ? 'draft' : serviceRequest.status;

  // strip out the OpenMRS-specific and OpenMRS Reference fields we don't want to send to AdvaPACS
  const { encounter, requester, occurrencePeriod, id, meta, text, note, ...serviceRequestWithoutStrippedFields } = serviceRequest;

  const outboundServiceRequest = {
    ...serviceRequestWithoutStrippedFields,
    identifier: withAccessionNumber(serviceRequest.identifier),
    subject: outboundSubject,
    requester: outboundRequester,
    status: outboundStatus,
    // AdvaPACS's R5 endpoint models ServiceRequest.code as a CodeableReference,
    // not R4's flat CodeableConcept -- wrap it under "concept".
    code: toCodeableReference(withoutDicomCoding(withoutSystemlessCoding(serviceRequest.code))),
    // AdvaPACS only accepts the occurrenceDateTime variant of this FHIR choice
    // type, not occurrencePeriod -- collapse to a single instant via .start
    // (OpenMRS only ever sends a point-in-time period, start === end).
    occurrenceDateTime: serviceRequest.occurrenceDateTime || (occurrencePeriod && occurrencePeriod.start),
    orderDetail: [{
      parameter: [{
        code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code: 'modality' }] },
        valueString: modalityOf(serviceRequest.code)
      }, ...clinicalHistoryParameters(note), ...procedureDescriptionParameters(serviceRequest.code)]
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

// OpenMRS emits an identifier with no system when its identifier type has no FHIR
// system mapped (e.g. "MDR-TB ID"), and AdvaPACS rejects the whole Patient with a
// 422 "Identifier system required" -- drop any such identifiers.
// TODO: map FHIR systems for these identifier types in OpenMRS instead?
function withoutSystemlessIdentifiers(identifiers) {
  return identifiers.filter((identifier) => identifier.system);
}

// The orderable's imaging modality comes from its concept mapping to the DICOM code
// system (UHM-9634), which OpenMRS sends as one of the ServiceRequest.code codings.
// Falls back to X-ray ("CR") for orderables without one.
function modalityOf(code) {
  const dicomCoding = code && Array.isArray(code.coding) &&
    code.coding.find((coding) => coding.system === DICOM_CODE_SYSTEM && coding.code);
  return dicomCoding ? dicomCoding.code : DEFAULT_MODALITY;
}

// The DICOM modality coding is sent as AdvaPACS's "modality" parameter instead (see
// modalityOf), so drop it from code -- it isn't a procedure code, and AdvaPACS only
// keeps code.concept.coding[0], so it mustn't end up first.
function withoutDicomCoding(code) {
  if (!code || !Array.isArray(code.coding)) return code;
  return { ...code, coding: code.coding.filter((coding) => coding.system !== DICOM_CODE_SYSTEM) };
}

// AdvaPACS's R5 ServiceRequest.code is a CodeableReference ({ concept, reference }),
// not R4's flat CodeableConcept -- wrap the CodeableConcept under "concept".
function toCodeableReference(concept) {
  return concept ? { concept } : undefined;
}

// Fetches the ServiceRequest's requester (the ordering clinician) from OpenMRS,
// upserts it into AdvaPACS, and returns a reference to it by its AdvaPACS id.
// The ordering clinician is nice-to-have, not worth losing the order over: if
// anything goes wrong, logs a warning and returns undefined, so the
// ServiceRequest is sent without one.
async function relayRequester(requester) {
  const [resourceType, practitionerId] = ((requester && requester.reference) || '').split('/').slice(-2);
  if (resourceType !== 'Practitioner' || !practitionerId) return undefined;

  if (!ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM) {
    logger.warn('ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM is not set; sending ServiceRequest without a requester', {
      openmrsPractitionerId: practitionerId
    });
    return undefined;
  }

  try {
    const practitioner = await openmrs.getResource('Practitioner', practitionerId);

    // Matched in AdvaPACS on the OpenMRS provider UUID
    const uuidIdentifier = { system: ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM, value: practitioner.id };
    const outboundPractitioner = { ...toOutboundPractitioner(practitioner), identifier: [uuidIdentifier] };

    const createdPractitioner = await advapacs.upsertPractitioner(
      outboundPractitioner, ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM, practitioner.id
    );
    return {
      reference: `Practitioner/${createdPractitioner.id}`,
      display: displayNameOf(practitioner)
    };
  } catch (err) {
    logger.warn('Failed to relay ordering clinician to AdvaPACS; sending ServiceRequest without a requester', {
      openmrsPractitionerId: practitionerId,
      error: err.message
    });
    return undefined;
  }
}

// OpenMRS sends the order's clinical history as a note, but we do the following
// conversion so it shows up in AdvaPACS under the "clinical history" section of the report
// rather than as a note, see comments on: https://pihemr.atlassian.net/browse/UHM-9434
function clinicalHistoryParameters(notes = []) {
  const clinicalHistory = notes.map((note) => note.text).filter(Boolean).join('\n');
  return clinicalHistory
    ? [{
      code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code: 'clinical-history' }] },
      valueString: clinicalHistory
    }]
    : [];
}

// AdvaPACS keeps only the system and code of code.concept.coding[0], dropping
// code.concept.text and any coding display -- so the procedure name is sent as a
// "requested-procedure-description" parameter instead, see UHM-9631.
// "requested-procedure-description" is AdvaPACS-specific, not a standard FHIR code: it comes
// from AdvaPACS's own orderDetail parameter code system (ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM)
function procedureDescriptionParameters(code) {
  const description = code && code.text;
  return description
    ? [{
      code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code: 'requested-procedure-description' }] },
      valueString: description
    }]
    : [];
}

// Only the fields AdvaPACS's Practitioner docs list as supported -- drops
// OpenMRS's id/meta/text and its provider extensions. (identifier is set by
// the caller.)
function toOutboundPractitioner({ name, telecom, address, birthDate, gender }) {
  return { resourceType: 'Practitioner', name, telecom, address, birthDate, gender };
}

function displayNameOf(person) {
  const name = person.name && person.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };

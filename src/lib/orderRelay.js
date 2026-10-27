const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

// TODOs:UHM-9437, UHM-9439, UHM-9440

const ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
const ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM;

// Order identifier systems (namespaces) used in AdvaPACS: OpenMRS gives the order number without a
// system. Defaults are PIH Lesotho's; a site that keeps its own namespace in a shared tenant overrides
// them (see .env.example). The patient's system comes from OpenMRS (ADVAPACS_PATIENT_IDENTIFIER_SYSTEM).
const PLACER_ORDER_NUMBER_SYSTEM = process.env.ADVAPACS_PLACER_ORDER_NUMBER_SYSTEM ||
  'http://www.pih.org/identifiers/lesotho/radiology-order-number';
const ACCESSION_NUMBER_SYSTEM = process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM ||
  'http://www.pih.org/identifiers/lesotho/radiology-accession-number';


const PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
// The identifier's type must match its assigning authority's type in AdvaPACS (else 422 "Invalid
// type"): PIH-LESOTHO-EMR-ID is PI; a site whose authority has another type (e.g. PN) sets
// ADVAPACS_PATIENT_IDENTIFIER_TYPE_CODE.
const PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE = process.env.ADVAPACS_PATIENT_IDENTIFIER_TYPE_CODE || 'PI';

const ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM = 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code';
const DICOM_UID_SYSTEM = 'urn:dicom:uid';

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

  const clinicalHistory = await clinicalHistoryOf(serviceRequest.id);

  // strip out the OpenMRS-specific and OpenMRS Reference fields we don't want to send to AdvaPACS
  const { encounter, requester, occurrencePeriod, id, meta, text, ...serviceRequestWithoutStrippedFields } = serviceRequest;

  const outboundServiceRequest = {
    ...serviceRequestWithoutStrippedFields,
    identifier: withAccessionNumber(serviceRequest.identifier),
    subject: outboundSubject,
    requester: outboundRequester,
    note: withNoteAuthor(serviceRequest.note, outboundRequester),
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
      parameter: [
        orderDetailParameter('modality', 'CR'),
        // Shown as the order's Clinical History in AdvaPACS (Orders panel, RADPAIR)
        ...(clinicalHistory ? [orderDetailParameter('clinical-history', clinicalHistory)] : [])
      ]
    }]
  };

  // Optional, per site (both unset on Kol-CI):
  // ADVAPACS_PERFORMER_REFERENCE, e.g. "Device/<id>": the site's modality, so a shared tenant's
  // sites can tell their orders apart (and a site's modality worklist picks up only its own).
  if (process.env.ADVAPACS_PERFORMER_REFERENCE) {
    outboundServiceRequest.performer = [{ reference: process.env.ADVAPACS_PERFORMER_REFERENCE }];
  }
  // ADVAPACS_ASSIGN_STUDY_UID=true: give the order a Study Instance UID, derived from the OpenMRS
  // order uuid (stable across re-sends), for modality worklists that need one up front.
  if (process.env.ADVAPACS_ASSIGN_STUDY_UID === 'true' && isUuid(serviceRequest.id)) {
    outboundServiceRequest.identifier = [
      ...outboundServiceRequest.identifier,
      { system: DICOM_UID_SYSTEM, value: `urn:oid:${studyUidFromUuid(serviceRequest.id)}` }
    ];
  }

  // The poller sees an order again whenever OpenMRS updates it: create it in AdvaPACS only once.
  const accession = outboundServiceRequest.identifier.find((i) => i.system === ACCESSION_NUMBER_SYSTEM);
  const existing = accession
    ? await advapacs.findServiceRequestByIdentifier(ACCESSION_NUMBER_SYSTEM, accession.value)
    : null;
  if (existing) {
    logger.info('Order already in AdvaPACS; not sent again',
      { openmrsServiceRequestId: serviceRequest.id, advapacsServiceRequestId: existing.id });
    return { serviceRequest, created: existing, alreadyPresent: true };
  }

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
// The system-less coding is the one that carries OpenMRS's display name: give the remaining codings
// the order's name (code.text) when they have none, so AdvaPACS and modality worklists show it.
function withoutSystemlessCoding(code) {
  if (!code || !Array.isArray(code.coding)) return code;
  return {
    ...code,
    coding: code.coding
      .filter((coding) => coding.system)
      .map((coding) => (coding.display || !code.text ? coding : { ...coding, display: code.text }))
  };
}

// OpenMRS emits an identifier with no system when its identifier type has no FHIR
// system mapped (e.g. "MDR-TB ID"), and AdvaPACS rejects the whole Patient with a
// 422 "Identifier system required" -- drop any such identifiers.
// TODO: map FHIR systems for these identifier types in OpenMRS instead?
function withoutSystemlessIdentifiers(identifiers) {
  return identifiers.filter((identifier) => identifier.system);
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

// OpenMRS sends the order's clinical history as a note with no author, and
// AdvaPACS rejects the whole ServiceRequest with a 422 "Invalid note: Missing
// author" -- make the ordering clinician (the requester) the author. With no
// requester, notes are sent unchanged.
function withNoteAuthor(notes, requester) {
  if (!notes || !requester) return notes;
  return notes.map((note) => (note.authorReference || note.authorString)
    ? note
    : { authorReference: { reference: requester.reference }, ...note });
}

// Only the fields AdvaPACS's Practitioner docs list as supported -- drops
// OpenMRS's id/meta/text and its provider extensions. (identifier is set by
// the caller.)
function toOutboundPractitioner({ name, telecom, address, birthDate, gender }) {
  return { resourceType: 'Practitioner', name, telecom, address, birthDate, gender };
}

// The order's clinical history, or null. Never fails the relay: the order matters more.
async function clinicalHistoryOf(orderUuid) {
  if (!orderUuid) return null;
  try {
    return await openmrs.getOrderClinicalHistory(orderUuid);
  } catch (err) {
    logger.warn('Could not read the order\'s clinical history from OpenMRS; sending the order without it',
      { openmrsServiceRequestId: orderUuid, error: err.message });
    return null;
  }
}

function orderDetailParameter(code, valueString) {
  return { code: { coding: [{ system: ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM, code }] }, valueString };
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.replace(/-/g, ''));
}

// DICOM UID from a UUID (PS3.5 B.2: "2.25." + the UUID as an unsigned decimal integer)
function studyUidFromUuid(uuid) {
  return `2.25.${BigInt(`0x${uuid.replace(/-/g, '')}`).toString()}`;
}

function displayNameOf(person) {
  const name = person.name && person.name[0];
  if (!name) return undefined;
  return [...(name.given || []), name.family].filter(Boolean).join(' ');
}

module.exports = { relayServiceRequest };

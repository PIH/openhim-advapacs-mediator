const logger = require('./logger');
const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');
const { resolveSite } = require('./siteLocation');
const { readOrder } = require('./orderBundle');
const modalityMap = require('./modalityMap');
const { accessionNumberSystem } = require('./identifiers');

// TODOs:UHM-9437, UHM-9439, UHM-9440

const ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
const ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM;

const PLACER_ORDER_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-order-number';

const PATIENT_INTERNAL_IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const PATIENT_INTERNAL_IDENTIFIER_TYPE_CODE = 'PI';

const ADVAPACS_ORDER_DETAIL_PARAMETER_CODE_SYSTEM = 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code';

const DICOM_CODE_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM';
const DEFAULT_MODALITY = 'CR';

/**
 * Core order-relay logic, independent of how the order arrived at routes/serviceRequest.js. Accepts:
 * - an order Bundle (see orderBundle.js): the ServiceRequest with its Patient, Practitioner, Encounter
 *   and Visit, as lib/orderPoller.js sends each polled order, so relaying it makes no OpenMRS calls;
 * - a minimal { serviceRequestId }, for which the order Bundle is fetched in one OpenMRS request.
 */
async function relayServiceRequest(input) {
  // Hold every order until the modality map has loaded, rather than send one with a guessed modality.
  // First, so nothing at all reaches AdvaPACS; the caller is answered so OpenHIM retries it later
  if (!modalityMap.isLoaded()) throw new modalityMap.ModalityMapNotLoadedError();

  const order = readOrder(await orderBundleFor(input));
  const { serviceRequest } = order;

  // The AdvaPACS Site the order belongs to, from its OpenMRS Visit Location, and the Site's
  // Organisation (see siteLocation.js). Worked out before anything is sent, so if it can't be,
  // AdvaPACS is left untouched and the order can be re-run from OpenHIM once fixed
  const site = await resolveSite(order);

  if (!serviceRequest.subject || !serviceRequest.subject.reference) {
    throw new Error(`ServiceRequest ${serviceRequest.id} has no subject Patient`);
  }
  const patient = order.find(serviceRequest.subject);
  if (!patient) {
    throw new Error(`ServiceRequest ${serviceRequest.id} references Patient ` +
      `${serviceRequest.subject.reference.split('/').pop()}, which is not in its order Bundle`);
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
  const outboundRequester = await relayRequester(serviceRequest.requester, order.find(serviceRequest.requester));

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
    ...(site && { location: site.location, performer: site.performer }),
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
        valueString: modalityOf(serviceRequest.code, serviceRequest.id)
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

async function orderBundleFor(input) {
  if (input && input.resourceType === 'Bundle') return input;

  // In preparation for an OpenMRS module that pushes the ids of new orders to OpenHIM, instead of this
  // mediator polling for full orders: the order is then fetched here, in the one request a poll makes.
  // If push is implemented some other way, this input should likely be removed
  if (input && input.serviceRequestId) return openmrs.getOrderBundle(input.serviceRequestId);

  throw new Error('Expected an order Bundle or { serviceRequestId }');
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
      system: accessionNumberSystem(),
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

// The orderable's imaging modality, from the mediator's modality map (UHM-9616, see modalityMap.js):
// looked up by the order's concept, which OpenMRS sends as the ServiceRequest.code coding with no system
// (the concept uuid). The ServiceRequest's own DICOM coding is deliberately ignored: FHIR2 sends at most
// one code per source and map type, picked arbitrarily (FM2-710). Falls back to X-ray ("CR"), with a
// warning, for an orderable that isn't in the map. (Orders aren't relayed at all until it has loaded.)
function modalityOf(code, serviceRequestId) {
  const conceptCoding = code && Array.isArray(code.coding) && code.coding.find((coding) => !coding.system && coding.code);
  const conceptUuid = conceptCoding ? conceptCoding.code : undefined;

  const modality = conceptUuid && modalityMap.modalityFor(conceptUuid);
  if (modality) return modality;

  logger.warn(`Orderable not in the modality map (no DICOM mapping); sending modality ${DEFAULT_MODALITY}`, {
    openmrsServiceRequestId: serviceRequestId, conceptUuid
  });
  return DEFAULT_MODALITY;
}

// Drop any DICOM modality coding from code: it isn't a procedure code, and AdvaPACS only keeps
// code.concept.coding[0], so it mustn't end up first. (The modality goes in AdvaPACS's "modality"
// parameter instead, see modalityOf.) Only needed until every site's OpenMRS stops sending it
// (UHM-9616: pihemr's DCM FHIR concept source removed).
function withoutDicomCoding(code) {
  if (!code || !Array.isArray(code.coding)) return code;
  return { ...code, coding: code.coding.filter((coding) => coding.system !== DICOM_CODE_SYSTEM) };
}

// AdvaPACS's R5 ServiceRequest.code is a CodeableReference ({ concept, reference }),
// not R4's flat CodeableConcept -- wrap the CodeableConcept under "concept".
function toCodeableReference(concept) {
  return concept ? { concept } : undefined;
}

// Upserts the ServiceRequest's requester (the ordering clinician, read from the order Bundle) into
// AdvaPACS, and returns a reference to it by its AdvaPACS id.
// The ordering clinician is nice-to-have, not worth losing the order over: if
// anything goes wrong, logs a warning and returns undefined, so the
// ServiceRequest is sent without one.
async function relayRequester(requester, practitioner) {
  const [resourceType, practitionerId] = ((requester && requester.reference) || '').split('/').slice(-2);
  if (resourceType !== 'Practitioner' || !practitionerId) return undefined;

  if (!ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM) {
    logger.warn('ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM is not set; sending ServiceRequest without a requester', {
      openmrsPractitionerId: practitionerId
    });
    return undefined;
  }

  if (!practitioner) {
    logger.warn('Ordering clinician is not in the order Bundle; sending ServiceRequest without a requester', {
      openmrsPractitionerId: practitionerId
    });
    return undefined;
  }

  try {

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

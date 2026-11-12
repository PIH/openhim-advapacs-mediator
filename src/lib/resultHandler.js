// Turns an AdvaPACS webhook event into an OpenMRS radiologyapp study/report import.
// Never log patient identifiers, report text or conclusions, or whole error objects
// (an axios error holds the AdvaPACS credentials in its config).
const logger = require('./logger');
const { readResource } = require('./advapacsClient');
const { importStudy, importReport } = require('./radiologyappClient');
const mapper = require('./resultMapper');
const { identifierValue, accessionNumber } = require('./identifiers');

const VALID_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const OUTCOMES_TO_WARN = ['NO_MATCHING_ORDER', 'PATIENT_MISMATCH'];
const SUPPORTED_EVENTS = ['STUDY_CREATED', 'REPORT_CREATED', 'REPORT_UPDATED'];

// Thrown inside the flow to end it with a deliberate skip.
class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// One event at a time, in arrival order: concurrent final events for one report must
// not both create it.
let queue = Promise.resolve();

function safeError(err) {
  const out = { message: err && err.message };
  if (err && err.status) out.status = err.status;
  if (err && err.code) out.code = err.code;
  return out;
}

// OpenMRS's date conversion rejects what AdvaPACS may send (microsecond fractions, partial dates), so every
// date is parsed here and sent as an ISO string. Returns null for a missing or unparseable value; a bare
// year or year-month has no time and is unparseable too.
function isoDate(value) {
  if (typeof value !== 'string' || /^\d{4}(-\d{2})?$/.test(value.trim())) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function read(type, id, ctx) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw new Skip('invalid id');
  const resource = await readResource(type, id);
  if (resource && Array.isArray(resource.identifier)) {
    resource.identifier.forEach((i) => {
      if (i && typeof i.system === 'string') ctx.systemsSeen.add(i.system);
    });
  }
  return resource;
}

async function patientIdentifier(resource, ctx) {
  const ref = resource && resource.subject;
  const id = mapper.referenceId(ref, 'Patient');
  if (!id) throw new Skip('no patient identifier');
  const patient = await read('Patient', id, ctx);
  const value = identifierValue(patient, process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM);
  if (!value) {
    logger.warn('Patient has no identifier with our system', { resourceId: ctx.resourceId });
    throw new Skip('no patient identifier');
  }
  return value;
}

async function providerUuid(references, ctx) {
  const id = mapper.singlePractitionerId(references);
  const system = process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM;
  if (!id || !system) return undefined;
  const practitioner = await read('Practitioner', id, ctx);
  return identifierValue(practitioner, system) || undefined;
}

function noAccession(ctx) {
  logger.warn('No accession number with our identifier system', {
    resourceId: ctx.resourceId,
    systemsSeen: [...ctx.systemsSeen],
  });
  return new Skip('no accession with our system');
}

async function handleStudy(ctx) {
  const study = await read('ImagingStudy', ctx.resourceId, ctx);
  if (!study) throw new Skip('not found');
  ctx.status = study.status;
  const skipReason = mapper.studySkipReason(study);
  if (skipReason) throw new Skip(skipReason);
  const datePerformed = isoDate(study.started);
  if (!datePerformed) {
    logger.warn('ImagingStudy has a missing or unparseable date', { field: 'started', resourceId: ctx.resourceId });
    throw new Skip('unparseable started');
  }
  const accession = accessionNumber(study);
  if (!accession) throw noAccession(ctx);
  ctx.accession = accession;
  const patientId = await patientIdentifier(study, ctx);
  const technician = await providerUuid(mapper.technicianReferences(study), ctx);

  const body = {
    accessionNumber: accession,
    datePerformed,
    patientIdentifierTypeUuid: process.env.OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID,
    patientIdentifier: patientId,
  };
  const images = mapper.imagesAvailable(study);
  if (images !== null) body.imagesAvailable = images;
  if (technician) body.technicianProviderUuid = technician;
  return importStudy(body);
}

async function handleReport(ctx) {
  const report = await read('DiagnosticReport', ctx.resourceId, ctx);
  if (!report) throw new Skip('not found');
  ctx.status = report.status;
  const reportType = mapper.reportTypeFor(report.status);
  if (!reportType) throw new Skip(`status ${report.status}`);

  const text = mapper.reportText(report);
  ctx.conclusionDropped = text.conclusionDropped;
  if (text.skipReason) throw new Skip(text.skipReason);
  if (typeof text.text !== 'string' || text.text.trim() === '') throw new Skip('no report text');
  if (!String(text.contentType || '').startsWith('text/plain')) {
    logger.warn('DiagnosticReport text is not text/plain', { contentType: text.contentType });
  }

  const reportDate = isoDate(report.issued);
  if (!reportDate) {
    logger.warn('DiagnosticReport has a missing or unparseable date', { field: 'issued', resourceId: ctx.resourceId });
    throw new Skip(report.issued ? 'unparseable issued' : 'no issued');
  }

  let accession = accessionNumber(report);
  let datePerformed;
  if (!accession) {
    const studyId = mapper.referenceId(Array.isArray(report.study) ? report.study[0] : null, 'ImagingStudy');
    if (studyId) {
      const study = await read('ImagingStudy', studyId, ctx);
      if (study) {
        accession = accessionNumber(study);
        // an unusable study date is left out; radiologyapp then uses the report date
        datePerformed = isoDate(study.started) || undefined;
        if (study.started && !datePerformed) {
          logger.warn('ImagingStudy has an unparseable date', { field: 'started', resourceId: studyId });
        }
      }
    }
  }
  if (!accession) {
    const orderId = mapper.referenceId(Array.isArray(report.basedOn) ? report.basedOn[0] : null, 'ServiceRequest');
    if (orderId) {
      const order = await read('ServiceRequest', orderId, ctx);
      accession = accessionNumber(order);
    }
  }
  if (!accession) throw noAccession(ctx);
  ctx.accession = accession;

  const patientId = await patientIdentifier(report, ctx);
  const radiologist = await providerUuid(mapper.radiologistReferences(report), ctx);

  const body = {
    accessionNumber: accession,
    reportDate,
    reportType,
    reportBody: text.text,
    patientIdentifierTypeUuid: process.env.OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID,
    patientIdentifier: patientId,
  };
  if (radiologist) body.radiologistProviderUuid = radiologist;
  if (datePerformed) body.datePerformed = datePerformed;
  return importReport(body);
}

async function processEvent(event) {
  const eventType = event && event.eventType;
  const eventId = event && event.eventId;
  const ctx = {
    resourceId: event && event.data && event.data.id,
    systemsSeen: new Set(),
  };
  let result;
  let reason;
  try {
    if (!SUPPORTED_EVENTS.includes(eventType)) throw new Skip('event type');
    for (const name of [
      'OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID',
      'ADVAPACS_PATIENT_IDENTIFIER_SYSTEM',
      'OPENMRS_RESULTS_CHANNEL_URL',
    ]) {
      if (!process.env[name]) throw new Error(`${name} is not configured`);
    }
    if (eventType === 'STUDY_CREATED') {
      result = await handleStudy(ctx);
    } else {
      result = await handleReport(ctx);
    }
  } catch (err) {
    if (!(err instanceof Skip)) {
      logger.error('Failed to handle AdvaPACS event', { eventType, eventId, resourceId: ctx.resourceId, ...safeError(err) });
      throw new Error(`Failed to handle ${eventType} event: ${err && err.message}`);
    }
    reason = err.reason;
    result = { outcome: 'SKIPPED', reason };
  } finally {
    if (ctx.conclusionDropped) {
      logger.warn("DiagnosticReport has a conclusion, which isn't saved to OpenMRS", {
        reportId: ctx.resourceId,
        accession: ctx.accession,
      });
    }
  }
  const outcome = result && result.outcome;
  logger.info('Handled AdvaPACS event', {
    eventType,
    eventId,
    resourceId: ctx.resourceId,
    status: ctx.status,
    accession: ctx.accession,
    outcome,
    reason,
  });
  if (OUTCOMES_TO_WARN.includes(outcome)) {
    logger.warn('radiologyapp import outcome needs attention', {
      outcome,
      eventId,
      resourceId: ctx.resourceId,
      accession: ctx.accession,
    });
  }
  return reason ? { outcome, reason } : { outcome };
}

function handleEvent(event) {
  const run = queue.then(() => processEvent(event));
  queue = run.catch(() => {}); // a failed event must not break the chain
  return run;
}

module.exports = { handleEvent };

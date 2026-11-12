jest.mock('../../src/lib/advapacsClient', () => ({ readResource: jest.fn() }));
jest.mock('../../src/lib/radiologyappClient', () => ({ importStudy: jest.fn(), importReport: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { readResource } = require('../../src/lib/advapacsClient');
const { importStudy, importReport } = require('../../src/lib/radiologyappClient');
const logger = require('../../src/lib/logger');
const { handleEvent } = require('../../src/lib/resultHandler');

const ACC_SYS = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';
const PAT_SYS = 'http://www.pih.org/identifiers/lesotho/emr-id';
const PRAC_SYS = 'http://www.pih.org/identifiers/lesotho/provider-uuid';
const TYPE_UUID = 'type-uuid-1';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const patient = { identifier: [{ system: PAT_SYS, value: 'EMR-SECRET-1' }] };
const studyEvent = { eventId: 'e1', eventType: 'STUDY_CREATED', data: { type: 'ImagingStudy', id: 'st1' } };
const reportEvent = (id = 'r1', eventType = 'REPORT_CREATED') => ({
  eventId: 'e2', eventType, data: { type: 'DiagnosticReport', id },
});
const study = (over = {}) => ({
  id: 'st1', status: 'available', started: '2026-11-01T10:00:00Z', numberOfInstances: 5,
  identifier: [{ system: ACC_SYS, value: 'ACC1' }],
  subject: { reference: 'Patient/p1' },
  series: [{ performer: [{ actor: { reference: 'Practitioner/tech1' } }] }],
  ...over,
});
const report = (over = {}) => ({
  id: 'r1', status: 'final', issued: '2026-11-02T09:00:00Z',
  subject: { reference: 'Patient/p1' },
  presentedForm: [{ contentType: 'text/plain', data: b64('SECRET REPORT TEXT') }],
  resultsInterpreter: [{ reference: 'Practitioner/rad1' }],
  ...over,
});

function resources(map) {
  readResource.mockImplementation(async (type, id) => (map[`${type}/${id}`] === undefined ? null : map[`${type}/${id}`]));
}
const logged = () => JSON.stringify([logger.info, logger.warn, logger.error].map((f) => f.mock.calls));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID = TYPE_UUID;
  process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = PAT_SYS;
  process.env.OPENMRS_RESULTS_CHANNEL_URL = 'http://openhim:5001/openmrs';
  process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM = ACC_SYS;
  process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = PRAC_SYS;
  importStudy.mockResolvedValue({ outcome: 'CREATED' });
  importReport.mockResolvedValue({ outcome: 'CREATED' });
});

describe('studies', () => {
  test('imports a study with started, images available and the patient identifier', async () => {
    resources({
      'ImagingStudy/st1': study(),
      'Patient/p1': patient,
      'Practitioner/tech1': { identifier: [{ system: PRAC_SYS, value: 'tech-uuid' }] },
    });
    await expect(handleEvent(studyEvent)).resolves.toEqual({ outcome: 'CREATED' });
    expect(importStudy).toHaveBeenCalledWith({
      accessionNumber: 'ACC1',
      datePerformed: '2026-11-01T10:00:00.000Z',
      imagesAvailable: true,
      technicianProviderUuid: 'tech-uuid',
      patientIdentifierTypeUuid: TYPE_UUID,
      patientIdentifier: 'EMR-SECRET-1',
    });
  });

  test('normalises a microsecond started to an ISO string', async () => {
    resources({ 'ImagingStudy/st1': study({ started: '2026-11-10T21:21:19.123456Z' }), 'Patient/p1': patient });
    await handleEvent(studyEvent);
    expect(importStudy).toHaveBeenCalledWith(expect.objectContaining({ datePerformed: '2026-11-10T21:21:19.123Z' }));
  });

  test.each([['2026-11'], ['2026'], ['garbage']])(
    'skips a study whose started is %p', async (started) => {
      resources({ 'ImagingStudy/st1': study({ started }), 'Patient/p1': patient });
      await expect(handleEvent(studyEvent)).resolves.toEqual({ outcome: 'SKIPPED', reason: 'unparseable started' });
      expect(importStudy).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ field: 'started' }));
    });

  test('skips a study with 0 instances without calling OpenMRS', async () => {
    resources({ 'ImagingStudy/st1': study({ numberOfInstances: 0 }) });
    await expect(handleEvent(studyEvent)).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no instances' });
    expect(importStudy).not.toHaveBeenCalled();
  });

  test('skips with the systems seen when there is no accession with our system', async () => {
    resources({ 'ImagingStudy/st1': study({ identifier: [{ system: 'urn:other', value: 'VAL-9' }] }) });
    await expect(handleEvent(studyEvent)).resolves.toEqual({
      outcome: 'SKIPPED', reason: 'no accession with our system',
    });
    const warn = JSON.stringify(logger.warn.mock.calls);
    expect(warn).toContain('urn:other');
    expect(warn).not.toContain('VAL-9');
  });

  test('skips, warning only in the mediator log, when the patient has no identifier', async () => {
    resources({ 'ImagingStudy/st1': study(), 'Patient/p1': { identifier: [{ system: 'urn:x', value: 'v' }] } });
    await expect(handleEvent(studyEvent)).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no patient identifier' });
    expect(importStudy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('skips an invalid id without reading it', async () => {
    await expect(handleEvent({ ...studyEvent, data: { type: 'ImagingStudy', id: '../x' } })).resolves.toEqual({
      outcome: 'SKIPPED', reason: 'invalid id',
    });
    expect(readResource).not.toHaveBeenCalled();
  });

  test('skips an invalid referenced id', async () => {
    resources({ 'ImagingStudy/st1': study({ subject: { reference: 'Patient/a/../b' } }) });
    await expect(handleEvent(studyEvent)).resolves.toEqual({ outcome: 'SKIPPED', reason: 'invalid id' });
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  test('skips an unknown event type', async () => {
    await expect(handleEvent({ eventId: 'e', eventType: 'PATIENT_CREATED', data: { id: 'x' } })).resolves.toEqual({
      outcome: 'SKIPPED', reason: 'event type',
    });
  });
});

describe('reports', () => {
  test('imports a final report and takes the accession and datePerformed from the ImagingStudy', async () => {
    resources({
      'DiagnosticReport/r1': report({ study: [{ reference: 'ImagingStudy/st1' }] }),
      'ImagingStudy/st1': study(),
      'Patient/p1': patient,
      'Practitioner/rad1': { identifier: [{ system: PRAC_SYS, value: 'rad-uuid' }] },
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
    expect(importReport).toHaveBeenCalledWith({
      accessionNumber: 'ACC1',
      reportDate: '2026-11-02T09:00:00.000Z',
      reportType: 'final',
      reportBody: 'SECRET REPORT TEXT',
      radiologistProviderUuid: 'rad-uuid',
      datePerformed: '2026-11-01T10:00:00.000Z',
      patientIdentifierTypeUuid: TYPE_UUID,
      patientIdentifier: 'EMR-SECRET-1',
    });
  });

  test('takes the accession from basedOn when the report and study have none', async () => {
    resources({
      'DiagnosticReport/r1': report({
        study: [{ reference: 'ImagingStudy/st1' }],
        basedOn: [{ reference: 'ServiceRequest/sr1' }],
      }),
      'ImagingStudy/st1': study({ identifier: [] }),
      'ServiceRequest/sr1': { identifier: [{ system: ACC_SYS, value: 'ACC-SR' }] },
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(importReport).toHaveBeenCalledWith(expect.objectContaining({ accessionNumber: 'ACC-SR' }));
  });

  test('skips a preliminary report without reading anything else', async () => {
    resources({ 'DiagnosticReport/r1': report({ status: 'preliminary' }) });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'status preliminary' });
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(importReport).not.toHaveBeenCalled();
  });

  test('skips a report whose text is only whitespace', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'A' }],
        presentedForm: [{ contentType: 'text/plain', data: b64('  \n ') }],
      }),
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no report text' });
  });

  test("warns, without its text, when a report's conclusion is dropped", async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'ACC1' }],
        conclusion: 'SECRET CONCLUSION',
      }),
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    const warns = JSON.stringify(logger.warn.mock.calls);
    expect(warns).toContain("DiagnosticReport has a conclusion, which isn't saved to OpenMRS");
    expect(warns).toContain('ACC1');
    expect(logged()).not.toContain('SECRET CONCLUSION');
    expect(importReport).toHaveBeenCalled();
  });

  test('warns with the contentType when the text is not text/plain', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'ACC1' }],
        presentedForm: [{ contentType: 'text/html', data: b64('<p>hi</p>') }],
      }),
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { contentType: 'text/html' });
  });

  test('skips a pdf-only report and warns with the content types only', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'ACC1' }],
        presentedForm: [{ contentType: 'application/pdf', data: b64('SECRET PDF') }],
      }),
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no text report' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { contentTypes: ['application/pdf'] });
    expect(importReport).not.toHaveBeenCalled();
    expect(logged()).not.toContain('SECRET PDF');
  });

  test('passes the radiologist uuid only when the Practitioner has the provider-uuid identifier', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
      'Practitioner/rad1': { identifier: [{ system: 'urn:other', value: 'nope' }] },
    });
    await handleEvent(reportEvent());
    expect(importReport.mock.calls[0][0]).not.toHaveProperty('radiologistProviderUuid');
  });

  test('warns for outcomes needing attention', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    importReport.mockResolvedValue({ outcome: 'PATIENT_MISMATCH' });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'PATIENT_MISMATCH' });
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('PATIENT_MISMATCH');
  });

  test('logs ALREADY_EXISTS at info, not warn', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    importReport.mockResolvedValue({ outcome: 'ALREADY_EXISTS' });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'ALREADY_EXISTS' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('ALREADY_EXISTS');
    expect(JSON.stringify(logger.info.mock.calls)).toContain('ALREADY_EXISTS');
  });

  test('warns for NO_MATCHING_ORDER', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    importReport.mockResolvedValue({ outcome: 'NO_MATCHING_ORDER' });
    await handleEvent(reportEvent());
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('NO_MATCHING_ORDER');
  });

  test('skips a final report with no issued date, warning with the field name only', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }], issued: undefined }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no issued' });
    expect(importReport).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ field: 'issued' }));
  });

  test('skips a report with an unparseable issued date', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }], issued: 'garbage' }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'unparseable issued' });
    expect(importReport).not.toHaveBeenCalled();
  });

  test('normalises microsecond dates to ISO strings', async () => {
    resources({
      'DiagnosticReport/r1': report({
        issued: '2026-11-10T21:21:19.123456Z',
        study: [{ reference: 'ImagingStudy/st1' }],
      }),
      'ImagingStudy/st1': study({ started: '2026-11-10T20:00:00.654321+02:00' }),
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(importReport).toHaveBeenCalledWith(expect.objectContaining({
      reportDate: '2026-11-10T21:21:19.123Z',
      datePerformed: '2026-11-10T18:00:00.654Z',
    }));
  });

  test('takes datePerformed from the linked study even when the report has its own accession', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'OWN' }],
        study: [{ reference: 'ImagingStudy/st1' }],
      }),
      'ImagingStudy/st1': study({ started: '2026-11-01T10:00:00Z' }),
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(importReport).toHaveBeenCalledWith(expect.objectContaining({
      accessionNumber: 'OWN',
      datePerformed: '2026-11-01T10:00:00.000Z',
    }));
  });

  test('imports without datePerformed when the linked study is not found', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'OWN' }],
        study: [{ reference: 'ImagingStudy/st1' }],
      }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
    expect(importReport.mock.calls[0][0]).not.toHaveProperty('datePerformed');
  });

  test('carries on without datePerformed when the study id is invalid but the report has its own accession', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'OWN' }],
        study: [{ reference: 'ImagingStudy/a/../b' }],
      }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
    expect(importReport.mock.calls[0][0]).not.toHaveProperty('datePerformed');
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ field: 'study' }));
  });

  test('falls back to basedOn when the study id is invalid and the report has no accession of its own', async () => {
    resources({
      'DiagnosticReport/r1': report({
        study: [{ reference: 'ImagingStudy/a/../b' }],
        basedOn: [{ reference: 'ServiceRequest/sr1' }],
      }),
      'ServiceRequest/sr1': { identifier: [{ system: ACC_SYS, value: 'ACC-SR' }] },
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(importReport).toHaveBeenCalledWith(expect.objectContaining({ accessionNumber: 'ACC-SR' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ field: 'study' }));
  });

  test('skips with no accession when the study id is invalid and nothing else has one', async () => {
    resources({
      'DiagnosticReport/r1': report({ study: [{ reference: 'ImagingStudy/a/../b' }] }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'no accession with our system' });
  });

  test('omits an unparseable study date from a report rather than skipping it', async () => {
    resources({
      'DiagnosticReport/r1': report({ study: [{ reference: 'ImagingStudy/st1' }] }),
      'ImagingStudy/st1': study({ started: '2026-11' }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
    expect(importReport.mock.calls[0][0]).not.toHaveProperty('datePerformed');
  });
});

describe('failures and ordering', () => {
  test('skips an event whose caller is gone before its turn, without reading AdvaPACS', async () => {
    let release;
    readResource.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = handleEvent(reportEvent('r1'));
    let abandoned = false;
    const second = handleEvent(reportEvent('r2'), { isAbandoned: () => abandoned }).catch((e) => e);
    await new Promise((resolve) => setImmediate(resolve)); // the first event is now waiting on AdvaPACS
    abandoned = true;
    release(null);
    await first.catch(() => {});
    const rejection = await second;
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe('caller gone before processing started');
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(readResource).not.toHaveBeenCalledWith('DiagnosticReport', 'r2', expect.anything());
    expect(importReport).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.info.mock.calls)).toContain('e2');
  });

  test('processes normally when the caller is still there', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent(), { isAbandoned: () => false })).resolves.toEqual({ outcome: 'CREATED' });
  });

  test("rejects when the event's own resource is not found, so OpenHIM retries it", async () => {
    readResource.mockResolvedValue(null);
    await expect(handleEvent(reportEvent())).rejects.toThrow('DiagnosticReport r1 not found');
    await expect(handleEvent(studyEvent)).rejects.toThrow('ImagingStudy st1 not found');
  });

  test('still imports a report whose linked study is not found', async () => {
    resources({
      'DiagnosticReport/r1': report({
        identifier: [{ system: ACC_SYS, value: 'OWN' }],
        study: [{ reference: 'ImagingStudy/st1' }],
      }),
      'Patient/p1': patient,
    });
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
  });

  test('rejects when OpenMRS is unreachable, with a plain safe error, and keeps going', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    const err = new Error('radiologyapp /reportimport failed (ECONNREFUSED)');
    err.code = 'ECONNREFUSED';
    importReport.mockRejectedValueOnce(err);
    const rejection = await handleEvent(reportEvent()).catch((e) => e);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toContain('ECONNREFUSED');
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'CREATED' });
  });

  test('logs only the message of an AdvaPACS error, never the error object', async () => {
    const axiosish = Object.assign(new Error('Request failed with status code 500'), {
      status: 500, config: { headers: { Authorization: 'ID=a,Secret=TOPSECRET' } },
    });
    readResource.mockRejectedValue(axiosish);
    const rejection = await handleEvent(reportEvent()).catch((e) => e);
    expect(rejection).not.toBe(axiosish);
    expect(rejection.config).toBeUndefined();
    expect(logged()).not.toContain('TOPSECRET');
    expect(logged()).toContain('status code 500');
  });

  test('rejects when OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID is unset', async () => {
    delete process.env.OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID;
    await expect(handleEvent(studyEvent)).rejects.toThrow('OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID');
    expect(readResource).not.toHaveBeenCalled();
  });

  test('skips an ignored event type even when nothing is configured', async () => {
    delete process.env.OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID;
    delete process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
    delete process.env.OPENMRS_RESULTS_CHANNEL_URL;
    await expect(handleEvent({ eventId: 'e', eventType: 'STUDY_UPDATED', data: { id: 'st1' } })).resolves.toEqual({
      outcome: 'SKIPPED', reason: 'event type',
    });
  });

  test('rejects when OPENMRS_RESULTS_CHANNEL_URL is unset', async () => {
    delete process.env.OPENMRS_RESULTS_CHANNEL_URL;
    await expect(handleEvent(studyEvent)).rejects.toThrow('OPENMRS_RESULTS_CHANNEL_URL');
    expect(readResource).not.toHaveBeenCalled();
  });

  test('rejects when ADVAPACS_PATIENT_IDENTIFIER_SYSTEM is unset', async () => {
    delete process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
    await expect(handleEvent(studyEvent)).rejects.toThrow('ADVAPACS_PATIENT_IDENTIFIER_SYSTEM');
    expect(readResource).not.toHaveBeenCalled();
  });

  test('rejects when ADVAPACS_ACCESSION_NUMBER_SYSTEM is unset', async () => {
    delete process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM;
    await expect(handleEvent(studyEvent)).rejects.toThrow('ADVAPACS_ACCESSION_NUMBER_SYSTEM');
    expect(readResource).not.toHaveBeenCalled();
  });

  test('handles concurrent final events for one report as one create', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    const order = [];
    let n = 0;
    importReport.mockImplementation(async () => {
      const i = ++n;
      order.push(`start${i}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end${i}`);
      return { outcome: i === 1 ? 'CREATED' : 'ALREADY_EXISTS' };
    });
    const results = await Promise.all([handleEvent(reportEvent()), handleEvent(reportEvent()), handleEvent(reportEvent())]);
    expect(results.map((r) => r.outcome)).toEqual(['CREATED', 'ALREADY_EXISTS', 'ALREADY_EXISTS']);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
  });

  test('never logs the patient identifier or report text', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    await handleEvent(reportEvent());
    expect(logged()).not.toContain('EMR-SECRET-1');
    expect(logged()).not.toContain('SECRET REPORT TEXT');
  });
});

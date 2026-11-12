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
  process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = PRAC_SYS;
  delete process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM;
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
      datePerformed: '2026-11-01T10:00:00Z',
      imagesAvailable: true,
      technicianProviderUuid: 'tech-uuid',
      patientIdentifierTypeUuid: TYPE_UUID,
      patientIdentifier: 'EMR-SECRET-1',
    });
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
      reportDate: '2026-11-02T09:00:00Z',
      reportType: 'final',
      reportBody: 'SECRET REPORT TEXT',
      radiologistProviderUuid: 'rad-uuid',
      datePerformed: '2026-11-01T10:00:00Z',
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
});

describe('failures and ordering', () => {
  test('skips with 200 when AdvaPACS has no such resource', async () => {
    readResource.mockResolvedValue(null);
    await expect(handleEvent(reportEvent())).resolves.toEqual({ outcome: 'SKIPPED', reason: 'not found' });
  });

  test('rejects when OpenMRS is unreachable, with a plain safe error, and keeps going', async () => {
    resources({
      'DiagnosticReport/r1': report({ identifier: [{ system: ACC_SYS, value: 'ACC1' }] }),
      'Patient/p1': patient,
    });
    const err = new Error('radiologyapp /report failed (ECONNREFUSED)');
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

  test('rejects when ADVAPACS_PATIENT_IDENTIFIER_SYSTEM is unset', async () => {
    delete process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM;
    await expect(handleEvent(studyEvent)).rejects.toThrow('ADVAPACS_PATIENT_IDENTIFIER_SYSTEM');
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

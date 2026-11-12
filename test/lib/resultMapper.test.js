const m = require('../../src/lib/resultMapper');
const { accessionNumber } = require('../../src/lib/identifiers');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('resultMapper', () => {
  it('maps final to final, amended and corrected to correction, preliminary/partial/cancelled to null', () => {
    expect(m.reportTypeFor('final')).toBe('final');
    expect(m.reportTypeFor('amended')).toBe('correction');
    expect(m.reportTypeFor('corrected')).toBe('correction');
    ['preliminary', 'partial', 'cancelled', undefined].forEach((s) => expect(m.reportTypeFor(s)).toBeNull());
  });

  it('skips a study with no started', () => {
    expect(m.studySkipReason({ numberOfInstances: 3 })).toBe('no started');
    expect(m.studySkipReason(null)).toBe('no started');
  });
  it('skips a study with 0 instances', () => {
    expect(m.studySkipReason({ started: '2026-01-01', numberOfInstances: 0 })).toBe('no instances');
    expect(m.studySkipReason({ started: '2026-01-01', numberOfInstances: 2 })).toBeNull();
  });
  it('images available is null when numberOfInstances is absent', () => {
    expect(m.imagesAvailable({})).toBeNull();
    expect(m.imagesAvailable({ numberOfInstances: 0 })).toBe(false);
    expect(m.imagesAvailable({ numberOfInstances: 4 })).toBe(true);
  });

  it('decodes UTF-8 plain-text presentedForm', () => {
    const r = m.reportText({ presentedForm: [{ contentType: 'text/plain; charset=utf-8', data: b64('Sesotho: ê') }] });
    expect(r).toEqual({ text: 'Sesotho: ê', contentType: 'text/plain; charset=utf-8', conclusionDropped: false });
  });
  it('prefers text/plain over text/html', () => {
    const r = m.reportText({
      presentedForm: [
        { contentType: 'text/html', data: b64('<p>h</p>') },
        { contentType: 'text/plain', data: b64('plain') },
      ],
    });
    expect(r.text).toBe('plain');
  });
  it('skips a pdf-only report', () => {
    const r = m.reportText({ presentedForm: [{ contentType: 'application/pdf', data: b64('%PDF-1.4') }] });
    expect(r).toEqual({ skipReason: 'no text report', conclusionDropped: false });
  });
  it('accepts html when it is the only text form', () => {
    const r = m.reportText({
      presentedForm: [
        { contentType: 'application/pdf', data: b64('%PDF') },
        { contentType: 'text/html', data: b64('<p>h</p>') },
      ],
    });
    expect(r).toEqual({ text: '<p>h</p>', contentType: 'text/html', conclusionDropped: false });
  });
  it('matches text/plain case-insensitively', () => {
    const r = m.reportText({
      presentedForm: [
        { contentType: 'TEXT/html', data: b64('<p>h</p>') },
        { contentType: 'Text/Plain', data: b64('plain') },
      ],
    });
    expect(r.text).toBe('plain');
  });
  it('does not use conclusion as the report text', () => {
    expect(m.reportText({ conclusion: 'Normal' })).toEqual({ skipReason: 'no text report', conclusionDropped: true });
  });
  it('flags a conclusion dropped alongside presentedForm', () => {
    const r = m.reportText({ conclusion: 'Normal', presentedForm: [{ contentType: 'text/plain', data: b64('Body') }] });
    expect(r.text).toBe('Body');
    expect(r.conclusionDropped).toBe(true);
  });
  it('returns a skip reason when the report has no text', () => {
    expect(m.reportText({})).toEqual({ skipReason: 'no text report', conclusionDropped: false });
    expect(m.reportText({ presentedForm: [null, { contentType: 'text/plain' }] }).skipReason).toBe('no text report');
  });
  it('does not throw on malformed reports', () => {
    expect(m.reportText({ presentedForm: 'x', conclusion: 5 }).skipReason).toBe('no text report');
    expect(m.reportText(null).skipReason).toBe('no text report');
  });

  it('returns the single Practitioner id', () => {
    expect(m.singlePractitionerId([{ reference: 'Practitioner/abc' }, { reference: 'Practitioner/abc' }])).toBe('abc');
  });
  it('returns null for two different practitioners', () => {
    expect(m.singlePractitionerId([{ reference: 'Practitioner/a' }, { reference: 'Practitioner/b' }])).toBeNull();
  });
  it('returns null for a PractitionerRole', () => {
    expect(m.singlePractitionerId([{ reference: 'PractitionerRole/a' }])).toBeNull();
  });
  it('returns null for none or malformed', () => {
    expect(m.singlePractitionerId([])).toBeNull();
    expect(m.singlePractitionerId(null)).toBeNull();
    expect(m.singlePractitionerId([null, {}, { reference: 5 }])).toBeNull();
  });

  it('collects technician references from series performers', () => {
    const study = { series: [{ performer: [{ actor: { reference: 'Practitioner/t1' } }] }, null, { performer: [null, {}] }, { performer: 'x' }] };
    expect(m.technicianReferences(study)).toEqual([{ reference: 'Practitioner/t1' }]);
    expect(m.technicianReferences({ series: 'x' })).toEqual([]);
    expect(m.technicianReferences(null)).toEqual([]);
  });
  it('uses resultsInterpreter else performer for radiologists', () => {
    const a = [{ reference: 'Practitioner/a' }];
    const b = [{ reference: 'Practitioner/b' }];
    expect(m.radiologistReferences({ resultsInterpreter: a, performer: b })).toEqual(a);
    expect(m.radiologistReferences({ resultsInterpreter: [], performer: b })).toEqual(b);
    expect(m.radiologistReferences({ performer: 'x' })).toEqual([]);
    expect(m.radiologistReferences(null)).toEqual([]);
  });

  it('extracts a reference id by type', () => {
    expect(m.referenceId({ reference: 'Patient/123' }, 'Patient')).toBe('123');
    expect(m.referenceId({ reference: 'Patient/abc/_history/1' }, 'Patient')).toBe('abc');
    expect(m.referenceId({ reference: 'https://host/fhir/R5/Patient/abc' }, 'Patient')).toBe('abc');
    expect(m.referenceId({ reference: 'https://host/fhir/Patient/abc/_history/2' }, 'Patient')).toBe('abc');
    expect(m.referenceId({ reference: 'Patient/abc?x=1' }, 'Patient')).toBe('abc');
    expect(m.referenceId({ reference: 'Practitioner/abc' }, 'Patient')).toBeNull();
    expect(m.referenceId({ reference: 'https://host/fhir/Practitioner/abc' }, 'Patient')).toBeNull();
    expect(m.referenceId({ reference: 'Practitioner/123' }, 'Patient')).toBeNull();
    expect(m.referenceId(null, 'Patient')).toBeNull();
    expect(m.referenceId({ reference: 'Patient/' }, 'Patient')).toBeNull();
  });

  it('ignores identifiers without a system', () => {
    expect(accessionNumber({ identifier: [{ value: 'ACC-9' }] })).toBeUndefined();
  });
});

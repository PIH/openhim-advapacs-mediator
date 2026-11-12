describe('identifiers', () => {
  const DEFAULT_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';
  let identifiers;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM;
    identifiers = require('../../src/lib/identifiers');
  });

  afterEach(() => {
    delete process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM;
  });

  it('returns the accession with our system', () => {
    const resource = {
      identifier: [
        { type: { coding: [{ code: 'ACSN' }] }, system: DEFAULT_SYSTEM, value: 'ACC-1' },
      ],
    };
    expect(identifiers.accessionNumber(resource)).toBe('ACC-1');
  });

  it('ignores an ACSN identifier with another system', () => {
    const resource = {
      identifier: [
        { type: { coding: [{ code: 'ACSN' }] }, system: 'urn:other', value: 'ACC-1' },
      ],
    };
    expect(identifiers.accessionNumber(resource)).toBeUndefined();
  });

  it('ignores identifiers without a system', () => {
    const resource = { identifier: [{ value: 'ACC-1' }] };
    expect(identifiers.accessionNumber(resource)).toBeUndefined();
  });

  it('uses ADVAPACS_ACCESSION_NUMBER_SYSTEM when set', () => {
    process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM = 'urn:custom';
    const resource = {
      identifier: [
        { system: DEFAULT_SYSTEM, value: 'DEFAULT' },
        { system: 'urn:custom', value: 'CUSTOM' },
      ],
    };
    expect(identifiers.accessionNumberSystem()).toBe('urn:custom');
    expect(identifiers.accessionNumber(resource)).toBe('CUSTOM');
  });

  it('returns undefined for a resource with no identifier', () => {
    expect(identifiers.accessionNumber({ resourceType: 'ImagingStudy' })).toBeUndefined();
    expect(identifiers.identifierValue({}, 'urn:x')).toBeUndefined();
  });
});

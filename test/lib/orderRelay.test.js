jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');
jest.mock('../../src/lib/advapacsClient');

describe('orderRelay', () => {
  let openmrs;
  let advapacs;
  let orderRelay;

  const patientWithEmrId = {
    resourceType: 'Patient',
    id: 'omrs-patient-uuid',
    name: [{ given: ['Bob'], family: 'Dylan' }],
    identifier: [
      { system: 'http://www.pih.org/identifiers/lesotho/emr-id', value: 'CAAKH7' }
    ]
  };

  const serviceRequestWithSubject = {
    resourceType: 'ServiceRequest',
    id: 'sr1',
    subject: { reference: 'Patient/omrs-patient-uuid' }
  };

  const placerIdentifier = {
    use: 'usual',
    type: {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PLAC', display: 'Placer Identifier' }
      ]
    },
    value: 'ORD-1'
  };

  const unrelatedIdentifier = {
    use: 'official',
    system: 'http://example.org/internal-id',
    value: 'INTERNAL-1'
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.ADVAPACS_PATIENT_IDENTIFIER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/emr-id';

    openmrs = require('../../src/lib/openmrsClient');
    advapacs = require('../../src/lib/advapacsClient');
    orderRelay = require('../../src/lib/orderRelay');
  });

  test('uses the input directly when it is already a full ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(openmrs.getResource).not.toHaveBeenCalled();
  });

  test('resolves the full ServiceRequest when given only a serviceRequestId', async () => {
    openmrs.getResource.mockResolvedValue(serviceRequestWithSubject);
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest({ serviceRequestId: 'sr1' });

    expect(openmrs.getResource).toHaveBeenCalledWith('ServiceRequest', 'sr1');
  });

  test('pushes the Patient to AdvaPACS before the ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    const callOrder = [];
    advapacs.upsertPatient.mockImplementation(async () => {
      callOrder.push('patient');
      return { id: 'advapacs-patient-1' };
    });
    advapacs.createServiceRequest.mockImplementation(async () => {
      callOrder.push('serviceRequest');
      return { id: 'advapacs-sr-1' };
    });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(callOrder).toEqual(['patient', 'serviceRequest']);
  });

  test('references the patient on the outbound ServiceRequest by the AdvaPACS-assigned Patient id, not the OpenMRS UUID', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(advapacs.createServiceRequest).toHaveBeenCalledWith(expect.objectContaining({
      subject: {
        reference: 'Patient/advapacs-patient-1',
        display: 'Bob Dylan'
      }
    }));
  });

  test('strips the encounter field from the outbound ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest({
      ...serviceRequestWithSubject,
      encounter: { reference: 'Encounter/omrs-encounter-uuid' }
    });

    const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
    expect(outboundArg).not.toHaveProperty('encounter');
  });

  test('strips the requester field from the outbound ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    await orderRelay.relayServiceRequest({
      ...serviceRequestWithSubject,
      requester: { reference: 'Practitioner/omrs-practitioner-uuid' }
    });

    const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
    expect(outboundArg).not.toHaveProperty('requester');
  });

  test('throws when the patient has no identifier matching ADVAPACS_PATIENT_IDENTIFIER_SYSTEM, and never sends the ServiceRequest', async () => {
    openmrs.getPatient.mockResolvedValue({ ...patientWithEmrId, identifier: [] });
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });

    await expect(orderRelay.relayServiceRequest(serviceRequestWithSubject))
      .rejects.toThrow('Patient omrs-patient-uuid has no identifier for system http://www.pih.org/identifiers/lesotho/emr-id');

    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('when upsertPatient rejects, the error propagates and createServiceRequest is never called', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockRejectedValue(new Error('AdvaPACS unreachable'));

    await expect(orderRelay.relayServiceRequest(serviceRequestWithSubject)).rejects.toThrow('AdvaPACS unreachable');

    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('throws when the ServiceRequest has no subject reference, and never sends the ServiceRequest', async () => {
    const noSubjectServiceRequest = { resourceType: 'ServiceRequest', id: 'sr2' };

    await expect(orderRelay.relayServiceRequest(noSubjectServiceRequest))
      .rejects.toThrow('ServiceRequest sr2 references non-existent Patient undefined');

    expect(openmrs.getPatient).not.toHaveBeenCalled();
    expect(advapacs.upsertPatient).not.toHaveBeenCalled();
    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('throws when the subject reference does not resolve to an existing Patient', async () => {
    openmrs.getPatient.mockResolvedValue(null);

    await expect(orderRelay.relayServiceRequest(serviceRequestWithSubject))
      .rejects.toThrow('ServiceRequest sr1 references non-existent Patient omrs-patient-uuid');

    expect(advapacs.upsertPatient).not.toHaveBeenCalled();
    expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
  });

  test('resolves with the serviceRequest and the AdvaPACS-created resource', async () => {
    openmrs.getPatient.mockResolvedValue(patientWithEmrId);
    advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
    advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

    const result = await orderRelay.relayServiceRequest(serviceRequestWithSubject);

    expect(result).toEqual({
      serviceRequest: serviceRequestWithSubject,
      created: { id: 'advapacs-sr-1' }
    });
  });

  describe('accession number stamping (temporary, UHM-9437/9439/9440)', () => {
    test('stamps the placer identifier with the radiology order number system', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        identifier: [placerIdentifier]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.identifier).toContainEqual({
        ...placerIdentifier,
        system: 'http://www.pih.org/identifiers/lesotho/radiology-order-number'
      });
    });

    test('adds a separate accession-number identifier carrying the same value, alongside the placer identifier', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        identifier: [placerIdentifier]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.identifier).toContainEqual({
        system: 'http://www.pih.org/identifiers/lesotho/radiology-accession-number',
        value: 'ORD-1',
        type: {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'ACSN' }
          ]
        }
      });
      expect(outboundArg.identifier).toHaveLength(2);
    });

    test('leaves an unrelated identifier unchanged and only appends the accession-number entry', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        identifier: [placerIdentifier, unrelatedIdentifier]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.identifier).toContainEqual(unrelatedIdentifier);
      expect(outboundArg.identifier).toHaveLength(3);
    });

    test('leaves identifiers unchanged and adds nothing when there is no placer identifier', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        identifier: [unrelatedIdentifier]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.identifier).toEqual([unrelatedIdentifier]);
    });

    test('does not throw and produces an empty identifier array when the input has no identifier field at all', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.identifier).toEqual([]);
    });
  });

  describe('completed -> draft status override (hack)', () => {
    test('overrides a completed status to draft', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        status: 'completed'
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.status).toBe('draft');
    });

    test('leaves any other status unchanged', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        status: 'cancelled'
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.status).toBe('cancelled');
    });
  });

  describe('HL7 "PI" coding on the outbound Patient (stopgap, UHM-9443)', () => {
    const patientWithOpenmrsTypeCoding = {
      ...patientWithEmrId,
      identifier: [
        {
          use: 'official',
          type: { coding: [{ code: '17e79b97-808a-4a19-9b44-fc46dc579f75' }], text: 'EMR ID' },
          system: 'http://www.pih.org/identifiers/lesotho/emr-id',
          value: 'CAAKH7'
        }
      ]
    };

    test('prepends the HL7 PI coding to the EMR-ID identifier, ahead of its existing coding', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithOpenmrsTypeCoding);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier[0].type.coding).toEqual([
        { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PI' },
        { code: '17e79b97-808a-4a19-9b44-fc46dc579f75' }
      ]);
    });

    test('leaves an unrelated identifier (different system) unchanged', async () => {
      openmrs.getPatient.mockResolvedValue({
        ...patientWithOpenmrsTypeCoding,
        identifier: [...patientWithOpenmrsTypeCoding.identifier, unrelatedIdentifier]
      });
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier).toContainEqual(unrelatedIdentifier);
    });

    test('does not duplicate the PI coding if it is already present', async () => {
      openmrs.getPatient.mockResolvedValue({
        ...patientWithOpenmrsTypeCoding,
        identifier: [
          {
            ...patientWithOpenmrsTypeCoding.identifier[0],
            type: {
              coding: [
                { code: '17e79b97-808a-4a19-9b44-fc46dc579f75' },
                { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PI' }
              ]
            }
          }
        ]
      });
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier[0].type.coding).toHaveLength(2);
    });

    test('adds a type.coding without throwing when the identifier has no type at all', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier[0].type.coding).toEqual([
        { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PI' }
      ]);
    });
  });

  describe('stripping the system-less OpenMRS concept coding and wrapping ServiceRequest.code as a CodeableReference (AdvaPACS R5 requires code.concept, not a flat CodeableConcept)', () => {
    test('wraps the stripped coding/text under code.concept, keeping only system-bearing codings', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: {
          coding: [
            { code: 'openmrs-concept-uuid', display: 'Forearm - Left (X-ray)' },
            { system: 'http://loinc.org', code: '26148-7' },
            { system: 'http://snomed.info/sct', code: '3581000087107' }
          ],
          text: 'Forearm - Left (X-ray)'
        }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.code.concept.coding).toEqual([
        { system: 'http://loinc.org', code: '26148-7' },
        { system: 'http://snomed.info/sct', code: '3581000087107' }
      ]);
      expect(outboundArg.code.concept.text).toBe('Forearm - Left (X-ray)');
    });

    test('leaves code.concept.coding unchanged (aside from the wrap) when every coding already has a system', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      const coding = [
        { system: 'http://loinc.org', code: '26148-7' },
        { system: 'http://snomed.info/sct', code: '3581000087107' }
      ];
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { coding }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.code.concept.coding).toEqual(coding);
    });

    test('does not throw and sends code through unchanged (undefined) when there is no code field at all', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.code).toBeUndefined();
    });
  });

  describe('occurrencePeriod -> occurrenceDateTime on the outbound ServiceRequest (AdvaPACS only supports occurrenceDateTime)', () => {
    test('converts occurrencePeriod into occurrenceDateTime using its start, and drops occurrencePeriod', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        occurrencePeriod: { start: '2026-08-10T13:18:25-04:00', end: '2026-08-10T13:18:25-04:00' }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.occurrenceDateTime).toBe('2026-08-10T13:18:25-04:00');
      expect(outboundArg).not.toHaveProperty('occurrencePeriod');
    });

    test('leaves occurrenceDateTime unchanged when the input already has one instead of a period', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        occurrenceDateTime: '2026-08-10T13:18:25-04:00'
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.occurrenceDateTime).toBe('2026-08-10T13:18:25-04:00');
    });

    test('does not throw and leaves occurrenceDateTime undefined when neither field is present', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.occurrenceDateTime).toBeUndefined();
    });
  });

  describe('hardcoded modality on the outbound ServiceRequest (stopgap, UHM-9445)', () => {
    test('adds a hardcoded CR (X-ray) modality parameter, identified by AdvaPACS\'s "modality" code with a valueString', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail).toEqual([{
        parameter: [{
          code: {
            coding: [{
              system: 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code',
              code: 'modality'
            }]
          },
          valueString: 'CR'
        }]
      }]);
    });
  });

  describe('stripping id/meta/text (debugging persistent "missing modality" error)', () => {
    test('strips id, meta, and text from the outbound ServiceRequest', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        meta: { versionId: '123', lastUpdated: '2026-01-01T00:00:00.000-04:00' },
        text: { status: 'generated', div: '<div>narrative</div>' }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg).not.toHaveProperty('id');
      expect(outboundArg).not.toHaveProperty('meta');
      expect(outboundArg).not.toHaveProperty('text');
    });
  });
});

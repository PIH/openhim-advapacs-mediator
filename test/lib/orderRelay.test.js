jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');
jest.mock('../../src/lib/advapacsClient');
jest.mock('../../src/lib/siteLocation');

describe('orderRelay', () => {
  let openmrs;
  let advapacs;
  let siteLocation;
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
    process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/provider-uuid';

    openmrs = require('../../src/lib/openmrsClient');
    advapacs = require('../../src/lib/advapacsClient');
    siteLocation = require('../../src/lib/siteLocation');
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

  describe('AdvaPACS Site (locationReference), from the order\'s Visit Location', () => {
    beforeEach(() => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });
    });

    test('sets locationReference to the AdvaPACS Site resolved for the ServiceRequest', async () => {
      siteLocation.resolveSiteLocationReference.mockResolvedValue([{ reference: 'Location/site-mote' }]);

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      expect(siteLocation.resolveSiteLocationReference).toHaveBeenCalledWith(serviceRequestWithSubject);
      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.locationReference).toEqual([{ reference: 'Location/site-mote' }]);
    });

    test('sends no locationReference when no Site is configured', async () => {
      siteLocation.resolveSiteLocationReference.mockResolvedValue(undefined);

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg).not.toHaveProperty('locationReference');
    });

    test('when the Site can\'t be determined, the error propagates and nothing is sent to AdvaPACS', async () => {
      siteLocation.resolveSiteLocationReference.mockRejectedValue(new Error('Visit Location vl-other is not in ADVAPACS_SITE_MAP'));

      await expect(orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        requester: { reference: 'Practitioner/omrs-practitioner-uuid' }
      })).rejects.toThrow('not in ADVAPACS_SITE_MAP');

      expect(advapacs.upsertPatient).not.toHaveBeenCalled();
      expect(advapacs.upsertPractitioner).not.toHaveBeenCalled();
      expect(advapacs.createServiceRequest).not.toHaveBeenCalled();
    });
  });

  describe('ordering clinician (requester) relayed as an AdvaPACS Practitioner', () => {
    const openmrsPractitioner = {
      resourceType: 'Practitioner',
      id: 'omrs-practitioner-uuid',
      meta: { lastUpdated: '2026-08-03T16:29:49.000-04:00' },
      text: { status: 'generated', div: '<div/>' },
      extension: [{ url: 'http://fhir.openmrs.org/ext/provider/role', valueString: 'Clinician' }],
      identifier: [{ system: 'http://fhir.openmrs.org/ext/provider/identifier', value: 'PROV-1' }],
      name: [{ family: 'Herb', given: ['Phil'] }],
      gender: 'male'
    };
    const serviceRequestWithRequester = {
      ...serviceRequestWithSubject,
      requester: { reference: 'Practitioner/omrs-practitioner-uuid', display: 'Phil Herb' }
    };

    beforeEach(() => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      openmrs.getResource.mockResolvedValue(openmrsPractitioner);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.upsertPractitioner.mockResolvedValue({ id: 'advapacs-practitioner-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });
    });

    test('fetches the requester Practitioner from OpenMRS', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      expect(openmrs.getResource).toHaveBeenCalledWith('Practitioner', 'omrs-practitioner-uuid');
    });

    test('upserts the Practitioner into AdvaPACS, matched on its OpenMRS provider UUID under ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM, sending only the fields AdvaPACS supports', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      expect(advapacs.upsertPractitioner).toHaveBeenCalledWith({
        resourceType: 'Practitioner',
        identifier: [{ system: 'http://www.pih.org/identifiers/lesotho/provider-uuid', value: 'omrs-practitioner-uuid' }],
        name: [{ family: 'Herb', given: ['Phil'] }],
        gender: 'male'
      }, 'http://www.pih.org/identifiers/lesotho/provider-uuid', 'omrs-practitioner-uuid');
    });

    test('sends only the provider-UUID identifier, not OpenMRS\'s own provider identifier (AdvaPACS 422s on any unregistered identifier system)', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      const [outboundPractitionerArg] = advapacs.upsertPractitioner.mock.calls[0];
      expect(outboundPractitionerArg.identifier).toEqual([
        { system: 'http://www.pih.org/identifiers/lesotho/provider-uuid', value: 'omrs-practitioner-uuid' }
      ]);
    });

    test('still matches on the provider UUID when the provider has no OpenMRS identifier', async () => {
      openmrs.getResource.mockResolvedValue({ ...openmrsPractitioner, identifier: [] });

      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      expect(advapacs.upsertPractitioner).toHaveBeenCalledWith(
        expect.anything(), 'http://www.pih.org/identifiers/lesotho/provider-uuid', 'omrs-practitioner-uuid'
      );
      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester.reference).toBe('Practitioner/advapacs-practitioner-1');
    });

    test('sends no requester, and fetches no Practitioner, when ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM is not set', async () => {
      delete process.env.ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM;
      jest.resetModules();
      openmrs = require('../../src/lib/openmrsClient');
      advapacs = require('../../src/lib/advapacsClient');
      orderRelay = require('../../src/lib/orderRelay');
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      expect(openmrs.getResource).not.toHaveBeenCalled();
      expect(advapacs.upsertPractitioner).not.toHaveBeenCalled();
      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester).toBeUndefined();
    });

    test('references the requester on the outbound ServiceRequest by the AdvaPACS-assigned Practitioner id, not the OpenMRS UUID', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester).toEqual({
        reference: 'Practitioner/advapacs-practitioner-1',
        display: 'Phil Herb'
      });
    });

    test('upserts the Practitioner before sending the ServiceRequest', async () => {
      const callOrder = [];
      advapacs.upsertPractitioner.mockImplementation(async () => {
        callOrder.push('practitioner');
        return { id: 'advapacs-practitioner-1' };
      });
      advapacs.createServiceRequest.mockImplementation(async () => {
        callOrder.push('serviceRequest');
        return { id: 'advapacs-sr-1' };
      });

      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      expect(callOrder).toEqual(['practitioner', 'serviceRequest']);
    });

    test('sends no requester, and upserts no Practitioner, when the ServiceRequest has no requester', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      expect(advapacs.upsertPractitioner).not.toHaveBeenCalled();
      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester).toBeUndefined();
    });

    test('sends no requester when the requester is not a Practitioner', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        requester: { reference: 'Organization/omrs-org-uuid' }
      });

      expect(openmrs.getResource).not.toHaveBeenCalled();
      expect(advapacs.upsertPractitioner).not.toHaveBeenCalled();
      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester).toBeUndefined();
    });

    test('still sends the ServiceRequest, without a requester, when the Practitioner upsert fails', async () => {
      advapacs.upsertPractitioner.mockRejectedValue(new Error('Request failed with status code 422'));

      await orderRelay.relayServiceRequest(serviceRequestWithRequester);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.requester).toBeUndefined();
    });
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

  describe('dropping system-less identifiers from the outbound Patient (AdvaPACS 422s with "Identifier system required")', () => {
    const systemlessIdentifier = {
      use: 'usual',
      type: { coding: [{ code: '4ca30944-cfb4-4dfa-b0df-18f023351fad' }], text: 'MDR-TB ID' },
      value: 'GLC/LS0002'
    };

    test('drops an identifier that has no system, keeping the EMR-ID identifier', async () => {
      openmrs.getPatient.mockResolvedValue({
        ...patientWithEmrId,
        identifier: [...patientWithEmrId.identifier, systemlessIdentifier]
      });
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier).toHaveLength(1);
      expect(outboundPatientArg.identifier[0].system).toBe('http://www.pih.org/identifiers/lesotho/emr-id');
    });

    test('keeps other identifiers that do have a system', async () => {
      openmrs.getPatient.mockResolvedValue({
        ...patientWithEmrId,
        identifier: [...patientWithEmrId.identifier, systemlessIdentifier, unrelatedIdentifier]
      });
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundPatientArg] = advapacs.upsertPatient.mock.calls[0];
      expect(outboundPatientArg.identifier).toHaveLength(2);
      expect(outboundPatientArg.identifier).toContainEqual(unrelatedIdentifier);
      expect(outboundPatientArg.identifier).not.toContainEqual(systemlessIdentifier);
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

  describe('modality on the outbound ServiceRequest, from the orderable\'s DICOM coding (UHM-9445)', () => {
    const DICOM_CODE_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM';
    const modalityOf = (outboundArg) => outboundArg.orderDetail[0].parameter
      .find((parameter) => parameter.code.coding[0].code === 'modality').valueString;

    test('defaults to a CR (X-ray) modality parameter, identified by AdvaPACS\'s "modality" code with a valueString, when there is no code', async () => {
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

    test('uses the code of the DICOM coding as the modality', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: {
          coding: [
            { system: 'http://loinc.org', code: '24627-2' },
            { system: DICOM_CODE_SYSTEM, code: 'CT' }
          ]
        }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(modalityOf(outboundArg)).toBe('CT');
    });

    test('drops the DICOM coding from the outbound code, even when it comes first', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: {
          coding: [
            { system: DICOM_CODE_SYSTEM, code: 'DX' },
            { system: 'http://loinc.org', code: '36554-4' },
            { system: 'http://snomed.info/sct', code: '399208008' }
          ],
          text: 'Chest, 1 view (X-ray)'
        }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(modalityOf(outboundArg)).toBe('DX');
      expect(outboundArg.code.concept.coding).toEqual([
        { system: 'http://loinc.org', code: '36554-4' },
        { system: 'http://snomed.info/sct', code: '399208008' }
      ]);
      expect(outboundArg.code.concept.text).toBe('Chest, 1 view (X-ray)');
    });

    test('defaults to CR when the code has no DICOM coding', async () => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });

      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { coding: [{ system: 'http://loinc.org', code: '36554-4' }] }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(modalityOf(outboundArg)).toBe('CR');
    });
  });

  describe('clinical history (OpenMRS sends it as a note; AdvaPACS reads it from an orderDetail "clinical-history" parameter)', () => {
    const clinicalHistoryParameter = (text) => ({
      code: {
        coding: [{
          system: 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code',
          code: 'clinical-history'
        }]
      },
      valueString: text
    });

    beforeEach(() => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });
    });

    test('adds the note text as a clinical-history parameter, after the modality', async () => {
      await orderRelay.relayServiceRequest({ ...serviceRequestWithSubject, note: [{ text: 'Cough for 3 weeks' }] });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter).toHaveLength(2);
      expect(outboundArg.orderDetail[0].parameter[0].code.coding[0].code).toBe('modality');
      expect(outboundArg.orderDetail[0].parameter[1]).toEqual(clinicalHistoryParameter('Cough for 3 weeks'));
    });

    test('strips the note itself from the outbound ServiceRequest (AdvaPACS 422s on a note with no author)', async () => {
      await orderRelay.relayServiceRequest({ ...serviceRequestWithSubject, note: [{ text: 'Cough for 3 weeks' }] });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg).not.toHaveProperty('note');
    });

    test('joins the text of multiple notes, one per line, skipping any without text', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        note: [{ text: 'Cough for 3 weeks' }, { authorString: 'Someone' }, { text: 'Smoker' }]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter[1]).toEqual(clinicalHistoryParameter('Cough for 3 weeks\nSmoker'));
    });

    test('adds no clinical-history parameter when there is no note', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter).toHaveLength(1);
    });
  });

  describe('procedure description (AdvaPACS drops code.concept.text; reads it from an orderDetail "requested-procedure-description" parameter)', () => {
    const procedureDescriptionParameter = (text) => ({
      code: {
        coding: [{
          system: 'http://advapacs.com/fhir/servicerequest-orderdetail-parameter-code',
          code: 'requested-procedure-description'
        }]
      },
      valueString: text
    });

    beforeEach(() => {
      openmrs.getPatient.mockResolvedValue(patientWithEmrId);
      advapacs.upsertPatient.mockResolvedValue({ id: 'advapacs-patient-1' });
      advapacs.createServiceRequest.mockResolvedValue({ id: 'advapacs-sr-1' });
    });

    test('adds the code text as a requested-procedure-description parameter, after the modality', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { coding: [{ system: 'http://loinc.org', code: '36554-4' }], text: 'Chest, 1 view (X-ray)' }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter).toHaveLength(2);
      expect(outboundArg.orderDetail[0].parameter[0].code.coding[0].code).toBe('modality');
      expect(outboundArg.orderDetail[0].parameter[1]).toEqual(procedureDescriptionParameter('Chest, 1 view (X-ray)'));
    });

    test('still sends the code text under code.concept as well', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { coding: [{ system: 'http://loinc.org', code: '36554-4' }], text: 'Chest, 1 view (X-ray)' }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.code.concept.text).toBe('Chest, 1 view (X-ray)');
    });

    test('comes after the clinical-history parameter when both are present', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { text: 'Chest, 1 view (X-ray)' },
        note: [{ text: 'Cough for 3 weeks' }]
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter.map((p) => p.code.coding[0].code))
        .toEqual(['modality', 'clinical-history', 'requested-procedure-description']);
    });

    test('adds no requested-procedure-description parameter when the code has no text', async () => {
      await orderRelay.relayServiceRequest({
        ...serviceRequestWithSubject,
        code: { coding: [{ system: 'http://loinc.org', code: '36554-4' }] }
      });

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter).toHaveLength(1);
    });

    test('adds no requested-procedure-description parameter when there is no code at all', async () => {
      await orderRelay.relayServiceRequest(serviceRequestWithSubject);

      const [outboundArg] = advapacs.createServiceRequest.mock.calls[0];
      expect(outboundArg.orderDetail[0].parameter).toHaveLength(1);
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

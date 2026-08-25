jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('advapacsClient', () => {
  let axios;
  let mockClient;
  let advapacs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.ADVAPACS_CHANNEL_URL = 'http://openhim-core:5001/advapacs';
    process.env.ADVAPACS_CLIENT_ID = 'test-client-id';
    process.env.ADVAPACS_CLIENT_SECRET = 'test-secret';

    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      defaults: {
        headers: {
          'Content-Type': 'application/fhir+json',
          Authorization: 'ID=test-client-id,Secret=test-secret'
        }
      }
    };

    // Re-require axios after resetModules to get the correct mock reference
    axios = require('axios');
    axios.create.mockReturnValue(mockClient);
    // Also set up axios.get mock
    axios.get.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

    advapacs = require('../../src/lib/advapacsClient');
  });

  test('creates the axios client with ADVAPACS_CHANNEL_URL as baseURL and an ID/Secret Authorization header', () => {
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'http://openhim-core:5001/advapacs',
      headers: {
        'Content-Type': 'application/fhir+json',
        Authorization: 'ID=test-client-id,Secret=test-secret'
      }
    });
  });

  test('upsertPatient searches by identifierSystem|identifierValue, then PUTs to /Patient/{id} with the AdvaPACS id substituted into the body, when a match is found', async () => {
    const patient = { resourceType: 'Patient', id: 'p1' };
    mockClient.get.mockResolvedValue({
      data: { resourceType: 'Bundle', total: 1, entry: [{ resource: { resourceType: 'Patient', id: 'advapacs-p1' } }] }
    });
    mockClient.put.mockResolvedValue({ data: { resourceType: 'Patient', id: 'advapacs-p1' } });

    const result = await advapacs.upsertPatient(patient, 'http://www.pih.org/identifiers/lesotho/emr-id', 'CAAKH7');

    expect(mockClient.get).toHaveBeenCalledWith('/Patient', {
      params: { identifier: 'http://www.pih.org/identifiers/lesotho/emr-id|CAAKH7' }
    });
    expect(mockClient.put).toHaveBeenCalledWith('/Patient/advapacs-p1', { resourceType: 'Patient', id: 'advapacs-p1' });
    expect(result).toEqual({ resourceType: 'Patient', id: 'advapacs-p1' });
  });

  test('upsertPatient POSTs to /Patient (create) when the search finds no match', async () => {
    const patient = { resourceType: 'Patient', id: 'p1' };
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', total: 0, entry: [] } });
    mockClient.post.mockResolvedValue({ data: { resourceType: 'Patient', id: 'advapacs-new' } });

    const result = await advapacs.upsertPatient(patient, 'http://www.pih.org/identifiers/lesotho/emr-id', 'CAAKH7');

    expect(mockClient.get).toHaveBeenCalledWith('/Patient', {
      params: { identifier: 'http://www.pih.org/identifiers/lesotho/emr-id|CAAKH7' }
    });
    expect(mockClient.post).toHaveBeenCalledWith('/Patient', patient);
    expect(result).toEqual({ resourceType: 'Patient', id: 'advapacs-new' });
  });

  test('createServiceRequest posts the ServiceRequest to /ServiceRequest and returns response data', async () => {
    const serviceRequest = { resourceType: 'ServiceRequest', id: 'sr1' };
    mockClient.post.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'advapacs-sr1' } });

    const result = await advapacs.createServiceRequest(serviceRequest);

    expect(mockClient.post).toHaveBeenCalledWith('/ServiceRequest', serviceRequest);
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'advapacs-sr1' });
  });

  test('ensureSubscription posts a Subscription with the webhook endpoint and bearer secret', async () => {
    mockClient.post.mockResolvedValue({ data: { resourceType: 'Subscription', id: 'sub1' } });

    const result = await advapacs.ensureSubscription('http://mediator/webhooks/advapacs', 'shh-secret', 'ImagingStudy');

    expect(mockClient.post).toHaveBeenCalledWith('/Subscription', {
      resourceType: 'Subscription',
      status: 'active',
      reason: 'openhim-advapacs-mediator result delivery',
      criteria: 'ImagingStudy',
      channel: {
        type: 'rest-hook',
        endpoint: 'http://mediator/webhooks/advapacs',
        payload: 'application/fhir+json',
        header: ['Authorization: Bearer shh-secret']
      }
    });
    expect(result).toEqual({ resourceType: 'Subscription', id: 'sub1' });
  });

  test('ensureSubscription defaults criteria to ImagingStudy when not given', async () => {
    mockClient.post.mockResolvedValue({ data: { id: 'sub1' } });

    await advapacs.ensureSubscription('http://mediator/webhooks/advapacs', 'shh-secret');

    expect(mockClient.post).toHaveBeenCalledWith('/Subscription', expect.objectContaining({ criteria: 'ImagingStudy' }));
  });

  test('getResourceByUrl GETs the given absolute URL with the client headers', async () => {
    axios.get.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

    const result = await advapacs.getResourceByUrl('https://advapacs.example.com/fhir/ImagingStudy/img1');

    expect(axios.get).toHaveBeenCalledWith(
      'https://advapacs.example.com/fhir/ImagingStudy/img1',
      { headers: mockClient.defaults.headers }
    );
    expect(result).toEqual({ resourceType: 'ImagingStudy', id: 'img1' });
  });
});

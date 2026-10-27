jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('openmrsClient', () => {
  let mockClient;
  let openmrs;
  let axios;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.OPENMRS_BASE_URL = 'http://localhost:8080/openmrs';
    process.env.OPENMRS_FHIR_PATH = '/ws/fhir2/R5-test';
    process.env.OPENMRS_USERNAME = 'admin';
    process.env.OPENMRS_PASSWORD = 'Admin123';

    // Re-require axios after resetModules to get the correct mock reference
    axios = require('axios');

    mockClient = { get: jest.fn(), post: jest.fn(), put: jest.fn() };
    axios.create.mockReturnValue(mockClient);

    openmrs = require('../../src/lib/openmrsClient');
  });

  test('creates the axios client with OPENMRS_BASE_URL + OPENMRS_FHIR_PATH as baseURL and basic auth', () => {
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'http://localhost:8080/openmrs/ws/fhir2/R5-test',
      auth: { username: 'admin', password: 'Admin123' },
      headers: { 'Content-Type': 'application/fhir+json' }
    });
  });

  test('getResource GETs /{resourceType}/{id} and returns response data', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1' } });

    const result = await openmrs.getResource('ServiceRequest', 'sr1');

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest/sr1');
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'sr1' });
  });

  test('getPatient delegates to getResource with resourceType Patient', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Patient', id: 'p1' } });

    const result = await openmrs.getPatient('p1');

    expect(mockClient.get).toHaveBeenCalledWith('/Patient/p1');
    expect(result).toEqual({ resourceType: 'Patient', id: 'p1' });
  });

  test('createResource POSTs /{resourceType} and returns response data', async () => {
    const resource = { resourceType: 'ImagingStudy' };
    mockClient.post.mockResolvedValue({ data: { resourceType: 'ImagingStudy', id: 'img1' } });

    const result = await openmrs.createResource('ImagingStudy', resource);

    expect(mockClient.post).toHaveBeenCalledWith('/ImagingStudy', resource);
    expect(result).toEqual({ resourceType: 'ImagingStudy', id: 'img1' });
  });

  test('updateServiceRequestStatus fetches the current resource, sets status, and PUTs it back', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1', status: 'active' } });
    mockClient.put.mockResolvedValue({ data: { resourceType: 'ServiceRequest', id: 'sr1', status: 'completed' } });

    const result = await openmrs.updateServiceRequestStatus('sr1', 'completed');

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest/sr1');
    expect(mockClient.put).toHaveBeenCalledWith('/ServiceRequest/sr1', {
      resourceType: 'ServiceRequest', id: 'sr1', status: 'completed'
    });
    expect(result).toEqual({ resourceType: 'ServiceRequest', id: 'sr1', status: 'completed' });
  });

  test('searchServiceRequests builds _lastUpdated param when lastUpdatedAfter given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-08-05T00:00:00.000Z' });

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', {
      params: { _lastUpdated: 'gt2026-08-05T00:00:00.000Z' }
    });
  });

  test('searchServiceRequests builds status param when given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ status: 'active' });

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', { params: { status: 'active' } });
  });

  test('searchServiceRequests builds no params when neither status nor lastUpdatedAfter given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests();

    expect(mockClient.get).toHaveBeenCalledWith('/ServiceRequest', { params: {} });
  });

  test('getOrderClinicalHistory reads clinicalHistory from the REST order resource', async () => {
    mockClient.get.mockResolvedValue({ data: { clinicalHistory: 'Cough 3 weeks' } });

    const result = await openmrs.getOrderClinicalHistory('order-uuid');

    expect(mockClient.get).toHaveBeenCalledWith(
      'http://localhost:8080/openmrs/ws/rest/v1/order/order-uuid',
      { params: { v: 'custom:(clinicalHistory)' }, headers: { Accept: 'application/json' } }
    );
    expect(result).toBe('Cough 3 weeks');
  });

  test('getOrderClinicalHistory resolves to null when the order has none', async () => {
    mockClient.get.mockResolvedValue({ data: { clinicalHistory: null } });
    expect(await openmrs.getOrderClinicalHistory('order-uuid')).toBeNull();
  });
});

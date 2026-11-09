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

  // The serialised query of a client.get call's params (a URLSearchParams), decoded for readability
  const queryOf = (call) => decodeURIComponent(call[1].params.toString());

  const ORDER_INCLUDES_QUERY = [
    '_include=ServiceRequest:patient',
    '_include=ServiceRequest:requester',
    '_include=ServiceRequest:encounter',
    '_include:iterate=Encounter:part-of'
  ];

  test('searchServiceRequests sends the order includes and _lastUpdated', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-11-02T00:00:00.000Z' });

    expect(mockClient.get).toHaveBeenCalledTimes(1);
    expect(mockClient.get.mock.calls[0][0]).toBe('/ServiceRequest');
    const query = queryOf(mockClient.get.mock.calls[0]);
    expect(query).toContain('_lastUpdated=gt2026-11-02T00:00:00.000Z');
    ORDER_INCLUDES_QUERY.forEach((include) => expect(query.split('&')).toContain(include));
    expect(query).not.toContain('_include[]');
  });

  test('searchServiceRequests builds status param when given', async () => {
    mockClient.get.mockResolvedValue({ data: { resourceType: 'Bundle', entry: [] } });

    await openmrs.searchServiceRequests({ status: 'active' });

    expect(queryOf(mockClient.get.mock.calls[0]).split('&')).toContain('status=active');
  });

  test('searchServiceRequests follows next links and concatenates entries', async () => {
    const a = { resource: { resourceType: 'ServiceRequest', id: 'a' } };
    const b = { resource: { resourceType: 'ServiceRequest', id: 'b' } };
    mockClient.get
      .mockResolvedValueOnce({
        data: {
          resourceType: 'Bundle',
          entry: [a],
          link: [
            { relation: 'self', url: 'https://public.example.org/openmrs/ws/fhir2/R4/ServiceRequest' },
            { relation: 'next', url: 'https://public.example.org/openmrs/ws/fhir2/R4?_getpages=abc&_getpagesoffset=10' }
          ]
        }
      })
      .mockResolvedValueOnce({ data: { resourceType: 'Bundle', entry: [b] } });

    const result = await openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-11-02T00:00:00.000Z' });

    expect(result.entry).toEqual([a, b]);
    expect(mockClient.get).toHaveBeenCalledTimes(2);
    // only the link's query is used, against the configured OpenMRS base URL, never the link's own host
    expect(mockClient.get.mock.calls[1]).toEqual(['?_getpages=abc&_getpagesoffset=10']);
  });

  test('searchServiceRequests rejects when a later page fails', async () => {
    mockClient.get
      .mockResolvedValueOnce({
        data: { resourceType: 'Bundle', entry: [], link: [{ relation: 'next', url: 'http://x/ws/fhir2/R4?_getpages=abc' }] }
      })
      .mockRejectedValueOnce(new Error('page 2 failed'));

    await expect(openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-11-02T00:00:00.000Z' }))
      .rejects.toThrow('page 2 failed');
  });

  test('searchServiceRequests rejects, rather than looping forever, when a next link repeats', async () => {
    const page = {
      resourceType: 'Bundle',
      entry: [],
      link: [{ relation: 'next', url: 'http://x/ws/fhir2/R4?_getpages=abc&_getpagesoffset=10' }]
    };
    mockClient.get.mockResolvedValue({ data: page });

    await expect(openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-11-02T00:00:00.000Z' }))
      .rejects.toThrow(/next link repeats/);
    expect(mockClient.get).toHaveBeenCalledTimes(2);
  });

  test('searchServiceRequests rejects a next link with no query, rather than skipping the remaining pages', async () => {
    mockClient.get.mockResolvedValueOnce({
      data: { resourceType: 'Bundle', entry: [], link: [{ relation: 'next', url: 'http://x/ws/fhir2/R4' }] }
    });

    await expect(openmrs.searchServiceRequests({ lastUpdatedAfter: '2026-11-02T00:00:00.000Z' }))
      .rejects.toThrow(/next link has no query/);
  });

  test('getOrderBundle searches by _id with the order includes', async () => {
    const bundle = { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ServiceRequest', id: 'sr1' } }] };
    mockClient.get.mockResolvedValue({ data: bundle });

    const result = await openmrs.getOrderBundle('sr1');

    expect(mockClient.get.mock.calls[0][0]).toBe('/ServiceRequest');
    const query = queryOf(mockClient.get.mock.calls[0]).split('&');
    expect(query).toContain('_id=sr1');
    ORDER_INCLUDES_QUERY.forEach((include) => expect(query).toContain(include));
    expect(result).toEqual(bundle);
  });

  describe('getConceptsMappedToSource', () => {
    const CUSTOM_REP = 'custom:(uuid,mappings:(conceptReferenceTerm:(code,conceptSource:(uuid,name))))';
    const concept = (uuid) => ({ uuid, mappings: [] });
    const nextLink = (startIndex) => [{ rel: 'next', uri: `https://elsewhere.example/openmrs/ws/rest/v1/concept?source=DCM&startIndex=${startIndex}&limit=100` }];

    test('creates a REST client on OPENMRS_BASE_URL + /ws/rest/v1 with basic auth and a timeout', () => {
      // A timeout, so a hung OpenMRS can't hold up the mediator's startup or stop the map's refreshes
      expect(axios.create).toHaveBeenCalledWith({
        baseURL: 'http://localhost:8080/openmrs/ws/rest/v1',
        auth: { username: 'admin', password: 'Admin123' },
        timeout: 30000
      });
    });

    test('searches concepts by source with a custom representation', async () => {
      mockClient.get.mockResolvedValue({ data: { results: [concept('a')] } });

      const result = await openmrs.getConceptsMappedToSource('DCM');

      expect(mockClient.get).toHaveBeenCalledWith('/concept', {
        params: { source: 'DCM', v: CUSTOM_REP, limit: 100, startIndex: 0 }
      });
      expect(result).toEqual([concept('a')]);
    });

    test('follows next links until there are none', async () => {
      mockClient.get
        .mockResolvedValueOnce({ data: { results: [concept('a')], links: nextLink(100) } })
        .mockResolvedValueOnce({ data: { results: [concept('b')] } });

      const result = await openmrs.getConceptsMappedToSource('DCM');

      expect(result).toEqual([concept('a'), concept('b')]);
      expect(mockClient.get).toHaveBeenCalledTimes(2);
      expect(mockClient.get.mock.calls[1][1].params.startIndex).toBe(100);
    });

    test('rejects when a page fails', async () => {
      mockClient.get
        .mockResolvedValueOnce({ data: { results: [concept('a')], links: nextLink(100) } })
        .mockRejectedValueOnce(new Error('Request failed with status code 500'));

      await expect(openmrs.getConceptsMappedToSource('DCM')).rejects.toThrow('500');
    });

    test('rejects a next link without a startIndex, rather than skipping the remaining pages', async () => {
      mockClient.get.mockResolvedValue({ data: { results: [concept('a')], links: [{ rel: 'next', uri: '/ws/rest/v1/concept?source=DCM' }] } });

      await expect(openmrs.getConceptsMappedToSource('DCM')).rejects.toThrow(/no startIndex/);
    });

    test('rejects when the concept search\'s next link repeats', async () => {
      mockClient.get.mockResolvedValue({ data: { results: [concept('a')], links: nextLink(100) } });

      await expect(openmrs.getConceptsMappedToSource('DCM')).rejects.toThrow(/repeats/);
    });
  });
});

jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('radiologyappClient', () => {
  let axios;
  let mockClient;
  let radiologyapp;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.OPENMRS_RESULTS_CHANNEL_URL = 'http://openhim-core:5001/openmrs';
    process.env.OPENHIM_RESULTS_CLIENT_ID = 'results-client';
    process.env.OPENHIM_RESULTS_CLIENT_PASSWORD = 'results-pw';

    mockClient = { post: jest.fn() };
    axios = require('axios');
    axios.create.mockReturnValue(mockClient);

    radiologyapp = require('../../src/lib/radiologyappClient');
  });

  test("posts a study to /study with the results client's Basic auth", async () => {
    const result = { outcome: 'CREATED', encounterUuid: 'enc-1', studyCreated: true };
    mockClient.post.mockResolvedValue({ status: 200, data: result });
    const body = { accessionNumber: 'A1' };

    await expect(radiologyapp.importStudy(body)).resolves.toEqual(result);

    expect(axios.create).toHaveBeenCalledWith({
      baseURL: 'http://openhim-core:5001/openmrs/ws/rest/v1/radiologyapp',
      auth: { username: 'results-client', password: 'results-pw' },
      timeout: 30000
    });
    expect(mockClient.post).toHaveBeenCalledWith('/study', body);
  });

  test('posts a report to /report', async () => {
    const result = { outcome: 'ALREADY_EXISTS', encounterUuid: 'enc-2', studyCreated: false };
    mockClient.post.mockResolvedValue({ status: 200, data: result });
    const body = { accessionNumber: 'A1', reportText: 'x' };

    await expect(radiologyapp.importReport(body)).resolves.toEqual(result);
    expect(mockClient.post).toHaveBeenCalledWith('/report', body);
  });

  test("rejects on 400 with the server's error message in the Error", async () => {
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400, data: { error: 'accessionNumber is required' } };
    mockClient.post.mockRejectedValue(err);

    await expect(radiologyapp.importStudy({})).rejects.toThrow(/accessionNumber is required/);
  });

  test('defaults the username to advapacs-mediator', () => {
    jest.resetModules();
    delete process.env.OPENHIM_RESULTS_CLIENT_ID;
    axios = require('axios');
    axios.create.mockReturnValue(mockClient);
    require('../../src/lib/radiologyappClient');
    expect(axios.create.mock.calls[0][0].auth.username).toBe('advapacs-mediator');
  });
});

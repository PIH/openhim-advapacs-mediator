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

  const body = { reportText: 'SECRET-REPORT-TEXT' };
  const axiosLikeError = (extra) =>
    Object.assign(new Error('axios failure'), {
      config: { data: JSON.stringify(body), auth: { password: 'results-pw' } },
      request: {},
      ...extra
    });
  const expectClean = (e) => {
    expect(e).not.toHaveProperty('config');
    expect(e).not.toHaveProperty('request');
    expect(e).not.toHaveProperty('response');
    const dumped = JSON.stringify(e) + e.message + e.stack;
    expect(dumped).not.toContain('SECRET-REPORT-TEXT');
    expect(dumped).not.toContain('results-pw');
  };

  test('400 rejection carries no axios objects or secrets', async () => {
    mockClient.post.mockRejectedValue(
      axiosLikeError({ response: { status: 400, data: { error: 'bad' }, config: {}, request: {} } })
    );
    const e = await radiologyapp.importReport(body).catch((x) => x);
    expect(e.message).toMatch(/400.*bad/);
    expect(e.status).toBe(400);
    expectClean(e);
  });

  test('network error with no response rejects with the code', async () => {
    mockClient.post.mockRejectedValue(axiosLikeError({ code: 'ECONNREFUSED' }));
    const e = await radiologyapp.importReport(body).catch((x) => x);
    expect(e.message).toContain('ECONNREFUSED');
    expect(e.code).toBe('ECONNREFUSED');
    expectClean(e);
  });

  test('500 with an HTML body rejects with status 500', async () => {
    mockClient.post.mockRejectedValue(
      axiosLikeError({ response: { status: 500, data: '<html>oops</html>' } })
    );
    const e = await radiologyapp.importStudy(body).catch((x) => x);
    expect(e.message).toContain('500');
    expect(e.message).not.toContain('html');
    expect(e.status).toBe(500);
    expectClean(e);
  });

  test('non-string server error is not interpolated', async () => {
    mockClient.post.mockRejectedValue(
      axiosLikeError({ response: { status: 400, data: { error: { a: 1 } } } })
    );
    const e = await radiologyapp.importStudy(body).catch((x) => x);
    expect(e.message).not.toContain('[object Object]');
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

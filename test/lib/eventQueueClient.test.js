jest.mock('axios');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('eventQueueClient', () => {
  let mockClient;
  let submitEvent;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.OPENHIM_ROUTER_URL = 'http://openhim-core:5001';
    process.env.OPENHIM_RESULTS_CLIENT_ID = 'results-client';
    process.env.OPENHIM_RESULTS_CLIENT_PASSWORD = 'results-pw';
    process.env.MEDIATOR_INBOUND_SECRET = 'inbound-secret';
    mockClient = { post: jest.fn() };
    require('axios').create.mockReturnValue(mockClient);
    ({ submitEvent } = require('../../src/lib/eventQueueClient'));
  });

  const EVENT = { eventType: 'REPORT_UPDATED', data: { type: 'report', id: 'r1' } };

  test("posts the event with the results client's auth and the shared secret", async () => {
    mockClient.post.mockResolvedValue({ status: 200 });

    await expect(submitEvent(EVENT)).resolves.toEqual({ accepted: true, status: 200 });

    expect(mockClient.post).toHaveBeenCalledWith(
      'http://openhim-core:5001/results/advapacs-event',
      EVENT,
      expect.objectContaining({
        auth: { username: 'results-client', password: 'results-pw' },
        headers: { 'X-Mediator-Secret': 'inbound-secret' },
        timeout: 30000
      })
    );
  });

  test('defaults the client id to advapacs-mediator', async () => {
    delete process.env.OPENHIM_RESULTS_CLIENT_ID;
    mockClient.post.mockResolvedValue({ status: 200 });
    await submitEvent(EVENT);
    expect(mockClient.post.mock.calls[0][2].auth.username).toBe('advapacs-mediator');
  });

  test.each([200, 503, 504, 500])('treats %i as accepted', async (status) => {
    mockClient.post.mockResolvedValue({ status });
    await expect(submitEvent(EVENT)).resolves.toEqual({ accepted: true, status });
  });

  test.each([401, 403, 404])('treats %i as not accepted', async (status) => {
    mockClient.post.mockResolvedValue({ status });
    await expect(submitEvent(EVENT)).resolves.toEqual({ accepted: false, status });
  });

  test('treats a network error as not accepted', async () => {
    const err = new Error('boom');
    err.code = 'ECONNREFUSED';
    mockClient.post.mockRejectedValue(err);
    await expect(submitEvent(EVENT)).resolves.toEqual({ accepted: false, code: 'ECONNREFUSED' });
  });

  test('the result carries no axios objects', async () => {
    const err = new Error('boom');
    err.code = 'ECONNABORTED';
    err.config = { auth: { password: 'results-pw' }, data: EVENT };
    mockClient.post.mockRejectedValue(err);
    const result = await submitEvent(EVENT);
    expect(JSON.stringify(result)).not.toContain('results-pw');
    expect(Object.keys(result).sort()).toEqual(['accepted', 'code']);

    mockClient.post.mockResolvedValue({ status: 200, config: { auth: { password: 'results-pw' } }, request: {}, data: {} });
    const ok = await submitEvent(EVENT);
    expect(Object.keys(ok).sort()).toEqual(['accepted', 'status']);
  });
});

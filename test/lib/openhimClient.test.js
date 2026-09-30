const http = require('http');

jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

function loadClient(env) {
  jest.resetModules();
  Object.assign(process.env, {
    OPENHIM_USERNAME: 'root@openhim.org',
    OPENHIM_PASSWORD: 'pw',
    OPENHIM_TRUST_SELF_SIGNED: 'false',
    ...env
  });
  return require('../../src/lib/openhimClient');
}

describe('openhimClient against a plain HTTP OpenHIM API', () => {
  // openhim-mediator-utils always passed an https.Agent, which fails against http:// URLs
  // (ERR_INVALID_PROTOCOL) -- this is the case that has to work.
  let server;
  let requests;

  beforeEach((done) => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.statusCode = req.url === '/mediators' ? 201 : 200;
        res.end('OK');
      });
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => { server.close(done); });

  test('registerMediator POSTs the mediator config to /mediators with basic auth', async () => {
    const openhim = loadClient({ OPENHIM_API_URL: `http://127.0.0.1:${server.address().port}` });

    await openhim.registerMediator({ urn: 'urn:mediator:test', name: 'Test' });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/mediators');
    expect(requests[0].auth).toBe(`Basic ${Buffer.from('root@openhim.org:pw').toString('base64')}`);
    expect(JSON.parse(requests[0].body)).toEqual({ urn: 'urn:mediator:test', name: 'Test' });
  });

  test('activateHeartbeat POSTs the uptime to /mediators/{urn}/heartbeat right away', async () => {
    const openhim = loadClient({ OPENHIM_API_URL: `http://127.0.0.1:${server.address().port}` });

    const timer = openhim.activateHeartbeat('urn:mediator:test', 60000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    clearInterval(timer);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/mediators/urn:mediator:test/heartbeat');
    expect(JSON.parse(requests[0].body)).toHaveProperty('uptime');
  });
});

describe('openhimClient configuration', () => {
  test('trusts a self-signed certificate on an https:// API only when OPENHIM_TRUST_SELF_SIGNED is true', () => {
    let openhim = loadClient({ OPENHIM_API_URL: 'https://openhim-core:8080', OPENHIM_TRUST_SELF_SIGNED: 'true' });
    expect(openhim.client.defaults.httpsAgent.options.rejectUnauthorized).toBe(false);
    openhim = loadClient({ OPENHIM_API_URL: 'https://openhim-core:8080', OPENHIM_TRUST_SELF_SIGNED: 'false' });
    expect(openhim.client.defaults.httpsAgent.options.rejectUnauthorized).toBe(true);
  });

  test('a failed registration rejects, with the status in the message', async () => {
    const openhim = loadClient({ OPENHIM_API_URL: 'http://127.0.0.1:1' });
    await expect(openhim.registerMediator({ urn: 'x' })).rejects.toThrow();
  });

  test('a failed heartbeat is logged, not thrown, and the heartbeat keeps going', async () => {
    jest.useFakeTimers();
    const openhim = loadClient({ OPENHIM_API_URL: 'http://127.0.0.1:1' });
    const post = jest.spyOn(openhim.client, 'post').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const logger = require('../../src/lib/logger');

    const timer = openhim.activateHeartbeat('urn:mediator:test', 10000);
    await jest.advanceTimersByTimeAsync(20000);
    clearInterval(timer);
    jest.useRealTimers();

    expect(post).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith('OpenHIM heartbeat failed', { error: 'connect ECONNREFUSED' });
  });
});

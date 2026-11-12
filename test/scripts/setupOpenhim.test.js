jest.mock('../../src/lib/openhimClient', () => ({ client: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));

const crypto = require('crypto');
const { client: api } = require('../../src/lib/openhimClient');
const { main } = require('../../scripts/setupOpenhim');

const WEBHOOK_CHANNEL = 'AdvaPACS to Mediator Study and Report Webhook';
const RESULTS_CHANNEL = 'Mediator to OpenMRS Radiology Results';

function posted(path) {
  return api.post.mock.calls.filter(([p]) => p === path).map(([, body]) => body);
}

describe('setupOpenhim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.OPENHIM_USERNAME = 'root@openhim.org';
    process.env.OPENHIM_INBOUND_CLIENT_PASSWORD = 'inbound-password';
    process.env.ADVAPACS_BASE_URL = 'https://usa1.api.integration.advapacs.com/fhir/R5';
    process.env.ADVAPACS_WEBHOOK_SECRET = 'webhook-password';
    delete process.env.ADVAPACS_WEBHOOK_CLIENT_ID;
    process.env.OPENMRS_BASE_URL = 'http://openmrs:8080/openmrs';
    process.env.OPENMRS_USERNAME = 'admin';
    process.env.OPENMRS_PASSWORD = 'openmrs-password';
    process.env.OPENHIM_RESULTS_CLIENT_PASSWORD = 'results-password';
    delete process.env.OPENHIM_RESULTS_CLIENT_ID;
    // Nothing exists yet: every list is empty, so everything is created
    api.get.mockResolvedValue({ data: [] });
    api.post.mockResolvedValue({});
  });

  test('creates the AdvaPACS webhook client, with ADVAPACS_WEBHOOK_SECRET as its password', async () => {
    await main();

    const client = posted('/clients').find((c) => c.clientID === 'advapacs');
    expect(client).toMatchObject({ name: 'AdvaPACS webhook', roles: [], passwordAlgorithm: 'sha512' });
    const hash = crypto.createHash('sha512').update('webhook-password').update(client.passwordSalt).digest('hex');
    expect(client.passwordHash).toBe(hash);
  });

  test('creates the webhook channel, open only to that client and forwarding its credentials to the mediator', async () => {
    await main();

    const channel = posted('/channels').find((c) => c.name === WEBHOOK_CHANNEL);
    expect(channel).toMatchObject({
      urlPattern: '^/webhooks/advapacs$',
      authType: 'private',
      allow: ['advapacs'],
      methods: ['POST']
    });
    expect(channel.routes).toEqual([expect.objectContaining({
      host: 'openhim-advapacs-mediator',
      port: 3500,
      forwardAuthHeader: true
    })]);
  });

  test('uses ADVAPACS_WEBHOOK_CLIENT_ID for the client and the channel', async () => {
    process.env.ADVAPACS_WEBHOOK_CLIENT_ID = 'advapacs-kol-ci';

    await main();

    expect(posted('/clients').map((c) => c.clientID)).toContain('advapacs-kol-ci');
    expect(posted('/channels').find((c) => c.name === WEBHOOK_CHANNEL).allow).toEqual(['advapacs-kol-ci']);
  });

  test('without ADVAPACS_WEBHOOK_SECRET, creates no webhook client, so the channel accepts no one', async () => {
    delete process.env.ADVAPACS_WEBHOOK_SECRET;
    delete process.env.OPENHIM_RESULTS_CLIENT_PASSWORD;

    await main();

    expect(posted('/clients').map((c) => c.clientID)).toEqual(['openmrs']);
    expect(posted('/channels').map((c) => c.name)).toContain(WEBHOOK_CHANNEL);
  });

  test('provisions the results channel with the OpenMRS route and credentials', async () => {
    await main();

    const channel = posted('/channels').find((c) => c.name === RESULTS_CHANNEL);
    expect(channel).toMatchObject({
      urlPattern: '^/openmrs/ws/rest/v1/radiologyapp/(study|report)$',
      authType: 'private',
      methods: ['POST']
    });
    expect(channel.routes).toEqual([expect.objectContaining({
      host: 'openmrs',
      port: 8080,
      secured: false,
      pathTransform: 's/^\\/openmrs/\\/openmrs/',
      username: 'admin',
      password: 'openmrs-password',
      forwardAuthHeader: false
    })]);
  });

  test('creates the results client when OPENHIM_RESULTS_CLIENT_PASSWORD is set', async () => {
    await main();

    const client = posted('/clients').find((c) => c.clientID === 'advapacs-mediator');
    expect(client).toMatchObject({ name: 'AdvaPACS mediator (results to OpenMRS)', roles: [], passwordAlgorithm: 'sha512' });
    const hash = crypto.createHash('sha512').update('results-password').update(client.passwordSalt).digest('hex');
    expect(client.passwordHash).toBe(hash);
  });

  test('skips the results client when the password is unset', async () => {
    delete process.env.OPENHIM_RESULTS_CLIENT_PASSWORD;

    await main();

    expect(posted('/clients').map((c) => c.clientID)).not.toContain('advapacs-mediator');
    expect(posted('/channels').map((c) => c.name)).toContain(RESULTS_CHANNEL);
  });

  test('allows only the results client on the channel', async () => {
    process.env.OPENHIM_RESULTS_CLIENT_ID = 'mediator-results';

    await main();

    expect(posted('/clients').map((c) => c.clientID)).toContain('mediator-results');
    expect(posted('/channels').find((c) => c.name === RESULTS_CHANNEL).allow).toEqual(['mediator-results']);
  });
});

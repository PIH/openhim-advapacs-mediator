jest.mock('../../src/lib/openhimClient', () => ({ client: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));

const crypto = require('crypto');
const { client: api } = require('../../src/lib/openhimClient');
const { main } = require('../../scripts/setupOpenhim');

const WEBHOOK_CHANNEL = 'AdvaPACS to Mediator Study and Report Webhook';
const RESULTS_CHANNEL = 'Mediator to OpenMRS Radiology Results';
const EVENT_CHANNEL = 'AdvaPACS Event Processing';

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
      urlPattern: '^/openmrs/ws/rest/v1/radiologyapp/(studyimport|reportimport)$',
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

  test('provisions the event processing channel with auto-retry and a 10s timeout', async () => {
    await main();

    const channel = posted('/channels').find((c) => c.name === EVENT_CHANNEL);
    expect(channel).toMatchObject({
      urlPattern: '^/results/advapacs-event$',
      authType: 'private',
      methods: ['POST'],
      timeout: 10000,
      autoRetryEnabled: true,
      autoRetryPeriodMinutes: 5,
      autoRetryMaxAttempts: 24,
      requestBody: true,
      responseBody: true
    });
    expect(channel.routes).toEqual([expect.objectContaining({
      name: 'OpenMRS-AdvaPACS FHIR Mediator results route',
      host: 'openhim-advapacs-mediator',
      port: 3500,
      primary: true,
      forwardAuthHeader: false
    })]);
  });

  test('allows only the results client on the event processing channel', async () => {
    process.env.OPENHIM_RESULTS_CLIENT_ID = 'mediator-results';

    await main();

    expect(posted('/channels').find((c) => c.name === EVENT_CHANNEL).allow).toEqual(['mediator-results']);
  });

  test('skips the event processing channel when OPENHIM_RESULTS_CLIENT_PASSWORD is unset', async () => {
    delete process.env.OPENHIM_RESULTS_CLIENT_PASSWORD;

    await main();

    expect(posted('/channels').map((c) => c.name)).not.toContain(EVENT_CHANNEL);
    const logged = console.log.mock.calls.map(([m]) => m).join('\n');
    expect(logged).toContain('OPENHIM_RESULTS_CLIENT_PASSWORD');
  });

  test.each(['OPENMRS_BASE_URL', 'OPENMRS_USERNAME', 'OPENMRS_PASSWORD'])(
    'skips the results channel and names the variable when %s is unset', async (name) => {
      delete process.env[name];

      await main();

      const names = posted('/channels').map((c) => c.name);
      expect(names).not.toContain(RESULTS_CHANNEL);
      expect(names).toEqual(expect.arrayContaining(['OpenMRS to Mediator Order Push', WEBHOOK_CHANNEL]));
      const logged = console.log.mock.calls.map(([m]) => m).join('\n');
      expect(logged).toContain(name);
      expect(logged).not.toContain('openmrs-password');
    });

  describe('the "Mediator to AdvaPACS" channel', () => {
    const NEW_NAME = 'Mediator to AdvaPACS';
    const OLD_NAME = 'Mediator to AdvaPACS Order Push';

    function existingChannels(channels) {
      api.get.mockImplementation(async (path) => ({ data: path === '/channels' ? channels : [] }));
    }
    function putTo(id) {
      return api.put.mock.calls.filter(([p]) => p === `/channels/${id}`).map(([, body]) => body);
    }

    test('renames the old "Mediator to AdvaPACS Order Push" channel in place instead of creating a new one', async () => {
      existingChannels([{ _id: 'old-id', name: OLD_NAME }]);

      await main();

      const puts = putTo('old-id');
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({ name: NEW_NAME, urlPattern: '^/advapacs/.*$' });
      expect(posted('/channels').map((c) => c.name)).not.toContain(NEW_NAME);
      expect(posted('/channels').map((c) => c.name)).not.toContain(OLD_NAME);
      expect(api.delete).toBeUndefined();
      const logged = console.log.mock.calls.map(([m]) => m).join('\n');
      expect(logged).toContain(`Renamed channel "${OLD_NAME}" to "${NEW_NAME}"`);
    });

    test('updates "Mediator to AdvaPACS" when it already exists', async () => {
      existingChannels([{ _id: 'new-id', name: NEW_NAME }, { _id: 'old-id', name: OLD_NAME }]);

      await main();

      expect(putTo('new-id')).toEqual([expect.objectContaining({ name: NEW_NAME })]);
      expect(putTo('old-id')).toHaveLength(0);
      expect(posted('/channels').map((c) => c.name)).not.toContain(NEW_NAME);
    });

    test('creates "Mediator to AdvaPACS" when neither name exists', async () => {
      await main();

      expect(posted('/channels').map((c) => c.name)).toContain(NEW_NAME);
      expect(api.put.mock.calls.filter(([p]) => p.startsWith('/channels/'))).toHaveLength(0);
    });
  });
});

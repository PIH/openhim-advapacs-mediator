jest.mock('../../src/lib/openhimClient', () => ({ client: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));

const crypto = require('crypto');
const { client: api } = require('../../src/lib/openhimClient');
const { main } = require('../../scripts/setupOpenhim');

const WEBHOOK_CHANNEL = 'AdvaPACS Webhook';

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

    await main();

    expect(posted('/clients').map((c) => c.clientID)).toEqual(['openmrs']);
    expect(posted('/channels').map((c) => c.name)).toContain(WEBHOOK_CHANNEL);
  });
});

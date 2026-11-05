jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const logger = require('../../src/lib/logger');
const advapacsWebhookRoute = require('../../src/routes/advapacsWebhook');

const EVENT = {
  timestamp: '2026-06-05T04:06:53.396337363Z',
  eventId: 'da80ed95-a33c-4526-940c-bbf277e13d50',
  eventType: 'REPORT_UPDATED',
  data: { type: 'report', id: '94ede09f-3623-4d1b-9ea9-a288e44deb45' }
};

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

describe('POST /webhooks/advapacs', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADVAPACS_WEBHOOK_SECRET = 'test-webhook-secret';
    delete process.env.ADVAPACS_WEBHOOK_CLIENT_ID;
    app = express();
    app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));
    app.use(advapacsWebhookRoute);
  });

  test('responds 200 and logs the event when the credentials are the AdvaPACS client\'s', async () => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send(EVENT);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(logger.info).toHaveBeenCalledWith('Received AdvaPACS webhook event', {
      eventType: 'REPORT_UPDATED',
      eventId: 'da80ed95-a33c-4526-940c-bbf277e13d50',
      timestamp: '2026-06-05T04:06:53.396337363Z',
      resourceType: 'report',
      resourceId: '94ede09f-3623-4d1b-9ea9-a288e44deb45'
    });
  });

  test('accepts the client id set in ADVAPACS_WEBHOOK_CLIENT_ID', async () => {
    process.env.ADVAPACS_WEBHOOK_CLIENT_ID = 'advapacs-kol-ci';

    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs-kol-ci', 'test-webhook-secret'))
      .send(EVENT);

    expect(response.status).toBe(200);
  });

  test.each([
    ['no Authorization header', undefined],
    ['the wrong password', basicAuth('advapacs', 'wrong')],
    ['the wrong client id', basicAuth('someone-else', 'test-webhook-secret')],
    ['a Bearer token', 'Bearer test-webhook-secret']
  ])('responds 401 and logs no event for %s', async (_label, authorization) => {
    const req = request(app).post('/webhooks/advapacs');
    if (authorization) req.set('Authorization', authorization);
    const response = await req.send(EVENT);

    expect(response.status).toBe(401);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('responds 401 when ADVAPACS_WEBHOOK_SECRET isn\'t set, whatever is sent', async () => {
    delete process.env.ADVAPACS_WEBHOOK_SECRET;

    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', ''))
      .send(EVENT);

    expect(response.status).toBe(401);
  });

  test.each([
    ['no eventType', { ...EVENT, eventType: undefined }],
    ['no data', { ...EVENT, data: undefined }],
    ['no data.id', { ...EVENT, data: { type: 'report' } }]
  ])('responds 400 for an event with %s', async (_label, body) => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send(body);

    expect(response.status).toBe(400);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('logs the names, but not the values, of fields the docs don\'t describe', async () => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send({ ...EVENT, organisation: 'LS-DM', data: { ...EVENT.data, accession: '0000010496' } });

    expect(response.status).toBe(200);
    const [, logged] = logger.info.mock.calls[0];
    expect(logged.otherFields).toEqual(['organisation']);
    expect(logged.otherDataFields).toEqual(['accession']);
    expect(JSON.stringify(logged)).not.toContain('0000010496');
    expect(JSON.stringify(logged)).not.toContain('LS-DM');
  });
});

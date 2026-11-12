jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../../src/lib/resultHandler', () => ({ handleEvent: jest.fn() }));

const express = require('express');
const request = require('supertest');
const logger = require('../../src/lib/logger');
const { handleEvent } = require('../../src/lib/resultHandler');
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
    jest.resetAllMocks();
    handleEvent.mockResolvedValue({ outcome: 'CREATED' });
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
  ])('acknowledges (200) but only warns about an event with %s, as AdvaPACS\'s webhook test sends', async (_label, body) => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send(body);

    expect(response.status).toBe(200);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('logs only the names of an incomplete event\'s fields, not their values', async () => {
    await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send({ ...EVENT, eventType: '', data: { type: 'study', accession: '0000010496' } });

    const [, logged] = logger.warn.mock.calls[0];
    expect(logged).toEqual({
      fields: ['timestamp', 'eventId', 'eventType', 'data'],
      dataFields: ['type', 'accession'],
      hasEventType: false
    });
    expect(JSON.stringify(logged)).not.toContain('0000010496');
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

  test('returns 200 with the handler\'s outcome', async () => {
    handleEvent.mockResolvedValue({ outcome: 'SKIPPED', reason: 'status partial' });

    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send(EVENT);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', outcome: 'SKIPPED' });
    expect(handleEvent).toHaveBeenCalledWith(EVENT);
  });

  test('returns 500 when the handler rejects, logging only the message', async () => {
    const failure = new Error('AdvaPACS read failed');
    failure.config = { auth: { password: 'secret-should-not-be-logged' } };
    handleEvent.mockRejectedValue(failure);

    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send(EVENT);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'error' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('secret-should-not-be-logged');
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain('AdvaPACS read failed');
  });

  test('still acknowledges a TEST_EVENT without calling the handler', async () => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'test-webhook-secret'))
      .send({ ...EVENT, eventType: 'TEST_EVENT', data: {} });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  test('rejects bad credentials before calling the handler', async () => {
    const response = await request(app)
      .post('/webhooks/advapacs')
      .set('Authorization', basicAuth('advapacs', 'wrong'))
      .send(EVENT);

    expect(response.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });
});

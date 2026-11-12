jest.mock('../../src/lib/resultHandler');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const logger = require('../../src/lib/logger');
const { handleEvent } = require('../../src/lib/resultHandler');
const advapacsEventRoute = require('../../src/routes/advapacsEvent');

const event = { eventId: 'e1', eventType: 'REPORT_CREATED', data: { type: 'DiagnosticReport', id: 'r1' } };

describe('POST /results/advapacs-event', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIATOR_INBOUND_SECRET = 'test-inbound-secret';
    app = express();
    app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));
    app.use(advapacsEventRoute);
  });

  test('returns 200 with the outcome for a handled event', async () => {
    handleEvent.mockResolvedValue({ outcome: 'SKIPPED', reason: 'event type' });
    const response = await request(app)
      .post('/results/advapacs-event')
      .set('X-Mediator-Secret', 'test-inbound-secret')
      .send(event);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', outcome: 'SKIPPED', reason: 'event type' });
    expect(handleEvent).toHaveBeenCalledWith(event);
  });

  test('answers an OpenHIM mediator-error (503, application/json+openhim, error.message) when the handler rejects', async () => {
    handleEvent.mockRejectedValue(new Error('Failed to handle REPORT_CREATED event: boom'));
    const response = await request(app)
      .post('/results/advapacs-event')
      .set('X-Mediator-Secret', 'test-inbound-secret')
      .send(event);
    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/json\+openhim/);
    const body = JSON.parse(response.text);
    expect(body['x-mediator-urn']).toBe(require('../../mediatorConfig.json').urn);
    expect(body.error).toEqual({ message: 'Failed to handle REPORT_CREATED event: boom' });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error: 'Failed to handle REPORT_CREATED event: boom' });
  });

  test('rejects a request without the shared secret (401) without calling the handler', async () => {
    const response = await request(app).post('/results/advapacs-event').send(event);
    expect(response.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });
});

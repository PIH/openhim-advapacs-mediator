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
    expect(handleEvent).toHaveBeenCalledWith(event, { isAbandoned: expect.any(Function) });
    expect(handleEvent.mock.calls[0][1].isAbandoned()).toBe(false);
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
    expect(body.response.status).toBe(503);
    expect(body.error).toEqual({ message: 'Failed to handle REPORT_CREATED event: boom' });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error: 'Failed to handle REPORT_CREATED event: boom' });
  });

  test('rejects a request without the shared secret (401) without calling the handler', async () => {
    const response = await request(app).post('/results/advapacs-event').send(event);
    expect(response.status).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
  });

  test('isAbandoned turns true once the caller closes the connection before a response', async () => {
    const http = require('http');
    let isAbandoned;
    let release;
    handleEvent.mockImplementation((_event, options) => {
      ({ isAbandoned } = options);
      return new Promise((resolve) => { release = resolve; });
    });
    const server = app.listen(0);
    try {
      const req = http.request({
        port: server.address().port, method: 'POST', path: '/results/advapacs-event',
        headers: { 'Content-Type': 'application/json', 'X-Mediator-Secret': 'test-inbound-secret' }
      });
      req.on('error', () => {});
      req.end(JSON.stringify(event));
      while (!isAbandoned) await new Promise((r) => setTimeout(r, 5));
      expect(isAbandoned()).toBe(false);
      req.destroy();
      for (let i = 0; i < 100 && !isAbandoned(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(isAbandoned()).toBe(true);
      release({ outcome: 'CREATED' });
    } finally {
      server.close();
    }
  });
});

jest.mock('../../src/lib/orderRelay');
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const orderRelay = require('../../src/lib/orderRelay');
const serviceRequestRoute = require('../../src/routes/serviceRequest');

describe('POST /fhir/ServiceRequest', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIATOR_INBOUND_SECRET = 'test-inbound-secret';
    app = express();
    app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));
    app.use(serviceRequestRoute);
  });

  test('responds 200 with the AdvaPACS id when the relay succeeds', async () => {
    orderRelay.relayServiceRequest.mockResolvedValue({
      serviceRequest: { id: 'sr1' },
      created: { id: 'advapacs-sr-1' }
    });

    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .set('X-Mediator-Secret', 'test-inbound-secret')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', advapacsServiceRequestId: 'advapacs-sr-1' });
  });

  test('responds 502 with the error message when the relay fails', async () => {
    orderRelay.relayServiceRequest.mockRejectedValue(new Error('AdvaPACS unreachable'));

    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .set('X-Mediator-Secret', 'test-inbound-secret')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ status: 'error', message: 'AdvaPACS unreachable' });
  });

  test('answers a retryable error with a failed OpenHIM mediator response, so OpenHIM retries it', async () => {
    orderRelay.relayServiceRequest.mockRejectedValue(
      Object.assign(new Error('Modality map not loaded yet'), { retryable: true })
    );

    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .set('X-Mediator-Secret', 'test-inbound-secret')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/json\+openhim/);
    const body = JSON.parse(response.text);
    expect(body['x-mediator-urn']).toBe(require('../../mediatorConfig.json').urn);
    expect(body.status).toBe('Failed');
    expect(body.error).toEqual({ message: 'Modality map not loaded yet' });
    expect(body.response.status).toBe(503);
    expect(JSON.parse(body.response.body)).toEqual({ status: 'error', message: 'Modality map not loaded yet' });
  });

  test('responds 401 and never calls the relay when X-Mediator-Secret is missing or wrong', async () => {
    const response = await request(app)
      .post('/fhir/ServiceRequest')
      .send({ resourceType: 'ServiceRequest', id: 'sr1' });

    expect(response.status).toBe(401);
    expect(orderRelay.relayServiceRequest).not.toHaveBeenCalled();
  });
});

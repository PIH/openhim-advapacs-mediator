jest.mock('../../src/lib/modalityMap');

const express = require('express');
const request = require('supertest');
const modalityMap = require('../../src/lib/modalityMap');
const healthRoute = require('../../src/routes/health');

describe('GET /health', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(healthRoute);
  });

  test('responds 503 while the modality map isn\'t loaded, as orders are being held', async () => {
    modalityMap.isLoaded.mockReturnValue(false);

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'modality map not loaded' });
  });

  test('responds 200 once the modality map has loaded', async () => {
    modalityMap.isLoaded.mockReturnValue(true);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'up' });
  });
});

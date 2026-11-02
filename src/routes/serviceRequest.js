const express = require('express');
const logger = require('../lib/logger');
const { relayServiceRequest } = require('../lib/orderRelay');
const { requireSharedSecret } = require('../lib/sharedSecretAuth');

const router = express.Router();

// Backstop independent of whatever sits in front of this app (OpenHIM channel
// auth, a reverse proxy, etc.) -- required on every call regardless of
// transport, including direct access if this port is ever reached without
// going through OpenHIM at all.
const verifyInboundSecret = requireSharedSecret({
  headerName: 'x-mediator-secret',
  envVar: 'MEDIATOR_INBOUND_SECRET',
  label: 'inbound ServiceRequest'
});

/**
 * Inbound orders, behind the OpenHIM channel. Accepts either:
 * - an order Bundle (the ServiceRequest with its Patient, Practitioner, Encounter and Visit), which is
 *   what lib/orderPoller.js posts for each polled order;
 * - a minimal { serviceRequestId }, in preparation for an OpenMRS module that pushes the ids of new
 *   orders to OpenHIM instead of this mediator polling (likely to be removed if push is implemented
 *   some other way).
 * The relay logic lives in lib/orderRelay.js -- see ORDER_INGESTION_MODE in .env.example.
 */
router.post('/fhir/ServiceRequest', verifyInboundSecret, async (req, res) => {
  try {
    const { created } = await relayServiceRequest(req.body);
    res.status(200).json({ status: 'ok', advapacsServiceRequestId: created.id });
  } catch (err) {
    logger.error('Failed to relay ServiceRequest to AdvaPACS', { error: err.message });
    res.status(502).json({ status: 'error', message: err.message });
  }
});

module.exports = router;

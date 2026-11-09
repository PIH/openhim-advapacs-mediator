const express = require('express');
const modalityMap = require('../lib/modalityMap');

const router = express.Router();

// The container's healthcheck. Unhealthy until the modality map has loaded, since orders are held (not
// relayed) until then (UHM-9616, see lib/modalityMap.js)
router.get('/health', (req, res) => (modalityMap.isLoaded()
  ? res.status(200).json({ status: 'up' })
  : res.status(503).json({ status: 'modality map not loaded' })));

module.exports = router;

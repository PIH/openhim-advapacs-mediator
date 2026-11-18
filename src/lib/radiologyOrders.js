const openmrs = require('./openmrsClient');

// Which polled ServiceRequests are radiology orders (LSO-263). FHIR2 turns every OpenMRS TestOrder into a
// ServiceRequest, lab orders included, and its ServiceRequest carries no order type or category to tell
// them apart (and can't be searched by one). So, as radiologyapp does, an order is a radiology order when
// its order type is the one in radiologyapp's emr.radiologyTestOrderType global property: that property is
// read from OpenMRS's REST API once, and each order's type is looked up there, one REST call per order.
//
// Stopgap until LSO-312: once FHIR2 sends the order type as ServiceRequest.category and can search on it,
// the poller can search for radiology orders only, and this module (the per-order REST lookups) can go.

const RADIOLOGY_ORDER_TYPE_PROPERTY = 'emr.radiologyTestOrderType';

let radiologyOrderTypeUuid = null; // null until read from OpenMRS

/**
 * Reads the radiology order type from OpenMRS, if it hasn't been read yet. Kept for the life of the
 * process: an order type's uuid doesn't change. Rejects if OpenMRS can't be reached or the property
 * isn't set, so the caller holds orders rather than guessing which are radiology.
 */
async function ensureLoaded() {
  if (radiologyOrderTypeUuid) return radiologyOrderTypeUuid;
  const uuid = await openmrs.getGlobalPropertyValue(RADIOLOGY_ORDER_TYPE_PROPERTY);
  if (!uuid) {
    throw new Error(`OpenMRS global property ${RADIOLOGY_ORDER_TYPE_PROPERTY} is not set, so radiology orders can't be told from other test orders`);
  }
  radiologyOrderTypeUuid = uuid;
  return uuid;
}

/**
 * Whether the order behind a ServiceRequest (its id is the order's uuid) is a radiology order. Rejects
 * if the radiology order type or the order's type can't be read from OpenMRS. TODO LSO-312: read the
 * ServiceRequest's category instead, once FHIR2 sends it.
 */
async function isRadiologyOrder(serviceRequestId) {
  const radiologyType = await ensureLoaded();
  const orderType = await openmrs.getOrderTypeUuid(serviceRequestId);
  return orderType === radiologyType;
}

module.exports = { ensureLoaded, isRadiologyOrder, RADIOLOGY_ORDER_TYPE_PROPERTY };

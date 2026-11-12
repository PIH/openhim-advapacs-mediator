const DEFAULT_ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';
const DEFAULT_PLACER_ORDER_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-order-number';

// Read at call time so the setting can change without reloading the module.
function accessionNumberSystem() {
  return process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM || DEFAULT_ACCESSION_NUMBER_SYSTEM;
}

// The system stamped on the order's placer (order number) identifier on outbound ServiceRequests.
function placerOrderNumberSystem() {
  return process.env.ADVAPACS_PLACER_ORDER_NUMBER_SYSTEM || DEFAULT_PLACER_ORDER_NUMBER_SYSTEM;
}

// The value of the resource's identifier issued by `system` (its assigning authority), or undefined.
// The identifier is chosen by its system, never by its type (e.g. ACSN) alone, so a value issued by
// another authority is never used; callers then match that value against OpenMRS (system + value).
function identifierValue(resource, system) {
  const ids = resource && Array.isArray(resource.identifier) ? resource.identifier : [];
  const match = ids.find((id) => id && id.system === system);
  return match ? match.value : undefined;
}

function accessionNumber(resource) {
  return identifierValue(resource, accessionNumberSystem());
}

module.exports = { accessionNumberSystem, placerOrderNumberSystem, identifierValue, accessionNumber };

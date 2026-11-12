// Both systems are site configuration, with no default: a wrong one would quietly stamp orders, or
// match results, under another site's system. Read at call time; unset throws a configuration error.
function requiredSetting(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// The identifier system under which AdvaPACS carries our accession number (orders and results).
function accessionNumberSystem() {
  return requiredSetting('ADVAPACS_ACCESSION_NUMBER_SYSTEM');
}

// The system stamped on the order's placer (order number) identifier on outbound ServiceRequests.
function placerOrderNumberSystem() {
  return requiredSetting('ADVAPACS_PLACER_ORDER_NUMBER_SYSTEM');
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

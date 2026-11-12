const DEFAULT_ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

// Read at call time so the setting can change without reloading the module.
function accessionNumberSystem() {
  return process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM || DEFAULT_ACCESSION_NUMBER_SYSTEM;
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

module.exports = { accessionNumberSystem, identifierValue, accessionNumber };

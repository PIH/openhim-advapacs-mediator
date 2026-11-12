const DEFAULT_ACCESSION_NUMBER_SYSTEM = 'http://www.pih.org/identifiers/lesotho/radiology-accession-number';

// Read at call time so the setting can change without reloading the module.
function accessionNumberSystem() {
  return process.env.ADVAPACS_ACCESSION_NUMBER_SYSTEM || DEFAULT_ACCESSION_NUMBER_SYSTEM;
}

// Match by system only, never by value or type alone.
function identifierValue(resource, system) {
  const match = ((resource && resource.identifier) || []).find((id) => id.system === system);
  return match ? match.value : undefined;
}

function accessionNumber(resource) {
  return identifierValue(resource, accessionNumberSystem());
}

module.exports = { accessionNumberSystem, identifierValue, accessionNumber };

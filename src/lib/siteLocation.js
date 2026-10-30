const openmrs = require('./openmrsClient');
const advapacs = require('./advapacsClient');

// An AdvaPACS Site corresponds to an OpenMRS Visit Location (the facility), identified by this
// location tag, which OpenMRS FHIR2 sends in Location.meta.tag
const VISIT_LOCATION_TAG_SYSTEM = 'http://fhir.openmrs.org/ext/location-tag';
const VISIT_LOCATION_TAG_CODE = 'Visit Location';

// Guards the walk up Location.partOf against a cycle in the OpenMRS location hierarchy
const MAX_LOCATION_DEPTH = 10;

/**
 * Parses ADVAPACS_SITE_MAP, "<visit-location-uuid>=<site-code>,...", into a Map. Returns null when
 * unset or empty (the feature is off). The Site codes are the identifiers set on each Site in
 * AdvaPACS admin, and differ between AdvaPACS setups (e.g. LS-DM-BOTS on demo, LS-BOTS on
 * production), so they're per-deployment config rather than anything this code knows.
 */
function parseSiteMap(raw) {
  if (!raw || !raw.trim()) return null;

  const siteMap = new Map();
  raw.split(',').map((entry) => entry.trim()).filter(Boolean).forEach((entry) => {
    const parts = entry.split('=').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`ADVAPACS_SITE_MAP is malformed: expected <visit-location-uuid>=<site-code>, got "${entry}"`);
    }
    if (siteMap.has(parts[0])) {
      throw new Error(`ADVAPACS_SITE_MAP is malformed: ${parts[0]} is mapped more than once`);
    }
    siteMap.set(parts[0], parts[1]);
  });
  return siteMap;
}

// Read at load, so a bad config stops the mediator at startup rather than failing every order
const SITE_MAP = parseSiteMap(process.env.ADVAPACS_SITE_MAP);
const ORGANIZATION = process.env.ADVAPACS_ORGANIZATION || undefined;
if (ORGANIZATION && !SITE_MAP) {
  throw new Error('ADVAPACS_ORGANIZATION is set but ADVAPACS_SITE_MAP is not');
}

// AdvaPACS ids, cached for the life of the process -- only once resolved, so a fix made in
// AdvaPACS admin is picked up by the next order without a restart
let organizationId;
const siteIds = new Map();

/**
 * Works out the AdvaPACS Site for the order: the OpenMRS Visit Location it was placed under
 * (found through its encounter, as FHIR2 doesn't set ServiceRequest.locationReference), mapped
 * to a Site code by ADVAPACS_SITE_MAP, and resolved to the Site's AdvaPACS Location id. Returns
 * the outbound locationReference, or undefined when ADVAPACS_SITE_MAP isn't set.
 *
 * There's deliberately no fallback Site: if the Site can't be determined, for whatever reason
 * (missing data, an unmapped Visit Location, an OpenMRS or AdvaPACS error), this throws, so the
 * order is held as a failed OpenHIM transaction that can be re-run once fixed, rather than being
 * filed under the wrong facility.
 */
async function resolveSiteLocationReference(serviceRequest) {
  if (!SITE_MAP) return undefined;

  const visitLocation = await findVisitLocation(serviceRequest);

  const siteCode = SITE_MAP.get(visitLocation.id);
  if (!siteCode) {
    throw new Error(`Visit Location ${visitLocation.id} (${visitLocation.name}) of ServiceRequest ${serviceRequest.id} ` +
      'is not in ADVAPACS_SITE_MAP');
  }

  return [{ reference: `Location/${await resolveSiteId(siteCode)}` }];
}

async function findVisitLocation(serviceRequest) {
  const encounterId = idOf(serviceRequest.encounter);
  if (!encounterId) {
    throw new Error(`ServiceRequest ${serviceRequest.id} has no encounter to find its Visit Location from`);
  }

  const encounter = await openmrs.getResource('Encounter', encounterId);
  let locationId = idOf(encounter.location && encounter.location[0] && encounter.location[0].location);
  if (!locationId) {
    throw new Error(`Encounter ${encounterId} of ServiceRequest ${serviceRequest.id} has no location`);
  }

  for (let depth = 0; depth < MAX_LOCATION_DEPTH && locationId; depth++) {
    const location = await openmrs.getResource('Location', locationId);
    if (isVisitLocation(location)) return location;
    locationId = idOf(location.partOf);
  }
  throw new Error(`No Visit Location found above the location of Encounter ${encounterId} ` +
    `(ServiceRequest ${serviceRequest.id})`);
}

function isVisitLocation(location) {
  return ((location.meta && location.meta.tag) || []).some(
    (tag) => tag.system === VISIT_LOCATION_TAG_SYSTEM && tag.code === VISIT_LOCATION_TAG_CODE
  );
}

async function resolveSiteId(siteCode) {
  if (siteIds.has(siteCode)) return siteIds.get(siteCode);

  const orgId = ORGANIZATION ? await resolveOrganizationId() : undefined;
  // Checked against managingOrganization as well, in case AdvaPACS ignores the organization
  // search parameter: a Site from another Organisation (e.g. production's, on a demo mediator)
  // must never match
  const sites = (await advapacs.searchLocations(siteCode, orgId)).filter(
    (site) => !orgId || (site.managingOrganization && site.managingOrganization.reference) === `Organization/${orgId}`
  );
  if (sites.length === 0) {
    throw new Error(`AdvaPACS Site ${siteCode} not found` + (ORGANIZATION ? ` in Organisation ${ORGANIZATION}` : ''));
  }
  if (sites.length > 1) {
    throw new Error(`AdvaPACS Site identifier ${siteCode} matches more than one Site`);
  }

  siteIds.set(siteCode, sites[0].id);
  return sites[0].id;
}

async function resolveOrganizationId() {
  if (organizationId) return organizationId;

  const organizations = await advapacs.searchOrganizations(ORGANIZATION);
  if (organizations.length !== 1) {
    throw new Error(`ADVAPACS_ORGANIZATION ${ORGANIZATION} matches ${organizations.length} AdvaPACS Organisations, expected 1`);
  }
  organizationId = organizations[0].id;
  return organizationId;
}

// The id from a FHIR reference ("Location/abc" -> "abc")
function idOf(reference) {
  return reference && reference.reference ? reference.reference.split('/').pop() : undefined;
}

module.exports = { parseSiteMap, resolveSiteLocationReference };

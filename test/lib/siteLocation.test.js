jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');
jest.mock('../../src/lib/advapacsClient');

describe('siteLocation', () => {
  let openmrs;
  let advapacs;
  let siteLocation;

  const visitLocationTag = {
    system: 'http://fhir.openmrs.org/ext/location-tag',
    code: 'Visit Location'
  };

  const serviceRequest = {
    resourceType: 'ServiceRequest',
    id: 'sr1',
    encounter: { reference: 'Encounter/enc1', type: 'Encounter' }
  };

  const encounter = {
    resourceType: 'Encounter',
    id: 'enc1',
    location: [{ location: { reference: 'Location/ward1', display: 'Motebang HDU' } }]
  };

  const ward = {
    resourceType: 'Location',
    id: 'ward1',
    name: 'Motebang HDU',
    meta: { tag: [{ system: 'http://fhir.openmrs.org/ext/location-tag', code: 'Login Location' }] },
    partOf: { reference: 'Location/vl-mote', display: 'Motebang' }
  };

  const motebang = {
    resourceType: 'Location',
    id: 'vl-mote',
    name: 'Motebang',
    meta: { tag: [visitLocationTag] }
  };

  const organization = { resourceType: 'Organization', id: 'org1' };

  const moteSite = {
    resourceType: 'Location',
    id: 'site-mote',
    managingOrganization: { reference: 'Organization/org1' }
  };

  // Answers openmrs.getResource from a list of resources, keyed by type/id
  function openmrsServes(...resources) {
    openmrs.getResource.mockImplementation(async (resourceType, id) => {
      const resource = resources.find((r) => r.resourceType === resourceType && r.id === id);
      if (!resource) throw new Error(`Request failed with status code 404 (${resourceType}/${id})`);
      return resource;
    });
  }

  function requireWith({ siteMap, organization: organizationCode }) {
    jest.resetModules();
    if (siteMap === undefined) delete process.env.ADVAPACS_SITE_MAP;
    else process.env.ADVAPACS_SITE_MAP = siteMap;
    if (organizationCode === undefined) delete process.env.ADVAPACS_ORGANIZATION;
    else process.env.ADVAPACS_ORGANIZATION = organizationCode;

    openmrs = require('../../src/lib/openmrsClient');
    advapacs = require('../../src/lib/advapacsClient');
    siteLocation = require('../../src/lib/siteLocation');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    requireWith({ siteMap: 'vl-bots=LS-DM-BOTS,vl-mote=LS-DM-MOTE', organization: 'LS-DM' });
    openmrsServes(encounter, ward, motebang);
    advapacs.searchOrganizations.mockResolvedValue([organization]);
    advapacs.searchLocations.mockResolvedValue([moteSite]);
  });

  afterAll(() => {
    delete process.env.ADVAPACS_SITE_MAP;
    delete process.env.ADVAPACS_ORGANIZATION;
  });

  describe('parseSiteMap', () => {
    test('returns null when ADVAPACS_SITE_MAP is unset or empty (puppet renders an empty map as \'\')', () => {
      expect(siteLocation.parseSiteMap(undefined)).toBeNull();
      expect(siteLocation.parseSiteMap('')).toBeNull();
      expect(siteLocation.parseSiteMap('  ')).toBeNull();
    });

    test('maps each Visit Location uuid to its Site code, trimming whitespace and skipping empty entries', () => {
      expect(siteLocation.parseSiteMap(' a=B , c=D,')).toEqual(new Map([['a', 'B'], ['c', 'D']]));
    });

    test.each(['a', 'a=B=C', '=B', 'a=', 'a=B,a=C'])('throws on the malformed map %p', (raw) => {
      expect(() => siteLocation.parseSiteMap(raw)).toThrow(/ADVAPACS_SITE_MAP is malformed/);
    });
  });

  describe('configuration at load', () => {
    test('fails to load when ADVAPACS_SITE_MAP is malformed', () => {
      expect(() => requireWith({ siteMap: 'vl-mote' })).toThrow(/ADVAPACS_SITE_MAP is malformed/);
    });

    test('fails to load when ADVAPACS_ORGANIZATION is set without ADVAPACS_SITE_MAP', () => {
      expect(() => requireWith({ organization: 'LS-DM' }))
        .toThrow(/ADVAPACS_ORGANIZATION is set but ADVAPACS_SITE_MAP is not/);
    });

    test('resolves no location, and looks nothing up, when ADVAPACS_SITE_MAP is not set', async () => {
      requireWith({});

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).resolves.toBeUndefined();
      expect(openmrs.getResource).not.toHaveBeenCalled();
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });
  });

  describe('finding the Visit Location in OpenMRS', () => {
    test('walks from the encounter location up to the Visit Location, and resolves its mapped Site', async () => {
      const result = await siteLocation.resolveSiteLocationReference(serviceRequest);

      expect(result).toEqual([{ reference: 'Location/site-mote' }]);
      expect(openmrs.getResource).toHaveBeenCalledWith('Encounter', 'enc1');
      expect(openmrs.getResource).toHaveBeenCalledWith('Location', 'ward1');
      expect(openmrs.getResource).toHaveBeenCalledWith('Location', 'vl-mote');
      expect(advapacs.searchOrganizations).toHaveBeenCalledWith('LS-DM');
      expect(advapacs.searchLocations).toHaveBeenCalledWith('LS-DM-MOTE', 'org1');
    });

    test('uses the encounter location itself when it is the Visit Location', async () => {
      openmrsServes({ ...encounter, location: [{ location: { reference: 'Location/vl-mote' } }] }, motebang);

      const result = await siteLocation.resolveSiteLocationReference(serviceRequest);

      expect(result).toEqual([{ reference: 'Location/site-mote' }]);
      expect(openmrs.getResource).toHaveBeenCalledTimes(2);
    });

    test('throws when the ServiceRequest has no encounter', async () => {
      const { encounter: _, ...withoutEncounter } = serviceRequest;

      await expect(siteLocation.resolveSiteLocationReference(withoutEncounter)).rejects.toThrow(/encounter/i);
    });

    test('throws when the encounter has no location', async () => {
      openmrsServes({ ...encounter, location: undefined });

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/enc1/);
    });

    test('throws when no location up the chain is a Visit Location', async () => {
      openmrsServes(encounter, { ...ward, partOf: undefined });

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/Visit Location/);
    });

    test('throws, rather than walking forever, when the parent chain is too deep (e.g. a cycle)', async () => {
      openmrs.getResource.mockImplementation(async (resourceType, id) => (resourceType === 'Encounter'
        ? encounter
        : { resourceType: 'Location', id, partOf: { reference: `Location/${id}-parent` } }));

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/Visit Location/);
      expect(openmrs.getResource.mock.calls.filter(([type]) => type === 'Location')).toHaveLength(10);
    });

    test('lets an OpenMRS read failure propagate, without looking up the Site', async () => {
      openmrs.getResource.mockRejectedValue(new Error('Request failed with status code 503'));

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow('Request failed with status code 503');
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });

    test('throws, naming the Visit Location, when it is not in ADVAPACS_SITE_MAP', async () => {
      openmrsServes(encounter, { ...ward, partOf: { reference: 'Location/vl-other' } },
        { resourceType: 'Location', id: 'vl-other', name: 'Ntsekhe', meta: { tag: [visitLocationTag] } });

      const relay = siteLocation.resolveSiteLocationReference(serviceRequest);

      await expect(relay).rejects.toThrow(/vl-other/);
      await expect(relay).rejects.toThrow(/not in ADVAPACS_SITE_MAP/);
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });
  });

  describe('resolving the Site in AdvaPACS', () => {
    test('looks the Site up by identifier alone, unfiltered, when ADVAPACS_ORGANIZATION is not set', async () => {
      requireWith({ siteMap: 'vl-mote=LS-DM-MOTE' });
      openmrsServes(encounter, ward, motebang);
      advapacs.searchLocations.mockResolvedValue([{ resourceType: 'Location', id: 'site-mote' }]);

      const result = await siteLocation.resolveSiteLocationReference(serviceRequest);

      expect(result).toEqual([{ reference: 'Location/site-mote' }]);
      expect(advapacs.searchOrganizations).not.toHaveBeenCalled();
      expect(advapacs.searchLocations).toHaveBeenCalledWith('LS-DM-MOTE', undefined);
    });

    test('throws when ADVAPACS_ORGANIZATION does not match an AdvaPACS Organisation', async () => {
      advapacs.searchOrganizations.mockResolvedValue([]);

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/LS-DM/);
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });

    test('throws when the Site code matches no AdvaPACS Site', async () => {
      advapacs.searchLocations.mockResolvedValue([]);

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/LS-DM-MOTE.*not found/);
    });

    test('ignores a Site from another Organisation, in case AdvaPACS ignores the organization search parameter', async () => {
      advapacs.searchLocations.mockResolvedValue([
        { ...moteSite, managingOrganization: { reference: 'Organization/other-org' } }
      ]);

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/not found/);
    });

    test('throws when the Site code matches more than one AdvaPACS Site', async () => {
      advapacs.searchLocations.mockResolvedValue([moteSite, { ...moteSite, id: 'site-mote-2' }]);

      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/more than one/);
    });

    test('remembers a resolved Site, so the next order for it makes no AdvaPACS lookups', async () => {
      await siteLocation.resolveSiteLocationReference(serviceRequest);
      const result = await siteLocation.resolveSiteLocationReference(serviceRequest);

      expect(result).toEqual([{ reference: 'Location/site-mote' }]);
      expect(advapacs.searchOrganizations).toHaveBeenCalledTimes(1);
      expect(advapacs.searchLocations).toHaveBeenCalledTimes(1);
    });

    test('does not remember a failed lookup, so the next order picks up a fix in AdvaPACS', async () => {
      advapacs.searchLocations.mockResolvedValueOnce([]);
      await expect(siteLocation.resolveSiteLocationReference(serviceRequest)).rejects.toThrow(/not found/);

      const result = await siteLocation.resolveSiteLocationReference(serviceRequest);

      expect(result).toEqual([{ reference: 'Location/site-mote' }]);
    });
  });
});

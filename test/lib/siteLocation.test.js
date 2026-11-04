jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/advapacsClient');

const { readOrder } = require('../../src/lib/orderBundle');

describe('siteLocation', () => {
  let advapacs;
  let siteLocation;

  const serviceRequest = {
    resourceType: 'ServiceRequest',
    id: 'sr1',
    encounter: { reference: 'Encounter/enc1', type: 'Encounter' }
  };

  // The order's own encounter, at a ward; its partOf is the Visit
  const encounter = {
    resourceType: 'Encounter',
    id: 'enc1',
    location: [{ location: { reference: 'Location/ward1', display: 'Motebang HDU' } }],
    partOf: { reference: 'Encounter/visit1', type: 'Encounter' }
  };

  // FHIR2 represents the Visit as an Encounter; its location is the Visit Location
  const visit = {
    resourceType: 'Encounter',
    id: 'visit1',
    location: [{ location: { reference: 'Location/vl-mote', display: 'Motebang' } }]
  };

  const organization = { resourceType: 'Organization', id: 'org1' };

  const moteSite = {
    resourceType: 'Location',
    id: 'site-mote',
    managingOrganization: { reference: 'Organization/org1' }
  };

  // What's sent for an order at moteSite: the Site, and its Organisation as the performer
  const moteResult = {
    locationReference: [{ reference: 'Location/site-mote' }],
    performer: [{ reference: 'Organization/org1' }]
  };

  // An order read from a Bundle of the given resources
  const orderOf = (...resources) => readOrder({ resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) });
  const order = orderOf(serviceRequest, encounter, visit);

  function requireWith({ siteMap, organization: organizationCode }) {
    jest.resetModules();
    if (siteMap === undefined) delete process.env.ADVAPACS_SITE_MAP;
    else process.env.ADVAPACS_SITE_MAP = siteMap;
    if (organizationCode === undefined) delete process.env.ADVAPACS_ORGANIZATION;
    else process.env.ADVAPACS_ORGANIZATION = organizationCode;

    advapacs = require('../../src/lib/advapacsClient');
    siteLocation = require('../../src/lib/siteLocation');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    requireWith({ siteMap: 'vl-bots=LS-DM-BOTS,vl-mote=LS-DM-MOTE', organization: 'LS-DM' });
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

    test('resolves no Site, without looking at the order, when ADVAPACS_SITE_MAP is not set', async () => {
      requireWith({});

      // an order with no encounter at all would otherwise throw
      await expect(siteLocation.resolveSite(orderOf({ resourceType: 'ServiceRequest', id: 'sr1' })))
        .resolves.toBeUndefined();
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });
  });

  describe('finding the Visit Location from the order Bundle', () => {
    test('resolves the Site mapped to the Visit\'s location', async () => {
      const result = await siteLocation.resolveSite(order);

      expect(result).toEqual(moteResult);
      expect(advapacs.searchOrganizations).toHaveBeenCalledWith('LS-DM');
      expect(advapacs.searchLocations).toHaveBeenCalledWith('LS-DM-MOTE', 'org1');
    });

    test('throws when the ServiceRequest has no encounter', async () => {
      const { encounter: _, ...withoutEncounter } = serviceRequest;

      const relay = siteLocation.resolveSite(orderOf(withoutEncounter, encounter, visit));

      await expect(relay).rejects.toThrow(/has no encounter/);
      await expect(relay).rejects.toThrow(/sr1/);
    });

    test('throws when the encounter is not in the Bundle', async () => {
      await expect(siteLocation.resolveSite(orderOf(serviceRequest, visit))).rejects.toThrow(/enc1/);
    });

    test('throws when the encounter has no Visit', async () => {
      const { partOf: _, ...withoutVisit } = encounter;

      const relay = siteLocation.resolveSite(orderOf(serviceRequest, withoutVisit));

      await expect(relay).rejects.toThrow(/no Visit/);
      await expect(relay).rejects.toThrow(/enc1/);
    });

    test('throws when the Visit is not in the Bundle', async () => {
      await expect(siteLocation.resolveSite(orderOf(serviceRequest, encounter))).rejects.toThrow(/visit1/);
    });

    test('throws when the Visit has no location', async () => {
      const { location: _, ...withoutLocation } = visit;

      await expect(siteLocation.resolveSite(orderOf(serviceRequest, encounter, withoutLocation)))
        .rejects.toThrow(/visit1/);
    });

    test('throws, naming the Visit Location, when it is not in ADVAPACS_SITE_MAP', async () => {
      const elsewhere = { ...visit, location: [{ location: { reference: 'Location/vl-other', display: 'Ntsekhe' } }] };

      const relay = siteLocation.resolveSite(orderOf(serviceRequest, encounter, elsewhere));

      await expect(relay).rejects.toThrow(/vl-other/);
      await expect(relay).rejects.toThrow(/not in ADVAPACS_SITE_MAP/);
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });
  });

  describe('resolving the Site in AdvaPACS', () => {
    test('looks the Site up by identifier alone, unfiltered, when ADVAPACS_ORGANIZATION is not set', async () => {
      requireWith({ siteMap: 'vl-mote=LS-DM-MOTE' });
      advapacs.searchLocations.mockResolvedValue([moteSite]);

      const result = await siteLocation.resolveSite(order);

      expect(result).toEqual(moteResult);
      expect(advapacs.searchOrganizations).not.toHaveBeenCalled();
      expect(advapacs.searchLocations).toHaveBeenCalledWith('LS-DM-MOTE', undefined);
    });

    test('throws when ADVAPACS_ORGANIZATION does not match an AdvaPACS Organisation', async () => {
      advapacs.searchOrganizations.mockResolvedValue([]);

      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/LS-DM/);
      expect(advapacs.searchLocations).not.toHaveBeenCalled();
    });

    test('throws when the Site code matches no AdvaPACS Site', async () => {
      advapacs.searchLocations.mockResolvedValue([]);

      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/LS-DM-MOTE.*not found/);
    });

    test('ignores a Site from another Organisation, in case AdvaPACS ignores the organization search parameter', async () => {
      advapacs.searchLocations.mockResolvedValue([
        { ...moteSite, managingOrganization: { reference: 'Organization/other-org' } }
      ]);

      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/not found/);
    });

    test('matches the Site\'s Organisation by id, also when managingOrganization is an absolute reference', async () => {
      advapacs.searchLocations.mockResolvedValue([
        { ...moteSite, managingOrganization: { reference: 'https://advapacs.example.com/fhir/R5/Organization/org1' } }
      ]);

      const result = await siteLocation.resolveSite(order);

      expect(result).toEqual(moteResult);
    });

    test('throws when the Site has no Organisation, as the order would have no performer', async () => {
      requireWith({ siteMap: 'vl-mote=LS-DM-MOTE' });
      advapacs.searchLocations.mockResolvedValue([{ resourceType: 'Location', id: 'site-mote' }]);

      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/LS-DM-MOTE.*no Organisation/);
    });

    test('throws when the Site code matches more than one AdvaPACS Site', async () => {
      advapacs.searchLocations.mockResolvedValue([moteSite, { ...moteSite, id: 'site-mote-2' }]);

      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/more than one/);
    });

    test('remembers a resolved Site, so the next order for it makes no AdvaPACS lookups', async () => {
      await siteLocation.resolveSite(order);
      const result = await siteLocation.resolveSite(order);

      expect(result).toEqual(moteResult);
      expect(advapacs.searchOrganizations).toHaveBeenCalledTimes(1);
      expect(advapacs.searchLocations).toHaveBeenCalledTimes(1);
    });

    test('does not remember a failed lookup, so the next order picks up a fix in AdvaPACS', async () => {
      advapacs.searchLocations.mockResolvedValueOnce([]);
      await expect(siteLocation.resolveSite(order)).rejects.toThrow(/not found/);

      const result = await siteLocation.resolveSite(order);

      expect(result).toEqual(moteResult);
    });
  });
});

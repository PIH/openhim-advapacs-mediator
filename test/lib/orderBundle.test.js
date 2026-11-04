const { splitOrders, readOrder } = require('../../src/lib/orderBundle');

describe('orderBundle', () => {
  const ref = (type, id) => ({ reference: `${type}/${id}` });

  const order = (id, { patient, practitioner, encounter } = {}) => ({
    resourceType: 'ServiceRequest',
    id,
    ...(patient && { subject: ref('Patient', patient) }),
    ...(practitioner && { requester: ref('Practitioner', practitioner) }),
    ...(encounter && { encounter: ref('Encounter', encounter) })
  });
  const patient = (id) => ({ resourceType: 'Patient', id });
  const practitioner = (id) => ({ resourceType: 'Practitioner', id });
  const encounter = (id, visit) => ({ resourceType: 'Encounter', id, ...(visit && { partOf: ref('Encounter', visit) }) });
  const visit = (id) => ({ resourceType: 'Encounter', id, location: [{ location: ref('Location', `vl-${id}`) }] });

  const searchBundle = (...resources) => ({
    resourceType: 'Bundle',
    type: 'searchset',
    entry: resources.map((resource) => ({ resource }))
  });
  const idsIn = (bundle) => bundle.entry.map(({ resource }) => `${resource.resourceType}/${resource.id}`);

  describe('splitOrders', () => {
    test('gives each order its own Bundle with only the resources it references', () => {
      const result = splitOrders(searchBundle(
        order('sr1', { patient: 'p1', practitioner: 'pr1', encounter: 'e1' }),
        order('sr2', { patient: 'p2', practitioner: 'pr2', encounter: 'e2' }),
        patient('p1'), patient('p2'), practitioner('pr1'), practitioner('pr2'),
        encounter('e1', 'v1'), encounter('e2', 'v2'), visit('v1'), visit('v2')
      ));

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
      expect(idsIn(result[0])).toEqual(['ServiceRequest/sr1', 'Patient/p1', 'Practitioner/pr1', 'Encounter/e1', 'Encounter/v1']);
      expect(idsIn(result[1])).toEqual(['ServiceRequest/sr2', 'Patient/p2', 'Practitioner/pr2', 'Encounter/e2', 'Encounter/v2']);
    });

    test('shares an included resource between orders that reference it', () => {
      const result = splitOrders(searchBundle(
        order('sr1', { patient: 'p1' }), order('sr2', { patient: 'p1' }), patient('p1')
      ));

      expect(idsIn(result[0])).toEqual(['ServiceRequest/sr1', 'Patient/p1']);
      expect(idsIn(result[1])).toEqual(['ServiceRequest/sr2', 'Patient/p1']);
    });

    test('includes a shared resource only once per order when it appears on more than one page', () => {
      // a later page repeats the Patient it shares with an earlier page's order
      const result = splitOrders(searchBundle(
        order('sr1', { patient: 'p1' }), patient('p1'), order('sr2', { patient: 'p1' }), patient('p1')
      ));

      expect(idsIn(result[0])).toEqual(['ServiceRequest/sr1', 'Patient/p1']);
      expect(idsIn(result[1])).toEqual(['ServiceRequest/sr2', 'Patient/p1']);
    });

    test('leaves out what isn\'t there', () => {
      const result = splitOrders(searchBundle(
        order('sr1', { patient: 'p1', practitioner: 'pr-not-included', encounter: 'e1' }),
        patient('p1'), encounter('e1')
      ));

      expect(idsIn(result[0])).toEqual(['ServiceRequest/sr1', 'Patient/p1', 'Encounter/e1']);
    });

    test('gives an order that appears on two pages only one Bundle', () => {
      // FHIR2 may re-run the search for each page, so an order updated mid-poll can shift onto the next page
      const result = splitOrders(searchBundle(
        order('sr1', { patient: 'p1' }), patient('p1'), order('sr1', { patient: 'p1' }), patient('p1')
      ));

      expect(result).toHaveLength(1);
      expect(idsIn(result[0])).toEqual(['ServiceRequest/sr1', 'Patient/p1']);
    });

    test('returns [] for a Bundle with no entry', () => {
      expect(splitOrders({ resourceType: 'Bundle', type: 'searchset' })).toEqual([]);
    });
  });

  describe('readOrder', () => {
    test('finds referenced resources, and returns undefined for unknown or missing references', () => {
      const result = readOrder(splitOrders(searchBundle(
        order('sr1', { patient: 'p1', encounter: 'e1' }), patient('p1'), encounter('e1', 'v1'), visit('v1')
      ))[0]);

      expect(result.serviceRequest.id).toBe('sr1');
      expect(result.find(ref('Patient', 'p1'))).toEqual(patient('p1'));
      expect(result.find(ref('Encounter', 'v1'))).toEqual(visit('v1'));
      expect(result.find({ reference: 'http://openmrs/ws/fhir2/R4/Encounter/e1' })).toEqual(encounter('e1', 'v1'));
      expect(result.find(ref('Patient', 'unknown'))).toBeUndefined();
      expect(result.find(undefined)).toBeUndefined();
      expect(result.find({})).toBeUndefined();
    });

    test('rejects a Bundle without exactly one ServiceRequest', () => {
      expect(() => readOrder(searchBundle(patient('p1'))))
        .toThrow('Order Bundle must contain exactly one ServiceRequest, found 0');
      expect(() => readOrder(searchBundle(order('sr1'), order('sr2'))))
        .toThrow('Order Bundle must contain exactly one ServiceRequest, found 2');
      expect(() => readOrder({ resourceType: 'Bundle' }))
        .toThrow('Order Bundle must contain exactly one ServiceRequest, found 0');
    });
  });
});

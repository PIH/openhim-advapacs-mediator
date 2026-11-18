jest.mock('../../src/lib/openmrsClient');

describe('radiologyOrders', () => {
  let openmrs;
  let radiologyOrders;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    openmrs = require('../../src/lib/openmrsClient');
    radiologyOrders = require('../../src/lib/radiologyOrders');
  });

  test('an order whose type is radiologyapp\'s radiology order type is a radiology order', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValue('rad-type');
    openmrs.getOrderTypeUuid.mockResolvedValue('rad-type');

    await expect(radiologyOrders.isRadiologyOrder('sr1')).resolves.toBe(true);
    expect(openmrs.getGlobalPropertyValue).toHaveBeenCalledWith('emr.radiologyTestOrderType');
    expect(openmrs.getOrderTypeUuid).toHaveBeenCalledWith('sr1');
  });

  test('an order of another type (e.g. a lab order) is not', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValue('rad-type');
    openmrs.getOrderTypeUuid.mockResolvedValue('lab-type');

    await expect(radiologyOrders.isRadiologyOrder('sr1')).resolves.toBe(false);
  });

  test('an order with no order type is not', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValue('rad-type');
    openmrs.getOrderTypeUuid.mockResolvedValue(undefined);

    await expect(radiologyOrders.isRadiologyOrder('sr1')).resolves.toBe(false);
  });

  test('reads the global property once, not per order', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValue('rad-type');
    openmrs.getOrderTypeUuid.mockResolvedValue('rad-type');

    await radiologyOrders.isRadiologyOrder('sr1');
    await radiologyOrders.isRadiologyOrder('sr2');

    expect(openmrs.getGlobalPropertyValue).toHaveBeenCalledTimes(1);
  });

  test('rejects, and reads it again next time, when the global property isn\'t set', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValueOnce(undefined).mockResolvedValueOnce('rad-type');
    openmrs.getOrderTypeUuid.mockResolvedValue('rad-type');

    await expect(radiologyOrders.isRadiologyOrder('sr1')).rejects.toThrow(/emr.radiologyTestOrderType is not set/);
    expect(openmrs.getOrderTypeUuid).not.toHaveBeenCalled();

    await expect(radiologyOrders.isRadiologyOrder('sr1')).resolves.toBe(true);
  });

  test('rejects when the global property can\'t be read', async () => {
    openmrs.getGlobalPropertyValue.mockRejectedValue(new Error('OpenMRS unreachable'));

    await expect(radiologyOrders.isRadiologyOrder('sr1')).rejects.toThrow('OpenMRS unreachable');
  });

  test('rejects when the order\'s type can\'t be read', async () => {
    openmrs.getGlobalPropertyValue.mockResolvedValue('rad-type');
    openmrs.getOrderTypeUuid.mockRejectedValue(new Error('Request failed with status code 500'));

    await expect(radiologyOrders.isRadiologyOrder('sr1')).rejects.toThrow('500');
  });
});

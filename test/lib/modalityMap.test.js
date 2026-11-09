jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/lib/openmrsClient');

describe('modalityMap', () => {
  const DCM_UUID = 'd86e6613-c8ce-45b1-b8c3-33714f73755b';
  let openmrs;
  let modalityMap;

  const mapping = (code, source = 'DCM', sourceUuid = DCM_UUID) => ({
    conceptReferenceTerm: { code, conceptSource: { uuid: sourceUuid, name: source } }
  });
  const concept = (uuid, ...mappings) => ({ uuid, mappings });

  const load = (env = {}) => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.MODALITY_SOURCE;
    delete process.env.MODALITY_MAP_REFRESH_MS;
    delete process.env.MODALITY_MAP_RETRY_MS;
    Object.assign(process.env, env);
    openmrs = require('../../src/lib/openmrsClient');
    modalityMap = require('../../src/lib/modalityMap');
  };

  beforeEach(() => load());

  afterEach(() => {
    modalityMap.stop();
    jest.useRealTimers();
  });

  describe('chooseModality', () => {
    test('sends DX and RF as CR', () => {
      expect(modalityMap.chooseModality(['CR', 'DX'])).toBe('CR');
      expect(modalityMap.chooseModality(['DX', 'CR', 'RF'])).toBe('CR');
      expect(modalityMap.chooseModality(['RF'])).toBe('CR');
      expect(modalityMap.chooseModality(['DX'])).toBe('CR');
      expect(modalityMap.chooseModality(['CT'])).toBe('CT');
      expect(modalityMap.chooseModality(['US'])).toBe('US');
      expect(modalityMap.chooseModality([])).toBeUndefined();
    });

    test('picks the alphabetically first of several remaining codes', () => {
      expect(modalityMap.chooseModality(['US', 'CT'])).toBe('CT');
    });
  });

  describe('load', () => {
    test('only uses mappings to the configured source, matched by name', async () => {
      openmrs.getConceptsMappedToSource.mockResolvedValue([
        concept('a', mapping('36554-4', 'LOINC', 'loinc-uuid'), mapping('DX'))
      ]);

      await modalityMap.load();

      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledWith('DCM');
      expect(modalityMap.modalityFor('a')).toBe('CR');
    });

    test('only uses mappings to the configured source, matched by uuid', async () => {
      load({ MODALITY_SOURCE: DCM_UUID });
      openmrs.getConceptsMappedToSource.mockResolvedValue([
        concept('a', mapping('US', 'LOINC', 'loinc-uuid'), mapping('CT'))
      ]);

      await modalityMap.load();

      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledWith(DCM_UUID);
      expect(modalityMap.modalityFor('a')).toBe('CT');
    });

    test('matches the source name case-insensitively, as OpenMRS does', async () => {
      load({ MODALITY_SOURCE: 'dcm' });
      openmrs.getConceptsMappedToSource.mockResolvedValue([concept('a', mapping('US'))]);

      await modalityMap.load();

      expect(modalityMap.modalityFor('a')).toBe('US');
    });

    test('merges a concept returned more than once and dedupes its codes', async () => {
      const a = concept('a', mapping('CR'), mapping('DX'));
      openmrs.getConceptsMappedToSource.mockResolvedValue([a, a]);

      await expect(modalityMap.load()).resolves.toBe(1);
      expect(modalityMap.modalityFor('a')).toBe('CR');
    });

    test('an empty load fails, leaving the map unloaded (e.g. a wrong MODALITY_SOURCE)', async () => {
      openmrs.getConceptsMappedToSource.mockResolvedValue([]);

      await expect(modalityMap.load()).rejects.toThrow(/no concepts/);

      expect(modalityMap.isLoaded()).toBe(false);
    });

    test('an empty refresh keeps the previous table', async () => {
      openmrs.getConceptsMappedToSource
        .mockResolvedValueOnce([concept('a', mapping('US'))])
        .mockResolvedValueOnce([]);

      await modalityMap.load();
      await expect(modalityMap.load()).rejects.toThrow(/no concepts/);

      expect(modalityMap.modalityFor('a')).toBe('US');
    });

    test('is empty until loaded', () => {
      expect(modalityMap.isLoaded()).toBe(false);
      expect(modalityMap.modalityFor('x')).toBeUndefined();
    });

    test('keeps the previous table when a refresh fails', async () => {
      openmrs.getConceptsMappedToSource
        .mockResolvedValueOnce([concept('a', mapping('US'))])
        .mockRejectedValueOnce(new Error('Request failed with status code 500'));

      await modalityMap.load();
      await expect(modalityMap.load()).rejects.toThrow('500');

      expect(modalityMap.isLoaded()).toBe(true);
      expect(modalityMap.modalityFor('a')).toBe('US');
    });
  });

  describe('start', () => {
    test('retries after a failed load, then switches to the refresh interval', async () => {
      load({ MODALITY_MAP_RETRY_MS: '1000', MODALITY_MAP_REFRESH_MS: '5000' });
      jest.useFakeTimers();
      openmrs.getConceptsMappedToSource
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue([concept('a', mapping('US'))]);

      await modalityMap.start();
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(2);
      expect(modalityMap.modalityFor('a')).toBe('US');

      await jest.advanceTimersByTimeAsync(4999);
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1);
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(3);
    });

    test('logs an error on every failed attempt', async () => {
      const logger = require('../../src/lib/logger');
      jest.useFakeTimers();
      openmrs.getConceptsMappedToSource.mockRejectedValue(new Error('ECONNREFUSED'));

      await modalityMap.start();
      await jest.advanceTimersByTimeAsync(10000);

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('Failed to load modality map', expect.objectContaining({ error: 'ECONNREFUSED' }));
    });

    test('ModalityMapNotLoadedError is retryable', () => {
      const err = new modalityMap.ModalityMapNotLoadedError();
      expect(err).toBeInstanceOf(Error);
      expect(err.retryable).toBe(true);
    });

    test('start never rejects', async () => {
      jest.useFakeTimers();
      openmrs.getConceptsMappedToSource.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(modalityMap.start()).resolves.toBeUndefined();
    });
  });

  describe('configuration', () => {
    test('throws at load for a non-numeric interval', () => {
      expect(() => load({ MODALITY_MAP_REFRESH_MS: 'soon' })).toThrow(/MODALITY_MAP_REFRESH_MS/);
    });

    test('throws at load for an interval too long for a Node timer', () => {
      // Node fires a setTimeout over 2^31-1 ms after 1 ms instead, which would query OpenMRS constantly
      expect(() => load({ MODALITY_MAP_REFRESH_MS: '2147483648' })).toThrow(/MODALITY_MAP_REFRESH_MS/);
      expect(() => load({ MODALITY_MAP_REFRESH_MS: '2147483647' })).not.toThrow();
    });

    test('treats empty env values as the defaults', async () => {
      load({ MODALITY_SOURCE: '', MODALITY_MAP_REFRESH_MS: '', MODALITY_MAP_RETRY_MS: '' });
      jest.useFakeTimers();
      openmrs.getConceptsMappedToSource.mockRejectedValue(new Error('ECONNREFUSED'));

      await modalityMap.start();
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledWith('DCM');

      // Retries every 10 s by default, so orders polled just after OpenMRS comes up aren't sent as CR for long
      await jest.advanceTimersByTimeAsync(9999);
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(openmrs.getConceptsMappedToSource).toHaveBeenCalledTimes(2);
    });
  });
});

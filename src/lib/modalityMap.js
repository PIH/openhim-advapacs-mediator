const logger = require('./logger');
const openmrs = require('./openmrsClient');

// The imaging modality AdvaPACS gets for each order (its "modality" orderDetail parameter) comes from
// this table of OpenMRS concept uuid -> DICOM modality code, built from the concepts' mappings to the
// DICOM (DCM) concept source (UHM-9616). It's loaded from OpenMRS's REST API at startup and refreshed
// periodically, so relaying an order makes no OpenMRS call. The ServiceRequest's own DICOM coding isn't
// used: FHIR2 sends at most one code per source and map type, picked arbitrarily (FM2-710).

/**
 * DICOM modality codes sent to AdvaPACS as another code. Not configurable yet: change it here.
 * - DX -> CR: we use CR rather than DX for X-rays (most X-ray concepts map to both CR and DX).
 * - RF -> CR: fluoroscopy orders (e.g. HSG, IVP, retrograde pyelogram) also go to the CR worklist, as
 *   there's no RF modality yet. Revisit if one is added.
 */
const MODALITY_SUBSTITUTIONS = { DX: 'CR', RF: 'CR' };

function intervalFromEnv(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds, got "${raw}"`);
  }
  return Number(raw);
}

// Read at load, so a bad config stops the mediator at startup rather than at the first refresh.
// The concept source is matched by name or uuid
const SOURCE = (process.env.MODALITY_SOURCE || '').trim() || 'DCM';
const REFRESH_MS = intervalFromEnv('MODALITY_MAP_REFRESH_MS', 60 * 60 * 1000);
const RETRY_MS = intervalFromEnv('MODALITY_MAP_RETRY_MS', 60 * 1000);

let table = null; // concept uuid -> modality code; null until the first load succeeds
let timer = null;
let stopped = false;

/**
 * The modality for a concept's DICOM codes: each substituted per MODALITY_SUBSTITUTIONS, then, if
 * more than one remains, the alphabetically first, so the choice is always the same. Undefined for none.
 */
function chooseModality(codes) {
  const modalities = [...new Set(codes.map((code) => MODALITY_SUBSTITUTIONS[code] || code))].sort();
  return modalities[0];
}

/**
 * Fetches the table from OpenMRS and swaps it in, resolving with the number of concepts in it. Rejects
 * if the fetch fails, leaving the current table as it was.
 */
async function load() {
  const concepts = await openmrs.getConceptsMappedToSource(SOURCE);

  // The search returns a concept once per mapping to the source, so gather each concept's codes first
  const codesByConcept = new Map();
  concepts.forEach((concept) => {
    const codes = codesByConcept.get(concept.uuid) || [];
    (concept.mappings || []).forEach((mapping) => {
      const term = mapping.conceptReferenceTerm;
      const source = term && term.conceptSource;
      if (term && term.code && source && (source.name === SOURCE || source.uuid === SOURCE)) codes.push(term.code);
    });
    codesByConcept.set(concept.uuid, codes);
  });

  const loaded = new Map();
  codesByConcept.forEach((codes, uuid) => {
    const modality = chooseModality(codes);
    if (modality) loaded.set(uuid, modality);
  });

  table = loaded;
  logger.info('Loaded modality map', { concepts: loaded.size, source: SOURCE });
  return loaded.size;
}

// One load, then the next scheduled: the refresh interval after a success, the (shorter) retry interval
// after a failure. A setTimeout chain rather than setInterval, so a slow load never overlaps the next
async function attempt() {
  let delay = REFRESH_MS;
  try {
    await load();
  } catch (err) {
    delay = RETRY_MS;
    logger.warn('Failed to load modality map', { error: err.message, retryInMs: delay });
  }
  if (!stopped) timer = setTimeout(attempt, delay);
}

/**
 * Loads the table and keeps it refreshed. Resolves once the first attempt is over, whether or not it
 * succeeded (an OpenMRS that isn't up yet mustn't stop the mediator starting); never rejects.
 */
function start() {
  stopped = false;
  return attempt();
}

function stop() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
}

/** The modality for a concept, or undefined if it isn't in the table or the table hasn't loaded yet. */
function modalityFor(conceptUuid) {
  return table ? table.get(conceptUuid) : undefined;
}

function isLoaded() {
  return table !== null;
}

module.exports = {
  MODALITY_SUBSTITUTIONS,
  chooseModality,
  load,
  start,
  stop,
  modalityFor,
  isLoaded
};

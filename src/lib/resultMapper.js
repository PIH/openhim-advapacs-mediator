// Pure mappers from AdvaPACS FHIR resources to radiologyapp import requests.
// Input is external, so every accessor tolerates malformed shapes.

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object';

function reportTypeFor(status) {
  if (status === 'final') return 'final';
  if (status === 'amended' || status === 'corrected') return 'correction';
  return null;
}

function studySkipReason(study) {
  if (!isObj(study) || !study.started) return 'no started';
  if (study.numberOfInstances === 0) return 'no instances';
  return null;
}

function imagesAvailable(study) {
  const n = isObj(study) ? study.numberOfInstances : undefined;
  if (typeof n !== 'number') return null;
  return n > 0;
}

function reportText(report) {
  const r = isObj(report) ? report : {};
  const conclusionDropped = typeof r.conclusion === 'string' && r.conclusion.length > 0;
  const forms = arr(r.presentedForm).filter((f) => isObj(f) && typeof f.data === 'string' && f.data);
  const chosen =
    forms.find((f) => typeof f.contentType === 'string' && f.contentType.startsWith('text/plain')) || forms[0];
  if (!chosen) return { skipReason: 'no report text', conclusionDropped };
  return {
    text: Buffer.from(chosen.data, 'base64').toString('utf8'),
    contentType: chosen.contentType,
    conclusionDropped,
  };
}

function referenceId(reference, type) {
  if (!isObj(reference) || typeof reference.reference !== 'string') return null;
  const prefix = `${type}/`;
  if (!reference.reference.startsWith(prefix)) return null;
  const id = reference.reference.slice(prefix.length);
  return id || null;
}

function singlePractitionerId(references) {
  const ids = new Set(arr(references).map((r) => referenceId(r, 'Practitioner')).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

function technicianReferences(study) {
  const out = [];
  arr(isObj(study) ? study.series : null).forEach((s) => {
    arr(isObj(s) ? s.performer : null).forEach((p) => {
      if (isObj(p) && isObj(p.actor)) out.push(p.actor);
    });
  });
  return out;
}

function radiologistReferences(report) {
  const r = isObj(report) ? report : {};
  const interpreters = arr(r.resultsInterpreter);
  return interpreters.length > 0 ? interpreters : arr(r.performer);
}

module.exports = {
  reportTypeFor,
  studySkipReason,
  imagesAvailable,
  reportText,
  singlePractitionerId,
  technicianReferences,
  radiologistReferences,
  referenceId,
};

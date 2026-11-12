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
  // 0-instance studies are skipped earlier (studySkipReason), so there is no false.
  return typeof n === 'number' && n > 0 ? true : null;
}

function reportText(report) {
  const r = isObj(report) ? report : {};
  const conclusionDropped = typeof r.conclusion === 'string' && r.conclusion.length > 0;
  // Only text/* forms are decoded; a PDF or other binary must never be saved as the report.
  const forms = arr(r.presentedForm).filter(
    (f) => isObj(f) && typeof f.data === 'string' && f.data && typeof f.contentType === 'string'
      && f.contentType.toLowerCase().startsWith('text/')
  );
  const chosen = forms.find((f) => f.contentType.toLowerCase().startsWith('text/plain')) || forms[0];
  if (!chosen) return { skipReason: 'no text report', conclusionDropped };
  return {
    text: Buffer.from(chosen.data, 'base64').toString('utf8'),
    contentType: chosen.contentType,
    conclusionDropped,
  };
}

// Accepts a relative or absolute reference; returns the segment right after `Type/`,
// ignoring a trailing /_history/<v> and any query or fragment.
function referenceId(reference, type) {
  if (!isObj(reference) || typeof reference.reference !== 'string') return null;
  const path = reference.reference.split(/[?#]/)[0];
  const parts = path.split('/');
  const i = parts.lastIndexOf(type);
  if (i === -1 || i + 1 >= parts.length) return null;
  const id = parts[i + 1];
  const rest = parts.slice(i + 2);
  // anything other than /_history/<v> stays attached so the caller's id check rejects it
  if (rest.length > 0 && !(rest[0] === '_history' && rest.length <= 2)) return parts.slice(i + 1).join('/');
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

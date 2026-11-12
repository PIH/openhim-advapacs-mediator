// The AdvaPACS webhook event types that get processed; the webhook route acknowledges every other
// type without submitting it, and resultHandler skips any that still arrive.
const SUPPORTED_EVENTS = ['STUDY_CREATED', 'REPORT_CREATED', 'REPORT_UPDATED'];

module.exports = { SUPPORTED_EVENTS };

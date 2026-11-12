// The OpenHIM Client the mediator calls the results channels as (Basic auth). Read at call time.
function resultsClientId() {
  return process.env.OPENHIM_RESULTS_CLIENT_ID || 'advapacs-mediator';
}

module.exports = { resultsClientId };

/**
 * An order Bundle carries a ServiceRequest together with everything the relay needs for it -- its
 * Patient, ordering Practitioner, Encounter and that Encounter's Visit -- so relaying an order makes
 * no further calls to OpenMRS. FHIR2 represents a Visit as an Encounter, referenced from the order's
 * Encounter.partOf (see ORDER_INCLUDES in openmrsClient.js).
 */

/**
 * Splits a ServiceRequest search (with ORDER_INCLUDES) into one order Bundle per ServiceRequest, each
 * holding the ServiceRequest first and then whichever of the resources it references the search
 * returned. A resource referenced by several orders goes in each of their Bundles.
 */
function splitOrders(searchBundle) {
  const resources = resourcesOf(searchBundle);
  const byKey = new Map();
  resources.filter((resource) => resource.resourceType !== 'ServiceRequest').forEach((resource) => {
    if (!byKey.has(keyOf(resource))) byKey.set(keyOf(resource), resource);
  });
  const find = (reference) => byKey.get(referenceKey(reference));

  // Each order once, even if it's on two pages: FHIR2 may re-run the search for each page, so an order
  // updated during the poll can shift onto the next one, and posting it twice would create it twice in AdvaPACS
  const serviceRequests = new Map();
  resources.filter((resource) => resource.resourceType === 'ServiceRequest').forEach((serviceRequest) => {
    if (!serviceRequests.has(serviceRequest.id)) serviceRequests.set(serviceRequest.id, serviceRequest);
  });

  return [...serviceRequests.values()].map((serviceRequest) => {
    const encounter = find(serviceRequest.encounter);
    const referenced = [
      find(serviceRequest.subject),
      find(serviceRequest.requester),
      encounter,
      encounter && find(encounter.partOf)
    ].filter(Boolean);

    return {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [serviceRequest, ...new Set(referenced)].map((resource) => ({ resource }))
    };
  });
}

/**
 * Reads an order Bundle: its ServiceRequest, and find(reference), which returns the Bundle's resource a
 * FHIR Reference points to, or undefined. Throws unless the Bundle holds exactly one ServiceRequest.
 */
function readOrder(bundle) {
  const resources = resourcesOf(bundle);
  const serviceRequests = resources.filter((resource) => resource.resourceType === 'ServiceRequest');
  if (serviceRequests.length !== 1) {
    throw new Error(`Order Bundle must contain exactly one ServiceRequest, found ${serviceRequests.length}`);
  }

  const byKey = new Map(resources.map((resource) => [keyOf(resource), resource]));
  return {
    serviceRequest: serviceRequests[0],
    find: (reference) => byKey.get(referenceKey(reference))
  };
}

function resourcesOf(bundle) {
  return ((bundle && bundle.entry) || []).map((entry) => entry.resource).filter(Boolean);
}

function keyOf(resource) {
  return `${resource.resourceType}/${resource.id}`;
}

// "Type/id" from a FHIR Reference, relative or absolute ("http://.../Encounter/abc" -> "Encounter/abc")
function referenceKey(reference) {
  if (!reference || !reference.reference) return undefined;
  return reference.reference.split('/').slice(-2).join('/');
}

module.exports = { splitOrders, readOrder };

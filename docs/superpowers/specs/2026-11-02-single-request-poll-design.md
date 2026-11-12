# Polling an order in a single OpenMRS request — design

Date: 2026-11-02. Builds on `2026-10-30-advapacs-site-location-design.md` (UHM-9468), whose
behaviour this keeps but whose OpenMRS lookups it replaces.

## Why

For each polled order, the mediator makes several follow-on GETs to OpenMRS:
- the Patient;
- the ordering Practitioner;
- the order's Encounter;
- one or more Locations up `partOf` until the location tagged "Visit Location" (the UHM-9468 Site lookup, `src/lib/siteLocation.js`).

The user wants each poll to be a single OpenMRS request, with nothing fetched afterwards.

This is now possible because of FHIR2 FM2-708 (openmrs/openmrs-module-fhir2#640). It adds `_include:iterate` and an `Encounter:part-of` include on the R4 ServiceRequest search:
- FHIR2 represents an OpenMRS Visit as an `Encounter`;
- an Encounter's `partOf` is its Visit;
- the Visit's `location[0]` is the Visit Location, which is what `ADVAPACS_SITE_MAP` is keyed on.

So one search returns each order together with its Patient, Practitioner, Encounter and Visit.

## Goals

- **One request per poll.** The poller fetches new orders with one OpenMRS request (strictly, one per page of results; see Paging), and the relay makes **no** OpenMRS calls while relaying a polled order.
- **Same results in AdvaPACS as today.** The Patient, Practitioner and ServiceRequest sent, and the Site sent as `locationReference`, all stay the same. Behaviour on errors is unchanged (see Behaviour).
- **A re-run uses the original snapshot.** Re-running a failed order from OpenHIM resends the data as it was when the order was polled; it doesn't re-read OpenMRS. The user wants this.

## Non-goals

- Push mode. The user is not switching to push. The `{ serviceRequestId }` input (below) is kept only in preparation for it.
- The return path: AdvaPACS webhook to OpenMRS, `subscriptionWebhook.js`, `updateServiceRequestStatus`.
- Working against an OpenMRS without FM2-708. This mediator version requires it (the user agreed). Against an older FHIR2, the poll is rejected with a 400 and logged, as any failed poll is today. The mediator PR won't be merged until FM2-708 is.
- Fixing the poller's existing restart gap (it re-anchors to "now", so orders created while it's down are missed). That's unchanged.

## Anti-goals

- Filing an order under the wrong Site. As in UHM-9468, there is no fallback Site.
- Keeping a second code path that still fetches from OpenMRS, e.g. for a bare ServiceRequest input.

## Inputs to the relay

The inbound endpoint (`POST /fhir/ServiceRequest`, behind the OpenHIM channel) accepts exactly two
shapes:

1. **A per-order Bundle.** This is what the poller sends. It contains one `ServiceRequest` plus the resources the poll returned for it: Patient, Practitioner, Encounter and Visit, whichever exist.
2. **`{ serviceRequestId }`.** The relay makes one OpenMRS request, `GET /ServiceRequest?_id=<id>` with the same includes, and carries on with the Bundle that comes back.
   - Code comments must say this input is in preparation for a future OpenMRS module that *pushes* order ids to OpenHIM, in place of the mediator polling.
   - They must also say it should likely be removed if push is implemented some other way.

A bare `ServiceRequest` body (accepted today) is no longer accepted. The relay rejects any other
body with a clear error, and the OpenHIM transaction fails. The same goes for a Bundle with no
ServiceRequest or more than one, including an empty `_id` lookup result (my call).

The include list is defined once and shared by the poller and the `_id` lookup:

```
_include=ServiceRequest:patient
_include=ServiceRequest:requester
_include=ServiceRequest:encounter
_include:iterate=Encounter:part-of
```

## Poller

- **Poll:** `GET /ServiceRequest?_lastUpdated=gt<since>` with the includes above. The cursor works as today.
- **Splitting the results:** split the search Bundle into one Bundle per order, holding the ServiceRequest and the resources it references from the poll:
  - its subject Patient;
  - its requester Practitioner;
  - its encounter;
  - that encounter's `partOf` Visit.

  Resolve references by `ResourceType/id`. The Visit and the order's Encounter are both `Encounter` resources, told apart by id.
- **Hand-off:** POST each per-order Bundle to OpenHIM, through the same channel, auth and headers as today. One failed order doesn't stop the others.
- **Paging (my call):**
  - FHIR2 returns a page of matches per request (10 by default), and today's poller reads only the first page, so a busy interval can silently miss orders.
  - Follow the Bundle's `next` links until there are none. That's one request per page, and each page carries its own included resources.
  - FHIR2 builds `next` links from `fhir2.uriPrefix` or forwarded headers, so they can name a public host. Send their query string to `OPENMRS_BASE_URL` + the FHIR path rather than following them as given.
- **Failures and the cursor (my call):**
  - Fetch **all** pages before posting anything.
  - If any page fails, post nothing and leave the cursor where it was, so the next poll retries the whole window. Advancing would skip the remaining pages' orders. Re-sending orders already posted would duplicate them in AdvaPACS, because `createServiceRequest` is a create, not an upsert.
  - Once all pages are fetched, post each order and advance the cursor to the poll's start time, as today. A failed post for one order is logged, as today, and doesn't block the others.

## Behaviour (relay), resolved from the Bundle only

- **Patient:** the ServiceRequest's `subject`. If it's missing from the Bundle, that's a hard error, as today. The patient identifier checks and stamping are unchanged.
- **Ordering clinician:** the `requester` Practitioner. If it's missing, or upserting it into AdvaPACS fails, the order is sent without a requester, as today.
- **Site (only when `ADVAPACS_SITE_MAP` is set):** ServiceRequest `encounter` → that Encounter's `partOf` (the Visit) → the Visit's `location[0].location` id → `ADVAPACS_SITE_MAP`. The result is resolved to the AdvaPACS Location id as today, including the optional `ADVAPACS_ORGANIZATION` check and caching.
  - Any gap is a hard error, so the order is held in OpenHIM for a re-run: no encounter, the encounter missing from the Bundle, no `partOf`, the Visit missing from the Bundle, no Visit location, or an unmapped location.
  - The error messages should say which step failed and give the ids involved.
- **Removed:**
  - the walk up `Location.partOf`, with its depth guard;
  - the "Visit Location" tag check (my call: trust `visit.location`);
  - the Patient and Practitioner GETs;
  - the `getResource('ServiceRequest', id)` lookup.
- **Unchanged:** everything sent to AdvaPACS (code/modality handling, identifier handling, the existing TODOs). `openmrsClient` functions used only by the removed paths are deleted, unless the return path still uses them (`updateServiceRequestStatus` and `getResource` do).

## Changes by repo

All three repos: rework the existing UHM-9468 branches and PRs. The user said they need major refactoring.

- **Mediator (PIH/openhim-advapacs-mediator#12):**
  - the poller, relay, `siteLocation.js`, `openmrsClient.js`, the route's doc comment, README/`.env.example` text, and jest tests;
  - tests use Bundle fixtures and cover both inputs, paging, and each Site error;
  - check against the user's local OpenMRS at `localhost:8080`, which runs FM2-708.
- **distro-tools (PIH/openmrs-contrib-distro-tools#85):**
  - `main` was restructured (TASKS-652/655); the mediator now lives in `services/openhim-advapacs-mediator/` (`compose.yaml`, `env.defaults`, `README.md`, `service.yaml`).
  - Redo the PR on that layout: pass `ADVAPACS_SITE_MAP` and `ADVAPACS_ORGANIZATION` through, as `ADVAPACS_MEDIATOR_*` in env, following `ADVAPACS_MEDIATOR_PRACTITIONER_IDENTIFIER_SYSTEM`.
  - Document them, and update or add the matching tests.
- **Puppet (PIH/mirebalais-puppet#461):**
  - `master` renamed and reworked the define (`openhim_advapacs_mediator.pp`).
  - Redo the PR there: `site_map` / `organization` params following `practitioner_identifier_system`, plus the README.
  - kol-ci's demo values are as in the original PR: Botsabelo → LS-DM-BOTS, Motebang → LS-DM-MOTE, organization LS-DM.

## Rollout (the user's decisions)

- **The user decides the merge order** across FM2-708, the Lesotho distro (it has to pick up an FHIR2 build with FM2-708), and the mediator, distro-tools and Puppet PRs.
  - The plan doesn't pin image tags or bump the distro.
  - `kol-ci` runs the mediator's `latest` image, so the mediator must not be published as `latest` until `kol-ci`'s OpenMRS has FM2-708.
  - The mediator PR description should say this.
- **Upgrade step, documented and not automated:** failed transactions held in OpenHIM from before the upgrade carry a bare ServiceRequest, which the new mediator rejects, so they can't be re-run as they are.
  - Before upgrading, re-run or clear any that matter.
  - Afterwards, re-send any that remain as `{ serviceRequestId }`.
  - Put this note in the mediator README, or its upgrade/deploy notes, and in the PR description.

## Left to the builder

- Module/function layout in the mediator, and how the Bundle is indexed.
- How the old UHM-9468 commits are reworked: new commits on top, or rewritten history with a force-push. This needs the user's say-so before any force-push.

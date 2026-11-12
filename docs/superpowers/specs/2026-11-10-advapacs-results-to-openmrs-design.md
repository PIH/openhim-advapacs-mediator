# AdvaPACS results to OpenMRS: Radiology Study and Radiology Report encounters

Date: 2026-11-10. Jira: LSO-209 (this work), UHM-9458 / UHM-9459 (webhook receiver), LSO-245 (provider
identifier).

## Intent

Radiology orders already flow from OpenMRS to AdvaPACS through this mediator. Nothing comes back yet:
the AdvaPACS webhook reaches the mediator (`POST /webhooks/advapacs`, through OpenHIM) and is only
logged. This work closes the loop, so a clinician in OpenMRS sees that a study was performed and can
read the signed radiology report, using the encounters OpenMRS's **radiologyapp** module already
shows on the patient dashboard and radiology section.

Two repos change:

- **`openmrs/openmrs-module-radiologyapp`**: a small REST endpoint to create studies and reports.
- **`PIH/openhim-advapacs-mediator`** (this repo): turn webhook events into calls to that endpoint.

## Goals

- `STUDY_CREATED` → one **Radiology Study** encounter for the order.
- A report signed as `final` → one **Radiology Report** encounter of type *final*.
- A report `amended` or `corrected` → a new Radiology Report encounter of type *correction*.
- Repeated or out-of-order webhooks never create duplicates.
- Every write to OpenMRS can be traced (mediator log, OpenHIM transaction, OpenMRS log).
- The mediator's calls to the radiologyapp endpoint go through a new OpenHIM channel (see "The
  mediator → OpenMRS channel").

## Non-goals (not in this first version)

Tracked so they can be picked up later:

1. **Preliminary reports** (`DiagnosticReport.status = preliminary`): ignored. Open question for the
   PIH team: should they go to OpenMRS?
2. **HTML reports**: `presentedForm` is treated as plain text. If its `contentType` isn't
   `text/plain`, log a warning (content type only) and still save the decoded text. Revisit once a
   real HTML report is seen.
3. **Radiologist matching by anything but an identifier.** See "Radiologist" below. Real fix:
   a provider identifier (LSO-245).
4. **`STUDY_UPDATED`** events: ignored.
5. **Draft (`partial`), `registered`, `unknown`, `cancelled`, `entered-in-error`** reports: ignored.
6. **Lost events.** Since the 2026-11-12 change (see "Acknowledging AdvaPACS and retrying"), an
   event that reaches OpenHIM is retried by OpenHIM, so AdvaPACS's retry behaviour only matters when
   the webhook can't be received at all (OpenHIM or the mediator down, or the network). Still an
   open question for the AdvaPACS vendor: do they retry, how often, for how long? If not, events sent
   while OpenHIM or the mediator is down are lost; no catch-up poll is built in this version.
7. **Number of images.** radiologyapp's study model has *Radiology images available* (yes/no) but
   no count. Future task: consider adding a "number of images" concept to the *Radiology study
   construct*, filled from `ImagingStudy.numberOfInstances`.
8. **Location other than the unknown location.** Studies and reports always use the unknown
   location in this version (see anti-goals). Future task: work out where the performed location
   could come from (e.g. AdvaPACS Site, modality/device, or a mapping table) and record it.
9. **Technician and radiologist other than by provider-UUID identifier.** Both are matched only via
   the OpenMRS provider-UUID identifier on the AdvaPACS Practitioner; otherwise the unknown provider.
   Future task: make these real providers in practice (a provider identifier, LSO-245, and AdvaPACS
   users linked to OpenMRS providers).
10. **One study per order.** radiologyapp allows exactly one Radiology Study per order number and has
    no update. Future task: review whether that model fits AdvaPACS (repeat acquisitions, a study
    split or merged in the PACS, more images added later, `STUDY_UPDATED`) and whether radiologyapp
    should change.
11. **Routing the order poller through OpenHIM.** The poller keeps calling OpenMRS directly in this
    version. Potential improvement, to ticket: send its searches through an OpenHIM channel so they
    show as transactions. Why not now: it polls every few seconds, so it would add a transaction
    per poll, most of them empty; non-empty responses hold full order Bundles with Patient
    resources (so body storage would need turning off for them); a failed poll needs no OpenHIM
    retry (the next poll covers it); and it changes an order path that already works on kol-ci.
    The other direct calls (`getConceptsMappedToSource`, `getOrderBundle`) stay direct too.

**Accession numbers are matched by assigning authority and number, never by number alone.** Lesotho
will run one OpenMRS server shared by all sites, and accession numbers (order numbers) are unique
within it. But an accession number only means "this OpenMRS order" when it was issued by that
server, so the mediator must check the accession identifier's assigning authority (its `system`,
and `assigner` if AdvaPACS sends one) before using its value. See "Accession number" under
Decisions.

## Anti-goals (would make this a failure even if it "works")

- **Filing a study or report against the wrong patient** (e.g. another site's study with a matching
  accession number).
- **Attributing a report to the wrong clinician.** Never match radiologists by name.
- **Recording the ordering location as the place the study was performed.**
- **Duplicate studies or repeated final reports** in the patient record.
- **Patient details in logs.** Keep the existing rule: log resource ids, types, statuses and field
  *names*, never values such as names or report text.

## What we know

### Webhook events (observed on kol-ci, 2026-11-10)

Events carry only a reference: `{ timestamp, eventId, eventType, data: { type, id } }`. One full
order → study → report workflow produced, in order:

| Event | `data.type` | Notes |
|---|---|---|
| `STUDY_CREATED` | `study` | the ImagingStudy id |
| `REPORT_CREATED` | `report` | the DiagnosticReport id |
| `REPORT_UPDATED` ×3 | `report` | same id; one per report transition |

In that run the order reached AdvaPACS at 21:19:50 UTC and `STUDY_CREATED` came at 21:21:19, after
acquisition, so the study appears to be created when images arrive (to confirm; see the study guard
below).

AdvaPACS's webhook test sends `eventType: TEST_EVENT` with `data: {}` (already acknowledged with a
200, PR #18). The status that tells report events apart is only in the resource, so each event needs
a FHIR read from AdvaPACS.

### AdvaPACS FHIR resources (from the IMLADRIS lab, `jwalbers/imladris`; to confirm on kol-ci)

- **ImagingStudy**: `identifier` includes the accession (type `ACSN`), which this mediator sets to the
  OpenMRS **order number**. `started` is when it was performed. `numberOfSeries` /
  `numberOfInstances` / `series` describe the images.
- **DiagnosticReport**: `status` (FHIR R5 codes); `basedOn` → ServiceRequest, `study` →
  ImagingStudy; `issued`; `resultsInterpreter` / `performer` → Practitioner; report text in
  `presentedForm[].data` (base64, `contentType` text/plain or text/html), **only returned on a
  single-resource read**, not in searches.
- AdvaPACS report statuses observed in the lab: `partial` (draft), `preliminary`, `final` (signed),
  `amended`, `cancelled`. Each transition fires a `REPORT_UPDATED`, including ones that don't change
  `status`.
- The lab's findings are a reference, not a spec: confirm field presence on kol-ci before relying on it.

### radiologyapp (`openmrs-module-radiologyapp`)

- **Study encounter** (`saveRadiologyStudy`): encounter type GP `emr.radiologyStudyEncounterType`;
  date = date performed; location (defaults to the unknown location); technician role (defaults to
  the unknown provider); obs group *Radiology study construct* with *Radiology accession number*
  (= order number), *Radiology procedure performed*, *Radiology images available*. The obs group is
  linked to the order. Validation: order number, date and patient required; **rejects a second study
  for the same order number**.
- **Report encounter** (`saveRadiologyReport`): encounter type GP `emr.radiologyReportEncounterType`;
  date = report date; location; principal results interpreter role; obs group *Radiology report
  construct* with accession number, *Radiology report comments* (text), *Type of radiology report*
  (*preliminary* / *final* / *correction*) and procedure. Several reports per order allowed.
- Lookups exist: `getRadiologyOrderByOrderNumber`, `getRadiologyStudyByOrderNumber`,
  `getRadiologyReportsByOrderNumber`. `getRadiologyOrderByOrderNumber` only returns a `TestOrder` of
  the order type in GP `emr.radiologyTestOrderType`. kol-ci's orders are placed from radiologyapp's
  Radiology section, so they should have that type; confirm on kol-ci, since otherwise every event
  would quietly become "no matching order".
- **No REST API at all today**; only the Java service.

## Decisions

### Event → OpenMRS mapping

| Event | Mediator action |
|---|---|
| `STUDY_CREATED` | Read the ImagingStudy; create a Radiology Study. |
| `REPORT_CREATED` / `REPORT_UPDATED` | Read the DiagnosticReport; act on `status`: |
| → `final` | Create a Radiology Report, type *final*. |
| → `amended`, `corrected` | Create a Radiology Report, type *correction*. |
| → anything else | Ignore (log at info: event, report id, status). |
| `TEST_EVENT`, other types, incomplete events | Acknowledge and log as today. |

**Study fields**

- Order, patient, procedure: found by radiologyapp from the accession number (order number).
- Date performed: `ImagingStudy.started`.
- Images available: `numberOfInstances` > 0 → yes; 0 → no; absent → not set. Confirm on a real
  kol-ci ImagingStudy which of these fields AdvaPACS fills.
- Location: **always the unknown location.** The order's location is where it was ordered, not
  where it was performed.
- Technician: an OpenMRS provider only if found the same way as the radiologist (see "Radiologist
  and technician"): the Practitioner in `ImagingStudy.series[].performer[]` carries the OpenMRS
  provider-UUID identifier and that provider exists. Otherwise the unknown provider. Never by name.
  Whether AdvaPACS fills `series.performer` at all is unknown (DICOM only carries operator *names*);
  confirm on kol-ci. If there are several matching performers, use none (unknown provider) rather
  than guess.
- **Guard** *(my call)*: radiologyapp allows only one study per order and has no update, so the first
  write is final. If the ImagingStudy has no `started`, or reports 0 instances, don't create the
  study; log it and acknowledge. A later report will create the study (see "Missing study when a
  report arrives"). This matters only if `STUDY_CREATED` turns out to fire before images arrive.

**Report fields**

- Order, patient, procedure: from the accession number, as above.
- Accession number: from the report's ImagingStudy (`study`) or ServiceRequest (`basedOn`)
  identifier.
- Report date: `issued`.
- Report text: decoded `presentedForm` (plain text; see non-goal 2). The report's `conclusion` (a short
  summary/impression) is never used as the report text; if a report has one, it isn't saved and a
  warning says so (field name only). A report with no `presentedForm` is skipped with a warning.
- Report type: *final* or *correction*, from `status`.
- Location: always the unknown location.
- Radiologist: see below.

**A final report never changes** (assumption agreed for this version). Once an order has a *final*
report, further `final` events for it are repeats and are ignored. Changes after signing come as
`amended`/`corrected` and become *correction* reports.

### Radiologist and technician

The same rule for both (technician: from the ImagingStudy; radiologist: from the DiagnosticReport).
Use an OpenMRS provider only when the Practitioner carries the OpenMRS provider-UUID
identifier (`ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM`, on kol-ci
`http://www.pih.org/identifiers/lesotho/provider-uuid`), the identifier this mediator already puts
on ordering providers, and an OpenMRS provider with that UUID exists. Otherwise the unknown provider.
**Never match by name.** AdvaPACS radiologists and technicians are AdvaPACS users and probably won't
carry that identifier; a provider identifier (LSO-245) is the real fix (non-goal 9). The code should
still support the match, so it can be tested with a user who has an OpenMRS provider account.

### Patient check (shared AdvaPACS tenant)

Accession numbers are plain OpenMRS order numbers with no site prefix, and several OpenMRS servers
(kol-ci, the IMLADRIS lab, later production sites) share one AdvaPACS tenant, so another site's study
can carry an accession that matches a *local* order. Before writing anything, check that the AdvaPACS
patient matches the order's patient: the ImagingStudy's (or report's) `subject` → AdvaPACS Patient →
its identifier in this mediator's patient identifier system (`PATIENT_IDENTIFIER_SYSTEM`, the Lesotho
EMR ID), compared with the order's patient's identifier of that type. On a mismatch, or if the
AdvaPACS patient has no such identifier, skip: no encounter, a warning in the OpenMRS log and the
mediator log (ids only), and a non-error response. This also catches a study reassigned to another
patient in the PACS. Where the check runs (mediator or endpoint) is left to the builder; the endpoint
is the natural place, since it has the order.

> **Important TODO:** find out whether AdvaPACS webhooks can be partitioned by **Site** or
> **Organisation** (e.g. one webhook per Site/Organisation, or the Site/Organisation in the event or
> resource), so each OpenMRS only receives, or only acts on, its own studies and reports. The patient
> check guards against wrong-patient writes but not against processing other sites' traffic, and
> doesn't help if two sites' patients ever share an identifier. Related settings already exist:
> `ADVAPACS_SITE_MAP` / `ADVAPACS_ORGANIZATION`.

### Accession number

- Use only the accession identifier (`identifier` with type `ACSN`) whose `system` is the one this
  mediator puts on orders (`http://www.pih.org/identifiers/lesotho/radiology-accession-number`,
  `ACCESSION_NUMBER_SYSTEM` in `orderRelay.js`). Never take a bare value, or one from another
  system, as an OpenMRS order number.
- If the resource has no accession with that system, skip: no encounter, a warning in the mediator
  log (resource id, the systems seen, no values), and a 200 to AdvaPACS.
- *(My call)* Make the expected system a setting shared with `orderRelay.js`, defaulting to today's
  value, in case AdvaPACS returns its own NamingSystem URI instead of echoing ours. **To confirm on
  kol-ci:** what `system` (and any `assigner`) AdvaPACS returns on the ImagingStudy's and the
  ServiceRequest's accession identifier.
- The endpoint is passed the order number only after this check; the patient check below still
  applies on top.

### Visits

The study and report encounters are not attached to a visit by the endpoint; the server's visit
assignment handler (OpenMRS core / emrapi) assigns them, as for other encounters. Confirmed as the
intended behaviour for this version.

### Accession with no OpenMRS order

Skip it: no encounter, a **warning in the OpenMRS log** (and the mediator log), and a non-error
response so nothing retries. Examples: a study done in AdvaPACS without an OpenMRS order, or an order
from another site sharing the AdvaPACS tenant.

### The radiologyapp REST endpoint

A small endpoint under OpenMRS's REST API that calls the existing `saveRadiologyStudy` /
`saveRadiologyReport`, so the module's validation (including the duplicate-study check) stays in the
module and nothing duplicates its rules.

Required behaviour:

- **Create study**: takes accession number, date performed, images available (optional), and
  optionally the technician's OpenMRS provider UUID. Looks up the order
  (`getRadiologyOrderByOrderNumber`); sets patient, procedure, the order, unknown location, technician
  (or unknown provider).
- **Create report**: takes accession number, report date, report type (*final* / *correction*),
  report text, and optionally the radiologist's OpenMRS provider UUID. Looks up the order; sets
  patient, procedure, the order, unknown location, provider (or unknown provider).
- **Outcomes** the mediator can tell apart: *created*, *already exists* (study already recorded;
  *final* report already recorded; *correction* already recorded for the same report date), *no
  matching order*. The last two are not errors and are logged as warnings in OpenMRS. Bad input is a
  4xx; unexpected failures a 5xx.
- **Missing study when a report arrives**: create the study first, from what the report gives (date
  performed = report date unless better known; images available unset). *(My call: a real study
  encounter is cleaner than radiologyapp deriving one from reports.)*
- Requires an authenticated OpenMRS user with privileges to create encounters (the mediator's
  existing OpenMRS account).

### The mediator → OpenMRS channel

A new OpenHIM channel for the mediator's calls to the radiologyapp endpoint, so each write is a logged
OpenHIM transaction, as the AdvaPACS legs already are. Provisioned by the mediator like its other
channels (`defaultChannelConfig` in `mediatorConfig.json`), with a mediator-side setting for its URL
like `ADVAPACS_CHANNEL_URL`. Its `urlPattern` covers only the radiologyapp endpoint, not OpenMRS in
general. The order poller and other existing OpenMRS calls stay direct (non-goal 11).

**Assumption:** OpenHIM and OpenMRS run on the same server (as on kol-ci), so the route goes to
OpenMRS over the local/docker network and the OpenMRS credentials never cross another network. If
they are ever split, the route needs TLS and this section needs revisiting.

#### How the channel authenticates *(my call: a private channel)*

Two logins are involved, and both use the same HTTP header (`Authorization: Basic ...`):

1. **The mediator to OpenHIM**: is this caller allowed to use this channel?
2. **OpenHIM to OpenMRS**: which OpenMRS user is making this change?

One request can carry only one value in that header, so they can't both come from the mediator.
OpenHIM channels come in two kinds that handle this differently:

- **Public channel**: OpenHIM doesn't check the caller at all. The mediator would send its OpenMRS
  login, and OpenHIM would pass it on to OpenMRS (`forwardAuthHeader`). This is how the existing
  "Mediator to AdvaPACS" channel works. Not chosen, because OpenHIM itself wouldn't restrict who
  can use the channel, its log couldn't say who called, and the OpenMRS login would travel in every
  request that passes through OpenHIM. A private channel keeps the OpenMRS login out of those
  requests.
- **Private channel (chosen)**: OpenHIM checks the caller against its list of clients and drops
  that login; the route then adds the OpenMRS login when calling OpenMRS. This is how the existing
  "OpenMRS to Mediator Order Push" and webhook channels work on their inbound side.

So a radiologyapp call goes:

```
mediator ──(Basic: mediator's OpenHIM client id + password)──▶ OpenHIM router
   OpenHIM: is this a known client, allowed on this channel?  no → 401
            yes → log the transaction; remove the client's Authorization header
OpenHIM ──(Basic: OpenMRS username + password, set on the route)──▶ OpenMRS radiologyapp endpoint
   OpenMRS: checks that login and the user's privileges, as for any REST call
```

What it needs:

- A new OpenHIM **client** for the mediator (its own id and password, kept in the mediator's
  settings like the other OpenHIM credentials, and in puppet for kol-ci), allowed on this channel
  only.
- The channel: `authType: private`, `allow` = that client, `forwardAuthHeader: false`, `urlPattern`
  covering only the radiologyapp endpoint, methods `POST` only.
- Its route: OpenMRS's host and port on the local/docker network (see the assumption above), with
  the route's `username`/`password` set to the mediator's existing OpenMRS account
  (`OPENMRS_USERNAME` / `OPENMRS_PASSWORD`).
- The mediator provisions the client, channel and route at startup, like its other channels, so a
  changed password is picked up on restart.

Trade-off accepted: the OpenMRS login is also stored in OpenHIM's channel configuration, visible to
OpenHIM admins in the console.

Points the builder must handle:

- **Retries.** No `autoRetry` on this channel: retries happen one level up, on the event-processing
  channel (see "Acknowledging AdvaPACS and retrying"), so an event isn't retried twice over.

### Acknowledging AdvaPACS and retrying *(change, 2026-11-12)*

**Why.** The first version handled each event while AdvaPACS waited, and answered 5xx on failure so
that AdvaPACS would retry. That depends on AdvaPACS retrying (unknown), lets a permanent failure
(e.g. a mistyped setting) be retried forever, and makes AdvaPACS wait behind every earlier event,
risking its webhook timeout and a storm of retries. OpenHIM already does bounded, visible retries
for the order path; use it for results too.

**How it works.**

```
AdvaPACS ──webhook──▶ OpenHIM "AdvaPACS to Mediator Study and Report Webhook" channel (as today)
   ──▶ mediator POST /webhooks/advapacs: check credentials and event shape, then
       POST the event to OpenHIM's new "AdvaPACS Event Processing" channel and wait for OpenHIM's answer
          ──▶ mediator POST /results/advapacs-event: do the work (read AdvaPACS, call radiologyapp)
              • handled or deliberately skipped → 200
              • worth retrying → OpenHIM mediator-error response (as routes/serviceRequest.js does),
                so OpenHIM queues the transaction for auto-retry
   ◀── once OpenHIM has answered (the transaction is stored, and queued for retry if it failed),
       the mediator answers AdvaPACS 200
```

- **AdvaPACS is acknowledged only after OpenHIM has accepted the event.** If OpenHIM can't be
  reached, rejects the mediator's credentials, or has no such channel, the mediator answers AdvaPACS
  with a 5xx (nothing was stored, so AdvaPACS's own retry, if any, is the only recovery).
- **OpenHIM's answer comes after the first processing attempt** (OpenHIM is a pass-through). To
  keep AdvaPACS from waiting on a slow attempt, the processing channel's route has a short timeout
  *(my call: 10 seconds)*. On a timeout OpenHIM stores the transaction as failed and queues a retry,
  and answers the mediator, which then acknowledges AdvaPACS. The slow attempt carries on in the
  mediator; when the retry comes, the idempotent endpoint answers *already exists*.
- **Retry schedule** *(my call)*: every 5 minutes, up to 24 attempts (2 hours), covering an OpenMRS
  restart. After the last attempt the transaction stays *Failed* in the OpenHIM console, where it
  can be re-run once the cause is fixed (e.g. a configuration error).
- **What's retried:** AdvaPACS or OpenMRS unreachable, timeouts, 5xx; a 4xx from radiologyapp
  (contract or configuration error, fixable); missing mediator configuration; **a 404 for the
  event's own resource** (the event may arrive before AdvaPACS can serve the resource), bounded by
  the schedule. **What's not retried** (200, logged): every deliberate skip in "Event → OpenMRS
  mapping" (status not imported, no accession with our system, no patient identifier, no report
  text, unparseable dates, …) and the endpoint's *already exists* / *no matching order* / *patient
  mismatch* outcomes.
- **Ordering.** Events are still processed one at a time in the mediator, but a retried event runs
  after later ones. An event carries only a reference, so every attempt reads the resource **as it
  is now**: if a report was signed and then amended before the *final* event was processed, the
  retried event sees `amended` and records a *correction* only, so that order gets a correction and
  **no *final***. *(My call: acceptable for this version; the latest text is what's recorded.
  radiologyapp accepts a correction without a final.)* To raise with the team alongside the
  preliminary-reports question.
- **What OpenHIM stores:** the processing channel's bodies are just the webhook event (references
  and ids, no patient details) and the outcome.
- The processing channel is private, allows only the mediator's own client (the results client,
  `advapacs-mediator`), and is provisioned by `scripts/setupOpenhim.js` like the others.
- The webhook channel itself keeps no `autoRetry` (AdvaPACS → mediator), and the radiologyapp channel
  keeps none (see above).

### The mediator

- On each webhook event (after the existing credential and shape checks), hand it to OpenHIM's
  processing channel as above. The processing endpoint reads the resource from
  AdvaPACS FHIR through the existing outbound OpenHIM channel (`ADVAPACS_CHANNEL_URL`):
  `GET ImagingStudy/{id}` or `GET DiagnosticReport/{id}` (single read, for `presentedForm`), plus the
  study or ServiceRequest if the accession isn't on the report.
- Apply the mapping above and call the radiologyapp endpoint.
- Respond to AdvaPACS: 200 once OpenHIM has accepted the event; 5xx only if OpenHIM couldn't take it
  (see "Acknowledging AdvaPACS and retrying"). The handling is idempotent, so a retry never
  duplicates.
- **Stateless**: no local store; OpenMRS's existing encounters, via the endpoint's *already exists*
  outcomes, are what make it idempotent.
- Log each decision: event, resource id, status, accession, outcome. No patient details, no report text.
- *(My call)* The "no patient details in logs" rule covers the mediator's and OpenMRS's logs. OpenHIM's
  transaction store already keeps full order bodies (with Patient resources) and will keep report
  bodies too; that is OpenHIM's role. Whether to limit body storage there for production is a
  separate operational decision.
- New settings (radiologyapp endpoint path, report-status → type mapping) get README entries, like
  the existing ones.

## Left to the builder

- The endpoint's URL, request and response format, and which REST framework pieces to use
  (e.g. a controller under `/ws/rest/v1/radiologyapp/...`, which needs a webservices.rest dependency
  the module doesn't have today).
- Whether the new channel stores request/response bodies (report text passes through it).
- How *correction* repeats are detected (report date is the suggestion; the IMLADRIS lab saw
  AdvaPACS update `issued` on each sign and amend, so a new amendment gets a new date; confirm on kol-ci).
- The processing channel's path and name, and the retry settings' exact values if kol-ci shows a
  reason to change them.
- Tests in both repos, and the radiologyapp release / kol-ci deployment steps.

## Verification

On kol-ci, with your own AdvaPACS account:

1. Place a radiology order, acquire with the modality simulator: a Radiology Study appears in
   OpenMRS for that order, location unknown, images available as expected.
2. Write and sign a report: one *final* Radiology Report with the report text.
3. Trigger further transitions on the signed report: no second *final*.
4. Amend the report: one *correction* report.
5. Replay an event (resend from the OpenHIM console): nothing new is created.
6. Study for an accession unknown to OpenMRS: a warning in the OpenMRS log, nothing created.
6a. Study whose AdvaPACS patient doesn't match the order's patient (e.g. reassign the study to another
   patient in AdvaPACS): a warning, nothing created.
7. With a radiologist whose Practitioner has the provider-UUID identifier: the report shows that
   provider; without it, the unknown provider. Same for a technician on the ImagingStudy, if
   AdvaPACS fills `series.performer`.
8. Each radiologyapp call shows as a transaction on the new channel in OpenHIM, under the
   mediator's client.
9. Check the accession identifier on a real ImagingStudy and ServiceRequest: its `system` and any
   `assigner`. Then send (or replay with an edited body) a study whose accession has the right
   number but a different `system`: nothing created, a warning logged.
10. Retries: stop OpenMRS (or point the results channel somewhere unreachable), send an event:
    AdvaPACS gets a 200, the processing transaction is *Failed* and queued for retry in OpenHIM;
    start OpenMRS: a later retry creates the encounter. Also check a mistyped
    `OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID` stops after the last retry and can be re-run from the console.
11. Ordering: sign a report, then amend it while OpenMRS is down; after it's back, expect one
    *correction* with the amended text and no *final* (see "Ordering"). Sign another report with
    OpenMRS up, then amend it: one *final* and one *correction*.
12. Early 404: look for any first-attempt 404 on the event's own resource in OpenHIM, to see whether
    AdvaPACS sends events before it can serve the resource.

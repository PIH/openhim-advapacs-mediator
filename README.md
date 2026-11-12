# OpenMRS-AdvaPACS FHIR mediator (scaffold)

An OpenHIM mediator that sits between OpenMRS and AdvaPACS and moves radiology
orders and results between them as FHIR resources.

## Flow

1. An order is created in OpenMRS (`ServiceRequest`).
2. That order reaches this mediator one of two ways, controlled by
   `ORDER_INGESTION_MODE` (see `.env.example`):
   - **`push`**: something on the OpenMRS side POSTs it (or its id)
     to `POST /fhir/ServiceRequest` on this mediator (`src/routes/serviceRequest.js`),
     via OpenHIM's "OpenMRS to Mediator Order Push" inbound channel.
   - **`poll`** (default): `src/lib/orderPoller.js` periodically searches OpenMRS's FHIR
     `ServiceRequest` endpoint for anything new since the last poll, then POSTs
     each one to that same OpenHIM inbound channel. The search includes each
     order's `Patient`, ordering `Practitioner`, `Encounter` and, through
     `Encounter.partOf`, its Visit, so a poll is one OpenMRS request per page of
     results and relaying an order makes no further OpenMRS calls. Each order is
     POSTed as an order Bundle of those resources (`src/lib/orderBundle.js`).
     **This needs an OpenMRS whose FHIR2 module has FM2-708**
     (`_include:iterate=Encounter:part-of`); an older one rejects the search.
3. Either way, `routes/serviceRequest.js` hands off to `src/lib/orderRelay.js`,
   which reads the OpenMRS `Patient` from the order Bundle and, before touching the
   `ServiceRequest` at all, pushes/updates that `Patient` in AdvaPACS first
   (`advapacsClient.js`'s `upsertPatient` — searches by identifier, then
   `PUT`s if AdvaPACS already has that patient or `POST`s to create) — if
   that fails, the `ServiceRequest` is never sent (fail-fast: AdvaPACS needs
   the patient record to exist before it can match an order to it). Only
   then does `orderRelay.js` remap the `ServiceRequest.subject` to a
   **literal reference at AdvaPACS's own Patient id**
   (`Patient/{advapacs-id}`, taken from `upsertPatient`'s response) instead
   of the OpenMRS UUID — a logical identifier-based reference was tried
   first but made AdvaPACS's real ServiceRequest endpoint 500 with no
   diagnostic detail. Several other OpenMRS-specific fields are also
   stripped or reshaped before the outbound `ServiceRequest` is sent
   (`encounter`/`requester`/`id`/`meta`/`text` dropped; `code`,
   `occurrenceDateTime`, and `orderDetail` reshaped to what AdvaPACS's FHIR
   R5 API actually expects) — see the inline `TODO`/`HACK`/`EXPERIMENT`
   comments in `orderRelay.js` for the current state and ticket numbers
   behind each. `advapacsClient.js` then pushes the `ServiceRequest` itself.
   Both pushes go through a second, **outbound** OpenHIM channel ("Mediator
   to AdvaPACS Order Push", `^/advapacs/.*$`) rather than calling AdvaPACS
   directly, so each leg is logged and auto-retried by OpenHIM (see Known
   limitations).
4. As the study is performed and reported, AdvaPACS calls its webhook
   (Configuration > Webhooks) with events such as "study created" and
   "report updated". Each event carries only a reference to the resource
   (`{ eventType, data: { type, id } }`). The webhook goes through a third
   OpenHIM channel ("AdvaPACS to Mediator Study and Report Webhook",
   `^/webhooks/advapacs$`) to
   `POST /webhooks/advapacs` (`src/routes/advapacsWebhook.js`). **For now it
   only logs each event** (UHM-9458/UHM-9459), so the real event sequence can
   be seen before anything is written to OpenMRS. See "AdvaPACS webhook" below.

```
orderPoller.js (every ORDER_POLL_INTERVAL_MS)
  --HTTP POST--> OpenHIM inbound channel  ^/fhir/ServiceRequest$
    --routes to--> mediator's POST /fhir/ServiceRequest (routes/serviceRequest.js)
      --calls--> orderRelay.js (read the order Bundle, reshape ServiceRequest for AdvaPACS)
        --calls--> advapacsClient.js upsertPatient()          [1: Patient, first]
          --HTTP GET/POST/PUT--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
        --calls--> advapacsClient.js createServiceRequest()   [2: ServiceRequest, only if #1 succeeded]
          --HTTP POST--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
            --pathTransform strips /advapacs, routes to--> real AdvaPACS host
```

## AdvaPACS webhook

```
AdvaPACS ──HTTPS POST, Basic auth──▶ reverse proxy (Caddy)  /openhim-router/webhooks/advapacs
  --strips /openhim-router--> OpenHIM router :5001, channel "AdvaPACS to Mediator Study and Report Webhook"  ^/webhooks/advapacs$
    (authType private: only the "advapacs" OpenHIM Client; forwards the Authorization header)
    --routes to--> mediator's POST /webhooks/advapacs (routes/advapacsWebhook.js): checks the
                   credentials again, logs the event, then hands it to
                   lib/resultHandler.js (see "Results to OpenMRS")
```

- **Credentials.** AdvaPACS calls the channel as an OpenHIM Client: in the
  webhook's settings choose Basic Authentication, with the Client's id
  (`ADVAPACS_WEBHOOK_CLIENT_ID`, default `advapacs`) as the username and
  `ADVAPACS_WEBHOOK_SECRET` as the password. `scripts/setupOpenhim.js`
  creates the Client from those on every boot; without
  `ADVAPACS_WEBHOOK_SECRET` it creates none, so the channel accepts no one
  (a Client created earlier stays until deleted in the OpenHIM console). The
  mediator checks the same credentials again, as a backstop in case its port
  is ever reached without going through OpenHIM.
- **Endpoint.** The reverse proxy must forward only
  `/openhim-router/webhooks/*` to the router, never the whole router (see the
  outbound channel under Known limitations). On kol-ci the webhook URL is
  `https://kol-ci.pih-emr.org/openhim-router/webhooks/advapacs`.
- **Events.** AdvaPACS offers study, patient, order and report created /
  updated (/ deleted) events. Subscribe to study created/updated and report
  created/updated.
- **Logging.** Each event is logged with its type, id, timestamp and the
  resource reference. Fields the docs don't describe are logged by name only,
  so nothing unexpected (e.g. patient details) reaches the logs. An event
  without an `eventType` and `data.id`, like the one AdvaPACS's webhook
  test sends, still gets a 200 (AdvaPACS rejects the webhook otherwise) and is
  logged as a warning, with its field names only.

## Results to OpenMRS

```
AdvaPACS webhook event (STUDY_CREATED, REPORT_CREATED / REPORT_UPDATED)
  --> routes/advapacsWebhook.js --> lib/resultHandler.js
        --reads the study / report (and its Patient) from AdvaPACS--> advapacsClient.js
        --maps it (lib/resultMapper.js) and POSTs it, as JSON--> radiologyappClient.js
          --> OpenHIM channel "Mediator to OpenMRS Radiology Results"  ^/openmrs/ws/rest/v1/radiologyapp/(study|report)$
            --> OpenMRS POST /ws/rest/v1/radiologyapp/study | report
```

An event carries only a reference to the resource, so the handler reads the
study or report back from AdvaPACS, finds the OpenMRS order through the
radiology accession number (the order number), and has radiologyapp create a
Radiology Study encounter (for a study) or a Radiology Report encounter (for a
`final` report as type *final*, for `amended` / `corrected` as type
*correction*).

- **Required OpenMRS version.** A radiologyapp with the
  `/ws/rest/v1/radiologyapp/study` and `/report` endpoints: the
  2.0.0-SNAPSHOT build from branch LSO-209 of `openmrs-module-radiologyapp`.
  Earlier releases have no REST API, so every import would fail.
- **Settings** (see `.env.example`):

  | Variable | Purpose |
  |---|---|
  | `ADVAPACS_ACCESSION_NUMBER_SYSTEM` | Identifier system under which AdvaPACS carries our accession number; results are matched on it only. Has a default. |
  | `OPENMRS_RESULTS_CHANNEL_URL` | Address of the "Mediator to OpenMRS Radiology Results" channel as the mediator sees it (distro-tools: `http://openhim-core:5001/openmrs`). |
  | `OPENHIM_RESULTS_CLIENT_ID` | OpenHIM Client the mediator calls that channel as (default `advapacs-mediator`). |
  | `OPENHIM_RESULTS_CLIENT_PASSWORD` | That Client's password; `scripts/setupOpenhim.js` creates the Client from it. Unset, the channel accepts no one. |
  | `OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID` | The OpenMRS patient identifier type matching `ADVAPACS_PATIENT_IDENTIFIER_SYSTEM`. Required. |

  `ADVAPACS_PATIENT_IDENTIFIER_SYSTEM` and
  `ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM` are now also used for results, to
  find the patient and the report's radiologist in OpenMRS.
- **OpenMRS user privileges.** The channel calls OpenMRS as `OPENMRS_USERNAME`,
  which needs the core privileges `Add Encounters`, `Add Observations`,
  `Get Orders`, `Get Patients`, `Get Providers`, `Get Concepts` and
  `Get Encounters`, plus whatever radiologyapp itself requires.
- **Same server.** The channel's route goes to `openmrs:8080`, so it assumes
  OpenHIM and OpenMRS run on the same server (same Docker network).
- **One event at a time.** The handler processes events one at a time, in
  arrival order, so two final events for one report can't both create it.
- **200 vs. 5xx.** Handled and deliberately skipped events get a 200 with
  `{"status":"ok","outcome":...}`: a report that isn't final yet, no matching
  order, a patient mismatch, a result that already exists, an unsupported event
  type. A failure of AdvaPACS or OpenMRS, or missing configuration, gets a 500
  `{"status":"error"}` (details only in the mediator's log), so AdvaPACS can
  retry. Logs never include patient identifiers or report text.

## Upgrading to the single-request poll

From this version the mediator needs FHIR2 with FM2-708 (see Flow), and its
inbound endpoint accepts only an order Bundle or `{ "serviceRequestId" }`. A
failed OpenHIM transaction from an earlier version carries a bare
`ServiceRequest`, so re-running it fails. Before upgrading, re-run or clear any
failed transactions that matter; afterwards, re-send any that remain as
`{ "serviceRequestId": "<uuid>" }`.

## What's real vs. stubbed

This scaffold wires up the transport, auth, and registration plumbing
end-to-end and will run. Two things are intentionally left as `TODO`s because
they need your actual data model, not boilerplate:

- **Identifier reconciliation** (`serviceRequest.js`, `advapacsWebhook.js`):
  right now the AdvaPACS-side id returned on order push is only logged. You'll
  want a small lookup store (a table, or OpenHIM's own transaction/orchestration
  log) mapping OpenMRS `ServiceRequest.id` ↔ AdvaPACS `ServiceRequest.id`, so
  the webhook handler can find the right OpenMRS order to update instead of
  relying on `DiagnosticReport.basedOn` alone.
- **Location identifier mapping**: the patient side of this is resolved
  (`orderRelay.js` references the patient via AdvaPACS's own Patient id —
  see Flow), and `encounter`/`requester` (Practitioner) references are
  dropped from the outbound `ServiceRequest` entirely, since AdvaPACS can't
  resolve OpenMRS UUIDs for either.
- **AdvaPACS Site (UHM-9468)**: with AdvaPACS's Organisations & Sites
  feature on, each order is sent with `location` pointing at the
  AdvaPACS Site for the OpenMRS Visit Location it was placed under — the
  location of the order's Visit, which arrives in the order Bundle as the
  `Encounter` its own encounter is `partOf` (see `siteLocation.js`) — and
  with `performer` pointing at that Site's Organisation (its
  `managingOrganization`). `location` is R5's CodeableReference, so the
  Location is nested: `[{ "reference": { "reference": "Location/<id>" } }]`.
  AdvaPACS's ServiceRequest docs show R4's `locationReference`, which
  AdvaPACS accepts but silently drops. `ADVAPACS_SITE_MAP` maps Visit Location uuids to Site identifiers, and
  the optional `ADVAPACS_ORGANIZATION` only accepts Sites in that
  Organisation (see `.env.example`). There's no fallback Site: an order
  whose Site can't be determined fails, and can be re-run from OpenHIM once
  the map is fixed (a re-run replays the order as it was polled, so a fix
  to the OpenMRS data needs the order re-sent, e.g. as
  `{ "serviceRequestId": "<uuid>" }`). With `ADVAPACS_SITE_MAP` unset, no
  location is sent.
- **The imaging modality comes from the mediator's modality map** (UHM-9616,
  `modalityMap.js`): a table of OpenMRS concept uuid -> DICOM modality code,
  built from the concepts' mappings to the DCM concept source, which is
  loaded from OpenMRS's REST API (`concept?source=DCM`) at startup and
  refreshed hourly, so relaying an order makes no OpenMRS call. DX and RF
  are sent as CR (`MODALITY_SUBSTITUTIONS`, not configurable). The
  ServiceRequest's own DICOM coding is ignored (FHIR2 sends at most one,
  picked arbitrarily: FM2-710). An orderable that isn't in the map goes out
  as `CR` with a warning. Until the map has first loaded (or if it loads
  empty), orders are held, not sent: the poller doesn't poll, the relay
  answers with a failed OpenHIM mediator response, which the inbound
  channel auto-retries every minute for up to 30 attempts, and `/health`
  answers 503.
- **Several other fields are temporarily hardcoded or reshaped** just to get
  a `ServiceRequest` past AdvaPACS's validation — accession-number
  identifier duplication (UHM-9437/9439/9440), an HL7 "PI" coding stamped
  onto the patient's EMR-ID identifier (UHM-9443). See the `TODO`/`HACK`/`EXPERIMENT` comments in `orderRelay.js` for the
  reasoning and ticket numbers behind each.

## Known limitations

- **OpenHIM's auto-retry only covers connection failures/timeouts to
  AdvaPACS, not AdvaPACS returning an HTTP error.** The outbound channel has
  `autoRetryEnabled`/`autoRetryPeriodMinutes`/`autoRetryMaxAttempts` set (see
  `mediatorConfig.json`, `scripts/setupOpenhim.js`), but OpenHIM only
  auto-retries a transaction when the request to the destination itself fails
  (network error, timeout) or the destination responds with OpenHIM's own
  mediator-error envelope — a plain 4xx/5xx from AdvaPACS doesn't qualify. A
  real AdvaPACS error today just surfaces as a failed transaction with no
  further retry or alerting (see the comment above `advapacsClient.js`'s
  `createServiceRequest`). If that needs to be retried too, it'd need either a
  translation layer that emits OpenHIM's error envelope, or a separate
  retry/alerting mechanism — not built here.
- **The AdvaPACS webhook only logs events.** Nothing is written to OpenMRS
  yet: that comes once the real event sequence has been seen (UHM-9458,
  UHM-9459). A webhook AdvaPACS fails to deliver isn't retried by anything
  here.
- **The outbound AdvaPACS channel is `authType: "public"` — deliberately, not
  an oversight.** The inbound channel (OpenMRS/poller → mediator) has real
  OpenHIM Client auth (`authType: "private"`, an `openmrs` Client created by
  `scripts/setupOpenhim.js`, `orderPoller.js` authenticating via Basic auth —
  plus an independent app-level `X-Mediator-Secret` check in
  `src/lib/sharedSecretAuth.js` as a backstop against direct access). The
  outbound channel can't get the same treatment: confirmed directly in
  `openhim-core-js`'s source, every non-mTLS OpenHIM client-auth mechanism
  (Basic, Custom Token, JWT) rides on the same `Authorization` header that
  this channel's `forwardAuthHeader: true` already reserves for passing
  AdvaPACS's own `Authorization: ID=...,Secret=...` credentials through
  unchanged — adding OpenHIM auth here would either break that pass-through or
  never authenticate at all. Mutual TLS is the only OpenHIM-native way around
  that conflict, but stands up real cert issuance/rotation for a channel whose
  only caller is the mediator container itself on a private Docker network —
  disproportionate here. The compensating control is the network instead.
  The host runs behind a firewall and VPN, and distro-tools' `openhim` fragment
  publishes only the ports the integration and its management use (see the
  comments in its `openhim.yaml`). The router's HTTP port is published for
  AdvaPACS's result webhook, so it can carry this public channel too: the
  reverse proxy in front (Caddy on the app cluster) must forward only the paths
  external systems call (the webhook), never `/advapacs/*` or the whole
  router. Otherwise anyone who can reach the proxy can relay requests to
  AdvaPACS through this channel. Revisit this if the host's trust model
  changes, e.g. it stops being VPN-only, or an app on it runs with
  `network_mode: host` or joins this instance's Docker network.

## Step you still need to do on the OpenMRS side

OpenMRS doesn't push events anywhere on its own. Pick one, set via
`ORDER_INGESTION_MODE`:

- **`push`** (needs an OpenMRS-side change): build an event listener module
  using OpenMRS's event/AOP hooks to POST newly created `ServiceRequest`s to
  OpenHIM's inbound channel. Nothing on the mediator side needs to change to
  support this — `POST /fhir/ServiceRequest` is already mounted and its auth
  is already mode-agnostic (it's the same endpoint `orderPoller.js` posts to
  for `poll` mode). The exact contract, so a module can be built against this
  without reading the mediator's source:

  - **Request**: `POST /fhir/ServiceRequest` on OpenHIM's router (see port/
    scheme note below), `Content-Type: application/fhir+json`. Body is either
    an order Bundle (the `ServiceRequest` with its `Patient`, `Practitioner`,
    `Encounter` and Visit, as `orderPoller.js` sends; see
    `src/lib/orderBundle.js`), or the minimal
    `{ "serviceRequestId": "<uuid>" }` form, for which `src/lib/orderRelay.js`
    fetches the order Bundle from OpenMRS in one request. The id form is there
    for exactly this kind of push module, and would likely be removed if push
    were implemented some other way. A bare `ServiceRequest` is rejected.
  - **Required headers** (that channel is `authType: "private"`, and the
    mediator's own route checks a second, independent secret):
    - `Authorization: Basic base64(OPENHIM_INBOUND_CLIENT_ID:OPENHIM_INBOUND_CLIENT_PASSWORD)`
      — OpenHIM Client credentials, from `.env`.
    - `X-Mediator-Secret: <MEDIATOR_INBOUND_SECRET>` — app-level backstop
      independent of OpenHIM, also from `.env`.
    - Both are the same values `orderPoller.js` already uses for the `poll`
      path — see `src/lib/orderPoller.js`'s `pollOnce()` for a working
      reference implementation of this exact contract.
  - **Responses**: `200 { status: 'ok', advapacsServiceRequestId }` on
    success; `401 { status: 'error', message: 'unauthorized' }` if either
    header is missing/wrong; `502 { status: 'error', message }` if the relay
    to AdvaPACS itself fails (e.g. patient resolution, AdvaPACS validation).
  - **Port/scheme**: if OpenMRS and this mediator are on the same Docker
    network (or otherwise mutually trusted), plain HTTP on port `5001`
    (default — see `OPENHIM_ROUTER_HTTP_HOST_PORT` in whatever's running the
    `openhim` service, e.g. a distro-tools instance's `env` file, if
    overridden) is fine. If OpenMRS is on a different, less-trusted host, use
    HTTPS on port `5000` (default — `OPENHIM_ROUTER_HTTPS_HOST_PORT`) instead
    — `5001` is plain HTTP and would send the credentials above in cleartext
    across that network. See "Running the full stack locally" below for what
    changes on this side to support that.
- **`poll`** (needs no OpenMRS-side change): `src/lib/orderPoller.js` already
  implements this — it calls
  `GET {OPENMRS_BASE_URL}/ws/fhir2/R4/ServiceRequest?_lastUpdated=gt...`
  on an interval (`ORDER_POLL_INTERVAL_MS`) and submits anything new to
  OpenHIM. Simpler to stand up and works today, at the cost of
  up-to-`ORDER_POLL_INTERVAL_MS` latency and missing anything created while
  the mediator was down (the poll cursor resets to "now" on restart, it
  isn't persisted). Note: some OpenMRS FHIR2 module versions don't support a
  `status` search parameter on `ServiceRequest` at all (confirmed via that
  endpoint's `metadata`) — this poller intentionally doesn't filter by
  `status` for that reason.

## Building the mediator image locally

```bash
./build-image.sh
```

Runs `npm test` first (aborting with no build on failure), then builds this
repo's `Dockerfile` into your local Docker image cache, tagged
`openhim-advapacs-mediator:local` by default (pass a different tag as `$1`).
Nothing is pushed anywhere. This just produces the image — it doesn't run or
register it against OpenHIM; see "Running the full stack locally" below for
that.

## Running the full stack locally (via distro-tools)

This repo only builds and publishes the mediator's own image
(`partnersinhealth/openhim-advapacs-mediator` — see `Dockerfile` and
`.github/workflows/ci.yml`); it doesn't bundle OpenHIM itself. To run the
whole stack (OpenHIM + this mediator, optionally alongside OpenMRS too), use
[`openmrs-contrib-distro-tools`](https://github.com/PIH/openmrs-contrib-distro-tools),
which has canonical service fragments for both (`docker/services/openhim.yaml`
and `docker/services/openhim-advapacs-mediator.yaml`). See distro-tools' own
README for the full `env` file reference — every
`OPENHIM_*`/`ADVAPACS_MEDIATOR_*`/`OPENMRS_*`/`ADVAPACS_*` var either fragment
reads, including the `OPENHIM_*_HOST_PORT` overrides for the published
ports below — plus the lifecycle commands (`start`/`stop`/`status`/`logs`/
`update`/`add-service`/`remove-service`/`destroy`) that apply to this stack
the same way they do to any other distro-tools-managed service.

There are two ways to get an OpenMRS instance into the picture:

### Bundled with OpenMRS

Add distro-tools' `openmrs-db`/`openmrs` fragments to `SERVICES` alongside
`openhim`/`openhim-advapacs-mediator`, and it stands up all four as one
Compose project on a shared network — the mediator's default
`OPENMRS_BASE_URL` (`http://openmrs:8080/openmrs`) already points at that
network's `openmrs` service, so you don't need to set it yourself:

```bash
export OPENMRS_IMAGE_NAME=<your OpenMRS distro image, e.g. partnersinhealth/lesotho-emr>
export OPENMRS_PIH_CONFIG=<PIH config profile for this instance, e.g. lesotho,lesotho-kol-ci>
export SEED_IMAGE_NAME=<optional -- a nightly seed image, to skip a slow first boot>
export OPENHIM_PASSWORD=<pick-a-password>
export OPENMRS_USERNAME=<username the mediator uses against OpenMRS's FHIR API>
export OPENMRS_PASSWORD=<password the mediator uses against OpenMRS's FHIR API>
export ADVAPACS_MEDIATOR_INBOUND_SECRET=<pick-a-secret>
export ADVAPACS_MEDIATOR_OPENHIM_INBOUND_CLIENT_PASSWORD=<pick-a-password>
export ADVAPACS_CLIENT_ID=<...>
export ADVAPACS_CLIENT_SECRET=<...>
export ADVAPACS_PATIENT_IDENTIFIER_SYSTEM="http://www.pih.org/identifiers/lesotho/emr-id"
export ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM="http://www.pih.org/identifiers/lesotho/provider-uuid"
export SERVICES=openmrs-db,openmrs,openhim,openhim-advapacs-mediator 

openmrs-docker create <name>
openmrs-docker <name> initialize   # optional, only if SEED_IMAGE_NAME is set -- skips the slow first boot
openmrs-docker <name> start
openmrs-docker <name> wait         # blocks until OpenMRS itself finishes starting
```

Once `wait` reports ready, OpenMRS itself is at `http://localhost:8080/openmrs`
(or whatever `OPENMRS_HTTP_PORT` you set).

### Connecting to a separately-running OpenMRS SDK instance

Alternatively, run OpenMRS on the host via the OpenMRS SDK (`openmrs-sdk`,
also part of distro-tools) instead of bundling it into the same Compose
project, and point the mediator at it. Useful when you're actively developing
against the distro itself and want the SDK's faster rebuild/redeploy cycle
rather than rebuilding a Docker image on every change:

```bash
# 1. Stand up OpenMRS itself via the SDK, from your distro checkout:
cd <path to your distro repo checkout>
PIH_CONFIG=<PIH config profile, e.g. lesotho,lesotho-kol-ci> openmrs-sdk create <server-id>
openmrs-sdk run <server-id>   # leave this running in its own terminal --
                               # Tomcat on localhost:8080 by default

# 2. Separately, bring up just OpenHIM + this mediator via distro-tools,
#    pointed at that host-based OpenMRS instance:
export OPENHIM_PASSWORD=<pick-a-password>
export OPENMRS_USERNAME=<username the mediator uses against OpenMRS's FHIR API>
export OPENMRS_PASSWORD=<password the mediator uses against OpenMRS's FHIR API>
export ADVAPACS_MEDIATOR_INBOUND_SECRET=<pick-a-secret>
export ADVAPACS_MEDIATOR_OPENHIM_INBOUND_CLIENT_PASSWORD=<pick-a-password>
export ADVAPACS_CLIENT_ID=<...>
export ADVAPACS_CLIENT_SECRET=<...>
export ADVAPACS_PATIENT_IDENTIFIER_SYSTEM="http://www.pih.org/identifiers/lesotho/emr-id"
export ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM="http://www.pih.org/identifiers/lesotho/provider-uuid"
export OPENMRS_BASE_URL=http://host.docker.internal:8080/openmrs
export SERVICES=openhim,openhim-advapacs-mediator 
openmrs-docker create <name>
openmrs-docker <name> start
```

`http://host.docker.internal:8080/openmrs` (rather than `localhost`) is
required because the mediator resolves `OPENMRS_BASE_URL` from inside its own
container — the fragment's `extra_hosts` entry makes `host.docker.internal`
resolve back to this machine. If the SDK server's `SERVER_PORT` isn't the
default `8080`, adjust the port to match.

### Rebuilding and redeploying after a code change

Build this repo's Dockerfile locally, tagged to match what your running
instance's fragment expects -- partnersinhealth/openhim-advapacs-mediator:latest

```bash
./build-image.sh partnersinhealth/openhim-advapacs-mediator:latest
openmrs-docker <name> start
openmrs-docker <name> logs openhim-advapacs-mediator   # confirm clean restart
```

### Monitoring the stack

Once it's up (either way):
- **Console UI**: `http://localhost:9000` (or whatever `OPENHIM_CONSOLE_HOST_PORT`
  you set), log in with `OPENHIM_USERNAME`/`OPENHIM_PASSWORD`.
- **Admin API**: `http://localhost:8081` (`OPENHIM_ADMIN_API_HOST_PORT`), plain
  HTTP. The console runs in your browser and calls this API directly, so both
  are published; on a server, reach them through its reverse proxy (which
  adds TLS) or an SSH tunnel (`ssh -L 8081:localhost:8081 -L
  9000:localhost:9000 <user>@<server>`).
- **OpenHIM's transaction log** (the actual FHIR request/response history for
  every push through the two channels) lives in the console UI above, or the
  admin API directly:
  ```bash
  curl -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'http://localhost:8081/transactions?filterLimit=10&filterPage=0'    # list
  curl -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'http://localhost:8081/transactions/<id>'                           # one transaction's full bodies
  ```
- **Channel/client provisioning**: on startup the mediator registers itself
  and `mediatorConfig.json` with OpenHIM core, activates its heartbeat, then
  automatically runs `scripts/setupOpenhim.js` to create/update the two
  order-push channels and the `openmrs` OpenHIM Client (idempotent, so it's
  safe on every boot — a failure here only logs a warning rather than
  stopping the mediator, and no separate one-shot provisioning step is
  needed). To force a re-provision without restarting the container (e.g.
  after only changing `mediatorConfig.json` or `ADVAPACS_BASE_URL`), run
  `node scripts/setupOpenhim.js` directly, with `.env`'s `OPENHIM_*` vars
  pointed at the running instance's admin API.
- **First run on a fresh instance**: OpenHIM core auto-seeds a
  `root@openhim.org` user with its built-in default password
  `openhim-password`, regardless of whatever `OPENHIM_PASSWORD` you set.

## Running tests

```bash
npm install
npm test
```

Unit tests only — every HTTP call (to OpenMRS, AdvaPACS/OpenHIM's outbound
channel) is mocked with Jest, so nothing needs to be running: no Docker, no
OpenHIM, no OpenMRS. Covers `orderRelay.js`, `advapacsClient.js`,
`openmrsClient.js`, `orderPoller.js`, `modalityMap.js`, `routes/serviceRequest.js`,
`routes/health.js`, `routes/advapacsWebhook.js` and `scripts/setupOpenhim.js`'s
Clients and channels. Does **not** cover `src/index.js`'s route-mounting/ingestion-mode
logic (no testable seam without a refactor) — see
`docs/superpowers/specs/2026-08-06-test-suite-design.md` for why.

## Files

```
mediatorConfig.json         OpenHIM mediator registration (endpoints, channels, config defs)
scripts/setupOpenhim.js     Idempotently creates/updates the two order-push channels and the webhook channel, plus the "openmrs" and AdvaPACS webhook OpenHIM Clients, via OpenHIM's API; run automatically by src/index.js on every boot, or standalone via `node scripts/setupOpenhim.js`
build-image.sh              Runs npm test, then builds this repo's Dockerfile into the local Docker image cache (no registry) -- see "Building the mediator image locally"
Dockerfile                  Mediator's own container image
src/index.js                Registration + server bootstrap + OpenHIM provisioning; always mounts the push endpoint, additionally starts the poller in 'poll' mode
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   Calls OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), not AdvaPACS directly; upsertPatient/upsertPractitioner, Organization/Location search and createServiceRequest
src/lib/orderRelay.js       Shared order-relay logic: upserts Patient first, then remaps ServiceRequest.subject to AdvaPACS's own Patient id and reshapes the rest of the ServiceRequest for AdvaPACS before pushing it
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll) -- submits via OpenHIM's inbound channel
src/lib/sharedSecretAuth.js Shared-secret Express middleware factory (crypto.timingSafeEqual compare) -- backs the inbound X-Mediator-Secret check
src/routes/serviceRequest.js       Inbound channel's target; always mounted regardless of ingestion mode; requires X-Mediator-Secret
src/routes/advapacsWebhook.js      Webhook channel's target; checks the AdvaPACS Client's Basic auth credentials, logs the event, then has resultHandler.js import it into OpenMRS
```

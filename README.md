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
     each one to that same OpenHIM inbound channel.
3. Either way, `routes/serviceRequest.js` hands off to `src/lib/orderRelay.js`,
   which resolves the OpenMRS `Patient` and, before touching the
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
4. AdvaPACS would perform/read the study, then fire its own FHIR
   `Subscription` (rest-hook) at `POST /webhooks/advapacs` on this mediator,
   carrying an `ImagingStudy` or `DiagnosticReport` — **this leg is currently
   disabled and untested end-to-end, see Known limitations.**
5. `src/routes/subscriptionWebhook.js` would write that resource into
   OpenMRS and flip the originating `ServiceRequest` to `completed` — it's a
   placeholder today, not yet functional (see Known limitations).

```
orderPoller.js (every ORDER_POLL_INTERVAL_MS)
  --HTTP POST--> OpenHIM inbound channel  ^/fhir/ServiceRequest$
    --routes to--> mediator's POST /fhir/ServiceRequest (routes/serviceRequest.js)
      --calls--> orderRelay.js (resolve patient, reshape ServiceRequest for AdvaPACS)
        --calls--> advapacsClient.js upsertPatient()          [1: Patient, first]
          --HTTP GET/POST/PUT--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
        --calls--> advapacsClient.js createServiceRequest()   [2: ServiceRequest, only if #1 succeeded]
          --HTTP POST--> OpenHIM outbound channel  ^/advapacs/.*$  (auto-retry enabled)
            --pathTransform strips /advapacs, routes to--> real AdvaPACS host
```

## What's real vs. stubbed

This scaffold wires up the transport, auth, and registration plumbing
end-to-end and will run. Two things are intentionally left as `TODO`s because
they need your actual data model, not boilerplate:

- **Identifier reconciliation** (`serviceRequest.js`, `subscriptionWebhook.js`):
  right now the AdvaPACS-side id returned on order push is only logged. You'll
  want a small lookup store (a table, or OpenHIM's own transaction/orchestration
  log) mapping OpenMRS `ServiceRequest.id` ↔ AdvaPACS `ServiceRequest.id`, so
  the webhook handler can find the right OpenMRS order to update instead of
  relying on `DiagnosticReport.basedOn` alone.
- **Location identifier mapping**: the patient side of this is resolved
  (`orderRelay.js` references the patient via AdvaPACS's own Patient id —
  see Flow), and `encounter`/`requester` (Practitioner) references are
  dropped from the outbound `ServiceRequest` entirely, since AdvaPACS can't
  resolve OpenMRS UUIDs for either. `Location` references aren't handled at
  all yet — confirm what AdvaPACS expects there if/when that becomes
  relevant.
- **Several other fields are temporarily hardcoded or reshaped** just to get
  a `ServiceRequest` past AdvaPACS's validation — accession-number
  identifier duplication (UHM-9437/9439/9440), an HL7 "PI" coding stamped
  onto the patient's EMR-ID identifier (UHM-9443), and the imaging modality
  hardcoded to X-ray/`CR` since OpenMRS doesn't expose it today (UHM-9445).
  See the `TODO`/`HACK`/`EXPERIMENT` comments in `orderRelay.js` for the
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
- **The AdvaPACS result-delivery path (webhook) is disabled and untested.**
  `src/routes/subscriptionWebhook.js` is a placeholder — written but never
  exercised against a real AdvaPACS webhook delivery, since all effort so
  far has gone into the outbound order-push path. It isn't mounted in
  `src/index.js`, `advapacsClient.js`'s `ensureSubscription` isn't called on
  startup, and its channel/endpoint entries have been removed from
  `mediatorConfig.json`. Each disabled spot is marked with a matching
  comment — re-enable all three once this path is ready to test.
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
  disproportionate here. The actual compensating control is network isolation
  instead: whatever's running this stack (e.g. distro-tools' `openhim`
  service fragment) binds OpenHIM's router/admin API/console ports to
  `127.0.0.1` only, so nothing outside that Docker Compose project can reach
  this channel regardless of its `authType`. This holds even on a host
  shared with other apps — a compromised *container* elsewhere doesn't grant
  access to our loopback-bound ports or our instance's own Docker network on
  its own (each Compose project gets its own isolated bridge network by
  default). Revisit this reasoning only if this host's trust model changes —
  e.g. it becomes genuinely multi-tenant with untrusted operators, or any
  co-located app runs with `network_mode: host` or gets explicitly connected
  to this instance's network. A PIH-controlled shared host running other PIH
  apps under normal Docker Compose isolation doesn't change this calculus.

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
    a full `ServiceRequest` FHIR resource, or the minimal
    `{ "serviceRequestId": "<uuid>" }` form (`src/lib/orderRelay.js` fetches
    the full resource from OpenMRS itself in that case).
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
and `docker/services/openmrs-advapacs-mediator.yaml`):

```bash
export OPENHIM_PASSWORD=<pick-a-password>
export ADVAPACS_MEDIATOR_INBOUND_SECRET=<pick-a-secret>
export OPENMRS_BASE_URL=<your OpenMRS FHIR base URL>
export ADVAPACS_BASE_URL=https://usa1.api.integration.advapacs.com/fhir/R5
export ADVAPACS_CLIENT_ID=<...>
export ADVAPACS_CLIENT_SECRET=<...>
# to build this mediator's image from a local checkout instead of pulling
# the published one, also set:
export ADVAPACS_MEDIATOR_SOURCE_DIR=<path to this repo>

SERVICES=openhim,openmrs-advapacs-mediator openmrs-docker create <name> --build
openmrs-docker <name> start
```

See distro-tools' own README for the full `env` file reference — every
`OPENHIM_*`/`ADVAPACS_MEDIATOR_*`/`OPENMRS_*`/`ADVAPACS_*` var this fragment
reads, including the four `OPENHIM_*_HOST_PORT` overrides for the loopback
ports below — plus the lifecycle commands (`start`/`stop`/`status`/`logs`/
`update`/`add-service`/`remove-service`/`destroy`) that apply to this stack
the same way they do to any other distro-tools-managed service.

Once it's up:
- **Console UI**: `http://127.0.0.1:9000` (or whatever `OPENHIM_CONSOLE_HOST_PORT`
  you set), log in with `OPENHIM_USERNAME`/`OPENHIM_PASSWORD`.
- **Admin API**: `https://127.0.0.1:8081` (`OPENHIM_ADMIN_API_HOST_PORT`).
  Both are bound to `127.0.0.1` only by the `openhim` fragment, not reachable
  from the LAN/internet — use an SSH tunnel (`ssh -L 8081:127.0.0.1:8081 -L
  9000:127.0.0.1:9000 <user>@<server>`) if this is running somewhere other
  than your own machine.
- **OpenHIM's transaction log** (the actual FHIR request/response history for
  every push through the two channels) lives in the console UI above, or the
  admin API directly:
  ```bash
  curl -k -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'https://127.0.0.1:8081/transactions?filterLimit=10&filterPage=0'   # list
  curl -k -u "$OPENHIM_USERNAME:$OPENHIM_PASSWORD" \
    'https://127.0.0.1:8081/transactions/<id>'                          # one transaction's full bodies
  ```
- **Channel/client provisioning** (this mediator's `scripts/setupOpenhim.js`)
  now runs automatically on every boot of the mediator container — no
  separate one-shot step. See "Running registered with OpenHIM core (no
  Docker)" below for exactly what it does and how to re-run it on demand.
- **First run on a fresh instance**: OpenHIM core auto-seeds a
  `root@openhim.org` user with its built-in default password
  `openhim-password`, regardless of whatever `OPENHIM_PASSWORD` you set.
  `scripts/setupOpenhim.js` no longer rotates this itself — that's handled by
  distro-tools now.

## Running locally without OpenHIM core

```bash
cp .env.example .env      # fill in real credentials, set MEDIATOR_STANDALONE=true
npm install
npm start
```

Skips OpenHIM entirely. In `poll` mode this means `orderPoller.js`'s POST to
`OPENHIM_ROUTER_URL` will fail (nothing listening) — useful for exercising the
OpenMRS-polling side in isolation, not the full relay.

Since this runs directly on the host (not in a container), `OPENMRS_BASE_URL`
needs a value reachable from the host itself — `http://localhost:8080/openmrs`
if OpenMRS is local, not `http://host.docker.internal:...` (that hostname only
resolves inside a Docker container). If you're switching between this and the
distro-tools-based flow above with OpenMRS on the same machine, you'll need
to change this value each time.

## Running registered with OpenHIM core (no Docker)

```bash
cp .env.example .env      # set OPENHIM_* vars to point at your instance
npm install
npm start
```

On startup the mediator registers itself and `mediatorConfig.json` with
OpenHIM core, activates its heartbeat, then automatically runs
`scripts/setupOpenhim.js` to create/update the two order-push channels and
the `openmrs` OpenHIM Client (idempotent, so it's safe on every boot — a
failure here only logs a warning rather than stopping the mediator). (It
used to also register a FHIR `Subscription` with AdvaPACS pointed at its own
webhook URL on startup, but that's currently disabled along with the rest of
the result-delivery path — see Known limitations.) Make sure
`OPENHIM_ROUTER_URL`/`ADVAPACS_CHANNEL_URL` in `.env` point at wherever that
OpenHIM instance's router actually is. To force a re-provision without
restarting the mediator (e.g. after only changing `mediatorConfig.json` or
`ADVAPACS_BASE_URL`), run `node scripts/setupOpenhim.js` directly.

## Running tests

```bash
npm install
npm test
```

Unit tests only — every HTTP call (to OpenMRS, AdvaPACS/OpenHIM's outbound
channel) is mocked with Jest, so nothing needs to be running: no Docker, no
OpenHIM, no OpenMRS. Covers `orderRelay.js`, `advapacsClient.js`,
`openmrsClient.js`, `orderPoller.js`, and `routes/serviceRequest.js`. Does
**not** cover `src/index.js`'s route-mounting/ingestion-mode logic (no
testable seam without a refactor) or `subscriptionWebhook.js` — see
`docs/superpowers/specs/2026-08-06-test-suite-design.md` for why.

## Files

```
mediatorConfig.json         OpenHIM mediator registration (endpoints, channels, config defs)
scripts/setupOpenhim.js     Idempotently creates/updates the two order-push channels + the "openmrs" OpenHIM Client via OpenHIM's API; run automatically by src/index.js on every boot, or standalone via `node scripts/setupOpenhim.js`
build-image.sh              Runs npm test, then builds this repo's Dockerfile into the local Docker image cache (no registry) -- see "Building the mediator image locally"
Dockerfile                  Mediator's own container image
src/index.js                Registration + server bootstrap + OpenHIM provisioning; always mounts the push endpoint, additionally starts the poller in 'poll' mode
src/lib/openmrsClient.js    OpenMRS FHIR2 client (read/search ServiceRequest/Patient, write results)
src/lib/advapacsClient.js   Calls OpenHIM's outbound channel (ADVAPACS_CHANNEL_URL), not AdvaPACS directly; upsertPatient + createServiceRequest (+ ensureSubscription, currently unused -- see Known limitations)
src/lib/orderRelay.js       Shared order-relay logic: upserts Patient first, then remaps ServiceRequest.subject to AdvaPACS's own Patient id and reshapes the rest of the ServiceRequest for AdvaPACS before pushing it
src/lib/orderPoller.js      Poll-based ingestion (ORDER_INGESTION_MODE=poll) -- submits via OpenHIM's inbound channel
src/lib/sharedSecretAuth.js Shared-secret Express middleware factory (crypto.timingSafeEqual compare) -- backs the inbound X-Mediator-Secret check
src/routes/serviceRequest.js       Inbound channel's target; always mounted regardless of ingestion mode; requires X-Mediator-Secret
src/routes/subscriptionWebhook.js  PLACEHOLDER result webhook handler -- not yet functional/tested, currently disabled (see Known limitations)
```

# Sending the order's site to AdvaPACS — design

Date: 2026-10-30

## Why

AdvaPACS's Organisations & Sites feature is now on in the sandbox. An Organisation is a group of
Sites; a Site is one facility (docs: https://docs.advapacs.com/configuration/organisations). Over
FHIR R5 a Site is a `Location` (with `managingOrganization`) and an Organisation is an
`Organization`; both are read/search only and are set up by hand in AdvaPACS admin.

Orders should arrive in AdvaPACS filed under the facility they came from. Today the mediator sends
no location at all, and strips `ServiceRequest.encounter` — the only path to one.

What's in the sandbox now (2026-10-30):

| AdvaPACS | identifier | id |
|---|---|---|
| Organization "Lesotho Demo" | `LS-DM` | `01a18e20-5688-7015-a71a-89408f77287a` |
| Location "Botsabelo" | `LS-DM-BOTS` | `01a18e28-2458-71e8-a116-4027b134bbdb` |
| Location "Motebang" | `LS-DM-MOTE` | `01a18e28-b274-7d85-b133-cc08117e3591` |
| Location "Unknown" | `LS-DM-UNK` | `01a18e20-568a-7ba5-9e69-4a53f273c33a` |

Identifiers carry a `value` only, no `system`. `GET /Location?identifier=LS-DM-BOTS` finds the Site
(exact case only). "DM" means demo: a production AdvaPACS setup will use different codes (likely
`LS-BOTS`, `LS`), so the codes are per-deployment config, not something the code knows.

The "Unknown" Site is not used by the mediator.

## Goals

- Every relayed ServiceRequest carries `locationReference` pointing at the AdvaPACS Site for the
  OpenMRS Visit Location the order was placed under.
- An order whose Site can't be determined is held (hard error), never sent without a site or under
  a catch-all Site. On kol-ci today, that means orders from Ntsekhe and Community are held until
  they're mapped.
- Demo and production differ only in config (each deployment's env file), with no demo/prod flag
  in code.

## Non-goals

- Sending `performer` (Organization). The Site already belongs to one Organisation; we don't know
  whether AdvaPACS uses `performer`.
- Matching Sites by name, or storing Site codes on OpenMRS locations. A config map for now.
- Creating Sites or Organisations in AdvaPACS (not possible over FHIR).
- Backfilling sites onto orders already in AdvaPACS.

## Anti-goals

- An order silently filed under the wrong facility, or under another Organisation's Site (e.g. a
  demo mediator pointed at production codes).
- An order silently sent with no site because of a config mistake.

## Where the location comes from in OpenMRS

FHIR2 doesn't set `ServiceRequest.locationReference`. The location is reachable only through the
encounter:

`ServiceRequest.encounter` → `GET Encounter/{id}` → `location[0].location.reference` →
`GET Location/{id}` → follow `partOf` upward until a Location whose `meta.tag` has
`system: http://fhir.openmrs.org/ext/location-tag`, `code: Visit Location`.

Checked on the local Lesotho instance: encounter location "Motebang HDU" → `partOf` "Motebang"
(`873e70ff-a3b4-4656-a9e5-cfe11d6470cd`, tagged Visit Location). The Visit Location uuids ship in
the Lesotho distro (`lesotho-emr`'s `locations.csv`; Botsabelo is
`14301646-9256-4b8a-85aa-74bb720b5b43`), so the uuid side of the map is the same on every Lesotho
instance.

The encounter location itself may already be the Visit Location (check the starting Location's own
tags before walking up).

## Configuration

| Mediator env var | Example (demo) | Meaning |
|---|---|---|
| `ADVAPACS_SITE_MAP` | `14301646-9256-4b8a-85aa-74bb720b5b43=LS-DM-BOTS,873e70ff-a3b4-4656-a9e5-cfe11d6470cd=LS-DM-MOTE` | OpenMRS Visit Location uuid → AdvaPACS Site identifier |
| `ADVAPACS_ORGANIZATION` | `LS-DM` | Organisation identifier; Sites are only accepted from this Organisation (optional) |

These are AdvaPACS business config, so — like `ADVAPACS_PATIENT_IDENTIFIER_SYSTEM` — they use the
same unprefixed names in the instance env file and in the container.

`ADVAPACS_SITE_MAP` turns the feature on. If it's unset, the mediator behaves exactly as today (no
`locationReference`, no extra calls). `ADVAPACS_ORGANIZATION` set without `ADVAPACS_SITE_MAP` is a
config mistake and stops the mediator at startup. *(My call.)*

## Behaviour

Resolving a Site identifier to an AdvaPACS Location id:

- With `ADVAPACS_ORGANIZATION` set: resolve it first via `GET /Organization?identifier=<code>`,
  then look Sites up with `GET /Location?identifier=<code>&organization=Organization/<org id>`.
- Without it: `GET /Location?identifier=<code>`.
- Each Location returned is also checked for a `managingOrganization` matching the Organisation, in
  case AdvaPACS ignores the `organization` search parameter. A Site from another Organisation
  counts as not found. *(Builder-check call.)*
- Resolved ids (Organisation and Sites) are cached in memory for the life of the process. Failed
  lookups are not cached, so a fix in AdvaPACS admin takes effect without a restart.
- The new searches go through the existing OpenHIM outbound channel (`^/advapacs/.*$`), which
  already allows GET, so `mediatorConfig.json` needs no change.

Per order (with `ADVAPACS_SITE_MAP` set):

1. Find the Visit Location uuid as above.
2. Look it up in `ADVAPACS_SITE_MAP`.
3. Resolve the Site code and set `locationReference: [{ reference: "Location/<advapacs id>" }]`.

Any step failing is a hard error: the relay throws with a message naming the reason and the
OpenMRS/AdvaPACS ids or codes involved, nothing is sent to AdvaPACS (not even the
Patient/Practitioner upserts), and the order shows as a failed transaction in OpenHIM. Specifically:

- No `ServiceRequest.encounter`, or the encounter has no location.
- No location tagged Visit Location in the `partOf` chain, or the walk hits its depth cap (a cycle
  in OpenMRS data).
- A failed OpenMRS read in the walk (`GET Encounter`/`GET Location`: 404, 5xx, timeout, auth).
- The Visit Location isn't in `ADVAPACS_SITE_MAP`.
- `ADVAPACS_ORGANIZATION` is set but no Organization has that identifier.
- The mapped Site code doesn't resolve (within the Organisation, if one is set), or matches more
  than one Location. *(Builder-check call for the second.)*
- `ADVAPACS_SITE_MAP` is malformed (checked when the relay module loads, so the mediator fails at
  startup). Malformed means: an entry without exactly one `=`, an empty uuid or code, or the same
  uuid twice. Whitespace around entries is trimmed. *(Builder-check call.)*

Because the Site is worked out before anything is sent to AdvaPACS, a hard error leaves AdvaPACS
untouched; fixing the config (or OpenMRS data) and re-running the transaction in OpenHIM relays the
order cleanly.

## Changes by repo

**This repo (new branch off `main`)**

- `src/lib/orderRelay.js`: resolve the site before the Patient upsert; add `locationReference` to
  the outbound ServiceRequest. Keep `encounter` stripped from the outbound order.
- `src/lib/advapacsClient.js`: Organization and Location search functions, following the
  `upsertPatient`/`upsertPractitioner` style.
- OpenMRS reads use the existing `openmrs.getResource`.
- Tests alongside the existing ones in `test/lib/`.
- `.env.example` and README: document the two variables.

**distro-tools** (`docker/services/openhim-advapacs-mediator.yaml`): pass the two variables
through, with empty defaults in `openhim-advapacs-mediator.env.defaults` (the fragment's existing
convention), so instances that don't set them still start.

**puppet** (`mirebalais-modules/openmrs_docker/manifests/service/openmrs_advapacs_mediator.pp`):
new parameters `$site_map` (a Hash of Visit Location uuid → Site code, default `{}`) and
`$organization` (default `undef`), rendered into the env file via `openmrs_docker::env_lines` (the
hash joined as `uuid=code,uuid=code`; an empty hash renders as `''`). In `manifests/site.pp`, the
`kol-ci` block sets Botsabelo → `LS-DM-BOTS`, Motebang → `LS-DM-MOTE`, organization `LS-DM`.
Update the module README's mediator example.

## Left to the builder

- Function names and module layout within `orderRelay.js`/`advapacsClient.js`.
- A cap on the `partOf` walk to guard against cycles (a small fixed depth is fine).
- Exact log wording.

## Open questions for AdvaPACS (not blocking)

- With the feature on, is a ServiceRequest without `locationReference` rejected?
- How do existing orders and studies get a site?

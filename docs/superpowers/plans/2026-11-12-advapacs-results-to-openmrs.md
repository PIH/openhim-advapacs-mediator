# AdvaPACS Results to OpenMRS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn AdvaPACS `STUDY_CREATED` / `REPORT_*` webhook events into radiologyapp Radiology Study and Radiology Report encounters in OpenMRS.

**Architecture:** radiologyapp gets two import methods on `RadiologyService` (all the rules: order lookup, patient check, idempotency) and a thin REST controller in front of them. The mediator reads the referenced FHIR resources from AdvaPACS, maps them to an import request, and POSTs it to that controller through a new private OpenHIM channel. It handles events one at a time.

**Tech Stack:** radiologyapp: Java 8, OpenMRS 2.6.0, Spring MVC, webservices.rest (provided), JUnit 4 + `BaseModuleContextSensitiveTest`, Mockito. Mediator: Node, Express, axios, Jest, supertest.

**Spec:** `docs/superpowers/specs/2026-11-10-advapacs-results-to-openmrs-design.md` (this repo). Read it first.

**Repos and branches:** Both repos use branch `LSO-209`, with commit messages prefixed `LSO-209: `.
- radiologyapp: `/home/mgoodrich/development/openmrs/modules/radiologyapp`, branched from `master`.
- Mediator: `/home/mgoodrich/development/openmrs/integrations/omrs-advapacs-mediator`, existing branch `LSO-209`.

## Global Constraints

- **No patient details in any log** (mediator or OpenMRS). Log ids, types, statuses, accession numbers, outcomes and field *names* only. Never names, identifier values, or report text.
- **Encounter location is always radiologyapp's unknown location.** Never the order's location.
- **Never match a provider by name.** Use only the Practitioner identifier with system `ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM` (kol-ci: `http://www.pih.org/identifiers/lesotho/provider-uuid`), whose value is an OpenMRS provider UUID. Anything else means the unknown provider.
- **Accession numbers:** use only the identifier with `system` equal to `ADVAPACS_ACCESSION_NUMBER_SYSTEM` (default `http://www.pih.org/identifiers/lesotho/radiology-accession-number`). Never a bare value.
- **Report statuses:** `final` → *final*; `amended` or `corrected` → *correction*; anything else is ignored.
- **A final report never changes:** a second *final* for an order is `ALREADY_EXISTS`.
- **The mediator responds 200** for handled or deliberately skipped events, and 5xx only when AdvaPACS or OpenMRS couldn't be reached or failed.
- **The order poller and the existing `openmrsClient.js` calls stay direct.** They don't go through the new channel.
- **radiologyapp** keeps Java 8 source level and the existing code style (4 spaces, `log` via commons-logging).

## Review Focus

1. **A burst of `REPORT_UPDATED` events for one signed report.** AdvaPACS sends several within about a second, and all of them read `final`. Expected: exactly one *final* report. radiologyapp's `synchronized` releases its lock before the transaction commits, so it isn't enough on its own; the mediator's serial queue (Task 9) must guarantee this. Test: `handles concurrent final events for one report as one create` in Task 9.
2. **`issued` with milliseconds or a timezone offset, replayed.** Expected: a replayed *correction* is `ALREADY_EXISTS`, not a second correction. Test: `importRadiologyReport_shouldTreatCorrectionWithSameSecondAsExisting` in Task 2.
3. **AdvaPACS resources missing optional fields:** no `presentedForm`, no `series`, no `subject`, or an identifier without `type`. Expected: skipped with a warning, never a crash or a 500. Tests in Task 8: `returns a skip reason when the report has no text` and `ignores identifiers without a system`.
4. **AdvaPACS answers 404 for the referenced resource.** Expected: skip with a warning and a 200; a 500 would make every retry fail the same way. Test: `skips with 200 when AdvaPACS has no such resource` in Task 9.
5. **A Practitioner identifier naming a provider UUID that doesn't exist or is retired.** Expected: the unknown provider, not a 400. Test: `importRadiologyStudy_shouldUseUnknownProviderWhenTechnicianUuidUnknown` in Task 1.

---

## radiologyapp

### Task 1: Import a Radiology Study

**Files:**
- Create: `api/src/main/java/org/openmrs/module/radiologyapp/importer/RadiologyImportResult.java`
- Create: `api/src/main/java/org/openmrs/module/radiologyapp/importer/RadiologyStudyImportRequest.java`
- Modify: `api/src/main/java/org/openmrs/module/radiologyapp/RadiologyService.java`
- Modify: `api/src/main/java/org/openmrs/module/radiologyapp/RadiologyServiceImpl.java`
- Modify: `api/src/main/resources/moduleApplicationContext.xml`, adding `providerService` and `patientService` to `RadiologyServiceImpl`
- Test: `api/src/test/java/org/openmrs/module/radiologyapp/RadiologyImportComponentTest.java` (new; `extends BaseModuleContextSensitiveTest`, same setup as `RadiologyServiceComponentTest`, dataset `radiologyServiceComponentTestDataset.xml`)

**Interfaces:**
- Produces:
  - `RadiologyImportResult`:
    - `enum Outcome { CREATED, ALREADY_EXISTS, NO_MATCHING_ORDER, PATIENT_MISMATCH }`
    - fields `Outcome outcome`, `String encounterUuid` (null unless CREATED), `boolean studyCreated` (report import only)
    - static factories `created(String encounterUuid)`, `of(Outcome)`
    - Lombok `@Data`
  - `RadiologyStudyImportRequest` (Lombok `@Data`):
    - `String accessionNumber`
    - `Date datePerformed`
    - `Boolean imagesAvailable` (nullable)
    - `String technicianProviderUuid` (nullable)
    - `String patientIdentifierTypeUuid`
    - `String patientIdentifier`
  - `RadiologyService.importRadiologyStudy(RadiologyStudyImportRequest request): RadiologyImportResult`. Throws `IllegalArgumentException` when `accessionNumber`, `datePerformed`, `patientIdentifierTypeUuid` or `patientIdentifier` is blank, or the identifier type UUID is unknown.

- [ ] **Step 1: Write the failing tests** in `RadiologyImportComponentTest`. Order `12345` (patient 6) is the radiology order in the dataset. Take the identifier from `patientService.getPatient(6).getPatientIdentifier()`, using its type's UUID and its value.
  - `importRadiologyStudy_shouldCreateStudyForOrder`:
    - outcome `CREATED`, with a non-null `encounterUuid`
    - the encounter's location is `radiologyProperties.getUnknownLocation()`
    - the technician-role provider is `getUnknownProvider()`
    - `getRadiologyStudyByOrderNumber("12345")` has the given `datePerformed` and `imagesAvailable = true`
  - `importRadiologyStudy_shouldReturnAlreadyExistsForSecondStudy`: a second call → `ALREADY_EXISTS`, and still one study encounter.
  - `importRadiologyStudy_shouldReturnNoMatchingOrderForUnknownAccession`: accession `"nope"` → `NO_MATCHING_ORDER`, no encounter.
  - `importRadiologyStudy_shouldReturnNoMatchingOrderForNonRadiologyOrder`: accession `"99999"` → `NO_MATCHING_ORDER`.
  - `importRadiologyStudy_shouldReturnPatientMismatchWhenIdentifierDiffers`: identifier value `"WRONG"` → `PATIENT_MISMATCH`, no encounter.
  - `importRadiologyStudy_shouldUseTechnicianWhenProviderUuidExists`: the UUID of provider 1 in the dataset → that provider in the technician role.
  - `importRadiologyStudy_shouldUseUnknownProviderWhenTechnicianUuidUnknown`: a random UUID → `CREATED`, with the unknown provider.
  - `importRadiologyStudy_shouldRejectMissingDatePerformed`: `@Test(expected = IllegalArgumentException.class)`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `mvn -q -pl api test -Dtest=RadiologyImportComponentTest`
  Expected: a compilation failure, because `importRadiologyStudy` doesn't exist yet.

- [ ] **Step 3: Implement `importRadiologyStudy`** in `RadiologyServiceImpl` as `@Transactional public synchronized`, in this order:
  1. Validate the request.
  2. Look up the order with `getRadiologyOrderByOrderNumber`. If there's none, log a `log.warn` (accession number and outcome only) and return `NO_MATCHING_ORDER`.
  3. Patient check (`patientMatches`, shared with Task 2): the order's patient must have a non-voided identifier of that type with exactly that value. If not, log a `log.warn` (accession and outcome only, never the identifier) and return `PATIENT_MISMATCH`.
  4. If a study *encounter* already exists for the order number (the same `emrEncounterDAO.getEncountersByObsValueText` query `validate(RadiologyStudy)` uses), log a `log.warn` and return `ALREADY_EXISTS`. Don't use `getRadiologyStudyByOrderNumber`: it also derives studies from reports.
  5. Otherwise build a `RadiologyStudy`:
     - order, order number, patient and procedure (`order.getConcept()`) from the order
     - the given `datePerformed`, truncated to whole seconds
     - the given `imagesAvailable`
     - the technician from `providerService.getProviderByUuid`, only if it isn't retired; otherwise leave it null so the unknown provider is used
     - no location, so the unknown location is used
  6. Call `saveRadiologyStudy` and return `created(encounter.getUuid())`.

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `mvn -q -pl api test -Dtest=RadiologyImportComponentTest`
  Expected: `Tests run: 8, Failures: 0, Errors: 0`. Then run `mvn -q -pl api test` and expect all existing tests to still pass.

- [ ] **Step 5: Commit** with the message `LSO-209: Import a radiology study by accession number`.

### Task 2: Import a Radiology Report

**Files:**
- Create: `api/src/main/java/org/openmrs/module/radiologyapp/importer/RadiologyReportImportRequest.java`
- Modify: `RadiologyService.java`, `RadiologyServiceImpl.java`
- Test: `RadiologyImportComponentTest.java`

**Interfaces:**
- Consumes: `RadiologyImportResult`, `patientMatches` and the study-encounter check, all from Task 1.
- Produces:
  - `RadiologyReportImportRequest` (Lombok `@Data`):
    - `String accessionNumber`
    - `Date reportDate`
    - `String reportType`, either `"final"` or `"correction"`
    - `String reportBody`
    - `String radiologistProviderUuid` (nullable)
    - `Date datePerformed` (nullable; used only if the study has to be created)
    - `String patientIdentifierTypeUuid`
    - `String patientIdentifier`
  - `RadiologyService.importRadiologyReport(RadiologyReportImportRequest request): RadiologyImportResult`. Throws `IllegalArgumentException` when a required field is blank or `reportType` isn't `final` or `correction`.

- [ ] **Step 1: Write the failing tests.** All use order `12345` unless noted.
  - `importRadiologyReport_shouldCreateFinalReportAndStudy`:
    - outcome `CREATED`, `studyCreated = true`
    - one report, whose type concept is the `Radiology report final` concept, with the given body and the unknown location
    - a study encounter now exists, with `datePerformed` equal to the request's `datePerformed`
  - `importRadiologyReport_shouldUseReportDateForCreatedStudyWhenNoDatePerformed`
  - `importRadiologyReport_shouldNotCreateStudyWhenOneExists`: `studyCreated = false`
  - `importRadiologyReport_shouldReturnAlreadyExistsForSecondFinal`: a second *final* with a different date and body → `ALREADY_EXISTS`, and still one report.
  - `importRadiologyReport_shouldCreateCorrectionAfterFinal`: type is the `Radiology report correction` concept.
  - `importRadiologyReport_shouldTreatCorrectionWithSameSecondAsExisting`: two corrections whose `reportDate` differs only in milliseconds (e.g. `…:05.120` and `…:05.980`) → the second is `ALREADY_EXISTS`.
  - `importRadiologyReport_shouldCreateSecondCorrectionWithLaterDate`: one second later → `CREATED`.
  - `importRadiologyReport_shouldUseRadiologistWhenProviderUuidExists`: provider 1 in the principal-results-interpreter role.
  - `importRadiologyReport_shouldReturnNoMatchingOrderAndPatientMismatch`: as in Task 1.
  - `importRadiologyReport_shouldRejectUnknownReportType`: `"preliminary"` → `IllegalArgumentException`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `mvn -q -pl api test -Dtest=RadiologyImportComponentTest`
  Expected: a compilation failure, because `importRadiologyReport` doesn't exist yet.

- [ ] **Step 3: Implement `importRadiologyReport`** (`@Transactional public synchronized`):
  1. Validate the request, then do the order lookup and patient check as in Task 1.
  2. Truncate `reportDate` to whole seconds.
  3. Look up the report type concept with `conceptService.getConceptByMapping(CONCEPT_CODE_RADIOLOGY_REPORT_FINAL or _CORRECTION, EmrApiConstants.EMR_CONCEPT_SOURCE_NAME)`, the source `RadiologyReportConceptSet` uses.
  4. Duplicate checks, using `getRadiologyReportsByOrderNumber`:
     - *final*: any existing report of type final → `ALREADY_EXISTS`
     - *correction*: an existing correction whose `reportDate` (in seconds) equals the request's → `ALREADY_EXISTS`
     - log a `log.warn` either way
  5. If no study encounter exists, create one first by calling `importRadiologyStudy` with `datePerformed` (or `reportDate` if that's null), no `imagesAvailable` and no technician. Set `studyCreated = true`.
  6. Build a `RadiologyReport`: order, patient, procedure, the radiologist (only if not retired), the type, the body and the date; then call `saveRadiologyReport`.

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `mvn -q -pl api test`
  Expected: all tests pass.

- [ ] **Step 5: Commit** with the message `LSO-209: Import a final or correction radiology report`.

### Task 3: The REST endpoint

**Files:**
- Modify: `pom.xml`. Add the property `<webservicesRestVersion>2.42.0</webservicesRestVersion>` (the version coreapps 3.0.0, already a required module, builds against), and `webservices.rest-omod` with scope `provided` in `dependencyManagement`, as in `modules/metadatamapping/pom.xml`.
- Modify: `omod/pom.xml`, adding the `webservices.rest-omod` provided dependency.
- Modify: `omod/src/main/resources/config.xml`. Add `<require_module version="${webservicesRestVersion}">org.openmrs.module.webservices.rest</require_module>`, and a privilege `Task: org.openmrs.module.radiologyapp.importResults` ("Create radiology studies and reports from an external PACS").
- Create: `omod/src/main/java/org/openmrs/module/radiologyapp/web/controller/RadiologyImportRestController.java`
- Test: `omod/src/test/java/org/openmrs/module/radiologyapp/web/controller/RadiologyImportRestControllerTest.java` (Mockito unit test; mock `RadiologyService`)

**Interfaces:**
- Consumes: `importRadiologyStudy` and `importRadiologyReport` from Tasks 1 and 2.
- Produces (what the mediator calls):
  - `POST /ws/rest/v1/radiologyapp/study`, with a JSON body:
    `{accessionNumber, datePerformed, imagesAvailable?, technicianProviderUuid?, patientIdentifierTypeUuid, patientIdentifier}`
  - `POST /ws/rest/v1/radiologyapp/report`, with a JSON body:
    `{accessionNumber, reportDate, reportType, reportBody, radiologistProviderUuid?, datePerformed?, patientIdentifierTypeUuid, patientIdentifier}`
  - Dates are ISO 8601 strings with an offset.
  - Response `200 {"outcome": "CREATED"|"ALREADY_EXISTS"|"NO_MATCHING_ORDER"|"PATIENT_MISMATCH", "encounterUuid": …, "studyCreated": …}`
  - `400 {"error": "<message>"}` for `IllegalArgumentException` or an unparseable date
  - `401`/`403` from webservices.rest for an unauthenticated or unprivileged user

- [ ] **Step 1: Write the failing tests.**
  - `postStudy_shouldPassParsedRequestToServiceAndReturnOutcome`:
    - `datePerformed: "2026-11-10T21:21:19.000+00:00"` becomes that instant in the `RadiologyStudyImportRequest`
    - the response map has `outcome = "CREATED"`
  - `postReport_shouldReturn400ForIllegalArgument`: the service throws → status 400, and the body has `error`.
  - `postStudy_shouldReturn400ForBadDate`: `"yesterday"` → 400.
  - `postStudy_shouldRequireImportResultsPrivilege`: the method calls `Context.requirePrivilege("Task: org.openmrs.module.radiologyapp.importResults")` (verify with a `Context` that lacks it, or check for `@Authorized` on the handler; use whichever the module's test setup supports).

- [ ] **Step 2: Run them and see them fail.**
  Run: `mvn -q test -Dtest=RadiologyImportRestControllerTest`
  Expected: a compilation failure.

- [ ] **Step 3: Implement `RadiologyImportRestController extends BaseRestController`**, following the pattern of `modules/queue/.../QueueEntryTransitionRestController.java`:
  - `@RequestMapping(value = "/rest/" + RestConstants.VERSION_1 + "/radiologyapp/study", method = POST) @ResponseBody Object postStudy(@RequestBody Map<String, Object> body)`, and `postReport` the same way.
  - Parse dates with `ConversionUtil.convert(value, Date.class)`; a null result is a 400.
  - An `@ExceptionHandler(IllegalArgumentException.class)` returns 400 with `{"error": message}`.
  - Get the service with `Context.getService(RadiologyService.class)`.

- [ ] **Step 4: Run the tests and see them pass, then build.**
  Run: `mvn -q test -Dtest=RadiologyImportRestControllerTest`, then `mvn -q clean install`.
  Expected: PASS, and `omod/target/radiologyapp-2.0.0-SNAPSHOT.omod` exists.

- [ ] **Step 5: Commit** with the message `LSO-209: REST endpoints to import radiology studies and reports`.

---

## Mediator

### Task 4: Accession and identifier helpers

**Files:**
- Create: `src/lib/identifiers.js`
- Modify: `src/lib/orderRelay.js`, so `ACCESSION_NUMBER_SYSTEM` comes from `identifiers.accessionNumberSystem()`
- Modify: `.env.example`, adding `ADVAPACS_ACCESSION_NUMBER_SYSTEM=http://www.pih.org/identifiers/lesotho/radiology-accession-number` with a comment
- Test: `test/lib/identifiers.test.js`, plus `test/lib/orderRelay.test.js` (which must still pass)

**Interfaces:**
- Produces:
  - `accessionNumberSystem(): string`: the env value, or the default above.
  - `identifierValue(resource, system): string | undefined`: the `value` of the first `resource.identifier[]` whose `system === system`.
  - `accessionNumber(resource): string | undefined`: `identifierValue(resource, accessionNumberSystem())`.

- [ ] **Step 1: Write the failing tests:**
  - `returns the accession with our system`
  - `ignores an ACSN identifier with another system` (same value, system `urn:other` → `undefined`)
  - `ignores identifiers without a system`
  - `uses ADVAPACS_ACCESSION_NUMBER_SYSTEM when set`
  - `returns undefined for a resource with no identifier`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/lib/identifiers.test.js`
  Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement it,** and switch `orderRelay.js` over to `accessionNumberSystem()`.

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest`
  Expected: everything passes, including the existing `orderRelay` tests.

- [ ] **Step 5: Commit** with the message `LSO-209: Accession number system as a setting, shared with the order relay`.

### Task 5: Read result resources from AdvaPACS

**Files:**
- Modify: `src/lib/advapacsClient.js`
- Test: `test/lib/advapacsClient.test.js`

**Interfaces:**
- Produces: `readResource(resourceType, id): Promise<object>`. It does a `GET /{resourceType}/{id}` through the existing client, and resolves to `null` when AdvaPACS answers 404. Any other error rejects.

- [ ] **Step 1: Write the failing tests:**
  - `reads a resource by type and id`: `mockClient.get` is called with `/DiagnosticReport/abc`, and the result is the data.
  - `resolves null on 404`
  - `rejects on 500`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/lib/advapacsClient.test.js`
  Expected: FAIL, because `readResource` isn't a function.

- [ ] **Step 3: Implement `readResource`,** logging `info` with the resource type and id only.

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest test/lib/advapacsClient.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit** with the message `LSO-209: Read single resources from AdvaPACS`.

### Task 6: The private Mediator → OpenMRS channel

**Files:**
- Modify: `mediatorConfig.json`. Add a `defaultChannelConfig` entry named `Mediator to OpenMRS Radiology Results` with:
  - `urlPattern: "^/openmrs/ws/rest/v1/radiologyapp/(study|report)$"`
  - `methods: ["POST"]`
  - `authType: "private"`, `allow: ["advapacs-mediator"]`
  - `requestBody: true`, `responseBody: true`
  - no `autoRetryEnabled`: the AdvaPACS-side 5xx is the retry path (spec: one or the other)
  - one route `OpenMRS radiologyapp`, with `forwardAuthHeader: false` and a placeholder host and port
- Modify: `scripts/setupOpenhim.js`:
  - add the channel name to `CHANNEL_NAMES`
  - add `withRealOpenmrsRoute(channelDef)`, which sets the route's `host`, `port`, `secured`, `pathTransform` (`s/^\/openmrs/<OPENMRS_BASE_URL path>/`) and `username`/`password` from `OPENMRS_BASE_URL`, `OPENMRS_USERNAME` and `OPENMRS_PASSWORD`, the same way `withRealAdvapacsRoute` does
  - upsert the client `clientWithHashedPassword(OPENHIM_RESULTS_CLIENT_ID || 'advapacs-mediator', 'AdvaPACS mediator (results to OpenMRS)', OPENHIM_RESULTS_CLIENT_PASSWORD)`, only when the password is set, logging otherwise (as with the webhook client)
  - set the channel's `allow` to that client id
- Modify: `.env.example`, adding `OPENHIM_RESULTS_CLIENT_ID=advapacs-mediator`, `OPENHIM_RESULTS_CLIENT_PASSWORD=` and `OPENMRS_RESULTS_CHANNEL_URL=http://localhost:5001/openmrs`, with comments
- Test: `test/scripts/setupOpenhim.test.js`

**Interfaces:**
- Produces: the channel at `${OPENMRS_RESULTS_CHANNEL_URL}/ws/rest/v1/radiologyapp/{study|report}`, authenticated as client `OPENHIM_RESULTS_CLIENT_ID`.

- [ ] **Step 1: Write the failing tests** (in the style of the existing ones):
  - `provisions the results channel with the OpenMRS route and credentials`: given `OPENMRS_BASE_URL=http://openmrs:8080/openmrs`, the route has host `openmrs`, port `8080`, `secured: false`, pathTransform `s/^\/openmrs/\/openmrs/`, the OpenMRS username and password, and `forwardAuthHeader: false`.
  - `creates the results client when OPENHIM_RESULTS_CLIENT_PASSWORD is set`
  - `skips the results client when the password is unset`
  - `allows only the results client on the channel`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/scripts/setupOpenhim.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest`
  Expected: PASS.

- [ ] **Step 5: Commit** with the message `LSO-209: Private OpenHIM channel from the mediator to radiologyapp`.

### Task 7: radiologyapp client

**Files:**
- Create: `src/lib/radiologyappClient.js`
- Test: `test/lib/radiologyappClient.test.js`

**Interfaces:**
- Consumes: the channel from Task 6, and the endpoint contract from Task 3.
- Produces:
  - `importStudy(body): Promise<{outcome, encounterUuid?, studyCreated?}>`
  - `importReport(body): Promise<…>`
  - Both use axios with `baseURL: ${OPENMRS_RESULTS_CHANNEL_URL}/ws/rest/v1/radiologyapp`, `auth: {username: OPENHIM_RESULTS_CLIENT_ID || 'advapacs-mediator', password: OPENHIM_RESULTS_CLIENT_PASSWORD}` and `timeout: 30000`.
  - Both reject on any non-2xx response.

- [ ] **Step 1: Write the failing tests:**
  - `posts a study to /study with the results client's Basic auth`
  - `posts a report to /report`
  - `rejects on 400 with the server's error message in the Error`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/lib/radiologyappClient.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest test/lib/radiologyappClient.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit** with the message `LSO-209: radiologyapp import client via OpenHIM`.

### Task 8: Map FHIR resources to import requests

**Files:**
- Create: `src/lib/resultMapper.js`. Pure functions only: no I/O, no logging.
- Test: `test/lib/resultMapper.test.js`

**Interfaces:**
- Consumes: `identifierValue` and `accessionNumber` from Task 4.
- Produces:
  - `reportTypeFor(status): 'final' | 'correction' | null`: `final` → `final`; `amended`/`corrected` → `correction`; anything else → `null`.
  - `studySkipReason(imagingStudy): string | null`: `'no started'` if `started` is absent; `'no instances'` if `numberOfInstances === 0`; otherwise `null`.
  - `imagesAvailable(imagingStudy): boolean | null`: `numberOfInstances > 0` → `true`; `0` → `false`; absent → `null`.
  - `reportText(report): {text, contentType} | {skipReason}`:
    - The first `presentedForm[]` with `contentType` starting `text/plain`, else the first with `data`, decoded from base64 as UTF-8.
    - If there's no `presentedForm` data, use `conclusion` (contentType `text/plain`).
    - If neither exists → `{skipReason: 'no report text'}`.
  - `singlePractitionerId(references): string | null`: given FHIR References, returns the id if exactly one distinct `Practitioner/{id}` reference is present; otherwise `null`. This covers none, several, and `PractitionerRole`.
  - `technicianReferences(imagingStudy): Reference[]`: every `series[].performer[].actor`.
  - `radiologistReferences(report): Reference[]`: `resultsInterpreter` if it's non-empty, else `performer`.
  - `referenceId(reference, type): string | null`: given `"Patient/123"` and `'Patient'`, returns `"123"`.

- [ ] **Step 1: Write the failing tests:**
  - `maps final to final, amended and corrected to correction, preliminary/partial/cancelled to null`
  - `skips a study with no started` and `skips a study with 0 instances`
  - `images available is null when numberOfInstances is absent`
  - `decodes UTF-8 plain-text presentedForm` (include a non-ASCII character, e.g. "Sesotho: ê")
  - `prefers text/plain over text/html`
  - `falls back to conclusion`
  - `returns a skip reason when the report has no text`
  - `returns the single Practitioner id`, `returns null for two different practitioners`, `returns null for a PractitionerRole`
  - `ignores identifiers without a system`, as a mapper-level case through `accessionNumber`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/lib/resultMapper.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest test/lib/resultMapper.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit** with the message `LSO-209: Map AdvaPACS ImagingStudy and DiagnosticReport to radiologyapp imports`.

### Task 9: Handle an event

**Files:**
- Create: `src/lib/resultHandler.js`
- Test: `test/lib/resultHandler.test.js` (mock `advapacsClient` and `radiologyappClient`)

**Interfaces:**
- Consumes: `readResource` (Task 5), `importStudy`/`importReport` (Task 7), the mapper (Task 8) and the identifier helpers (Task 4).
- Produces:
  - `handleEvent(event): Promise<{outcome: string, reason?: string}>`
  - It resolves for anything handled or deliberately skipped (outcome is the endpoint's outcome, or `'SKIPPED'` with a `reason`), and rejects when AdvaPACS or OpenMRS failed.
  - Calls run one at a time, in arrival order, through a module-level promise chain (`let queue = Promise.resolve()`), so the next event starts only after the previous one settles.
- New setting: `OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID`, the OpenMRS identifier type matching `ADVAPACS_PATIENT_IDENTIFIER_SYSTEM`. If it's unset, `handleEvent` rejects with a configuration error, so the event gets a 5xx and can be retried once it's fixed. Add it to `.env.example`.

The flow:

- **`STUDY_CREATED`:**
  1. Read the ImagingStudy. If it's `null` (404), skip with reason `'not found'`.
  2. Apply `studySkipReason`.
  3. Get the accession; if there isn't one, skip with `'no accession with our system'`.
  4. Read the Patient from `subject` and get the identifier value with `ADVAPACS_PATIENT_IDENTIFIER_SYSTEM`. If either is missing, skip with `'no patient identifier'`.
  5. Find the technician: a single Practitioner from `technicianReferences`, then the identifier with `ADVAPACS_PRACTITIONER_IDENTIFIER_SYSTEM`.
  6. Call `importStudy` with `datePerformed = started`.
- **`REPORT_CREATED` / `REPORT_UPDATED`:**
  1. Read the DiagnosticReport; `null` → skip.
  2. `reportTypeFor(status)`; `null` → skip with `'status <status>'`.
  3. Get the text; a skip reason means skip.
  4. Get the accession, in this order: from the report; else read `study[0]` as an ImagingStudy and take its accession (and keep its `started` as `datePerformed`); else read `basedOn[0]` as a ServiceRequest. None → skip.
  5. Patient, as for a study.
  6. Radiologist, from `radiologistReferences`.
  7. Call `importReport` with `reportDate = issued`.
- **Any other `eventType`:** skip with `'event type'`.
- **Logging:**
  - One `info` line per event: `eventType`, `eventId`, `resourceId`, `status`, `accession`, `outcome`, `reason`.
  - A `warn` when the report text's `contentType` isn't `text/plain`, giving the contentType only.
  - A `warn` for the outcomes `NO_MATCHING_ORDER`, `PATIENT_MISMATCH` and `ALREADY_EXISTS`.

- [ ] **Step 1: Write the failing tests:**
  - `imports a study with started, images available and the patient identifier`: assert the exact `importStudy` body, including `patientIdentifierTypeUuid` from the env.
  - `skips a study with 0 instances without calling OpenMRS`
  - `imports a final report and takes the accession and datePerformed from the ImagingStudy`
  - `takes the accession from basedOn when the report and study have none`
  - `skips a preliminary report without reading anything else`
  - `passes the radiologist uuid only when the Practitioner has the provider-uuid identifier`
  - `skips with 200 when AdvaPACS has no such resource`: `readResource` resolves `null` → `{outcome: 'SKIPPED', reason: 'not found'}`.
  - `rejects when OpenMRS is unreachable` (`importReport` rejects)
  - `rejects when OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID is unset`
  - `handles concurrent final events for one report as one create`: three `handleEvent` calls fired without awaiting. The mocked `importReport` returns `CREATED` the first time and `ALREADY_EXISTS` after that, with a delay. Assert the calls didn't overlap: the second starts only after the first resolves (record start and end order).
  - `never logs the patient identifier or report text`: assert no logger call's arguments contain either value.

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/lib/resultHandler.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest test/lib/resultHandler.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit** with the message `LSO-209: Handle AdvaPACS study and report events`.

### Task 10: Wire it into the webhook, and document it

**Files:**
- Modify: `src/routes/advapacsWebhook.js`. After the existing checks and the "Received" log line, `await handleEvent(event)`: on success respond `200 {status: 'ok', outcome}`, and on rejection log `error` (message only) and respond `500 {status: 'error'}`. The test-event path stays unchanged. Update the header comment, which today says "Log-only".
- Modify: `mediatorConfig.json`, changing the description from "for now only logged" to say it creates radiologyapp studies and reports.
- Modify: `src/index.js`, updating the comment on the webhook route.
- Modify: `README.md`. Add a "Results to OpenMRS" section covering:
  - the flow
  - the new settings (`ADVAPACS_ACCESSION_NUMBER_SYSTEM`, `OPENMRS_RESULTS_CHANNEL_URL`, `OPENHIM_RESULTS_CLIENT_ID`, `OPENHIM_RESULTS_CLIENT_PASSWORD`, `OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID`)
  - the radiologyapp version required
  - the privilege `Task: org.openmrs.module.radiologyapp.importResults` the OpenMRS user needs
  - the assumption that OpenHIM and OpenMRS run on the same server

  Keep credential-storage details out of the README (they're tracked in LSO-302).
- Test: `test/routes/advapacsWebhook.test.js` (mock `resultHandler`)

- [ ] **Step 1: Write the failing tests:**
  - `returns 200 with the handler's outcome`
  - `returns 500 when the handler rejects`
  - `still acknowledges a TEST_EVENT without calling the handler`
  - `rejects bad credentials before calling the handler`

- [ ] **Step 2: Run them and see them fail.**
  Run: `npx jest test/routes/advapacsWebhook.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement it,** and update the docs.

- [ ] **Step 4: Run the tests and see them pass.**
  Run: `npx jest`
  Expected: the whole suite passes.

- [ ] **Step 5: Commit** with the message `LSO-209: Create radiologyapp studies and reports from AdvaPACS webhooks`.

---

## Deployment and verification on kol-ci

### Task 11: Deploy and run the spec's verification

There's no code to write here. This is a checklist; stop and report to the user at each failure. Pushing, the puppet PR and deploying radiologyapp are outward-facing, so confirm with the user before each one.

- [ ] **Step 1: Look up kol-ci's settings.** Using the mediator's OpenMRS account (REST, read-only):
  - the EMR ID identifier type UUID (`GET /ws/rest/v1/patientidentifiertype`)
  - that a kol-ci radiology order's order type matches GP `emr.radiologyTestOrderType`

  Report both to the user.
- [ ] **Step 2: Grant the privilege.** Check that the mediator's OpenMRS user has `Task: org.openmrs.module.radiologyapp.importResults`, plus encounter creation; it needs a role that has them. Ask the user how PIH config should grant this.
- [ ] **Step 3: Puppet PR** (PIH/mirebalais-puppet). Add the new mediator env vars for kol-ci next to `kol_ci_advapacs_webhook_secret` in `hieradata/SOMPRINFAPPCLSTR-01.yaml`. `OPENHIM_RESULTS_CLIENT_PASSWORD` is a new eyaml secret; `OPENMRS_PATIENT_IDENTIFIER_TYPE_UUID` comes from Step 1. Branch from master.
- [ ] **Step 4: Release radiologyapp.** Merge the radiologyapp PR and get the new omod into the Lesotho distro used by kol-ci; ask the user for the route (SNAPSHOT or release). Then merge the mediator PR, which auto-deploys to kol-ci.
- [ ] **Step 5: Run the spec's Verification steps 1–9** with the user, who drives AdvaPACS. Also confirm:
  - each `POST` to radiologyapp shows in OpenHIM under the `advapacs-mediator` client
  - what `system` (and any `assigner`) AdvaPACS returns on the ImagingStudy's accession identifier; if it isn't ours, set `ADVAPACS_ACCESSION_NUMBER_SYSTEM`
  - whether `series.performer` is filled
  - whether OpenHIM records the route's OpenMRS login (feeds LSO-302)
- [ ] **Step 6: Wrap up.** Remind the user to update the Kol-CI wiki page, and to ticket the future tasks (spec non-goals 1–11) under LSO-194.

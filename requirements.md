# BTP CI Toolkit – Requirements

Living document. Humans and agents: **read this first, update it with every new/changed requirement or decision**.
Status legend: ✅ done · 🚧 in progress · ⬜ planned · ❌ out of scope

## 1. Vision
SAP CAP application deployed to SAP BTP Cloud Foundry: a custom cockpit with extra tools for SAP Integration Suite
(Cloud Integration / CPI). UI is a launcher with a left-hand navigation bar (like the CPI UI) listing the available
features, plus a link to Configuration. New features must be easy to add.

## 2. Decisions (from the initial interview)
| # | Decision |
|---|----------|
| D1 | Two environments, **fixed: DEV and PROD**; each is a separate subaccount with its own Integration Suite tenant. |
| D2 | Auth towards CPI Management API (`/api/v1`): **OAuth2 client credentials** (service key data). |
| D3 | Per DEV/PROD connection, choose **Direct credentials** (settings and AES-256-GCM encrypted, write-only secret in the app DB; key from `SECRET_KEY`) or **BTP Destination** (destination name in the app DB; destination credentials managed in BTP and never copied to the DB). Existing direct settings are retained when switching modes. |
| D4 | Roles: **Viewer** (use tools) and **Admin** (edit configuration; also includes Viewer). In code/`@requires` these are the scopes `Viewer`/`Admin`; on BTP the role templates and role collections are named **`CiToolkitViewer`** / **`CiToolkitAdmin`**. |
| D5 | Runtime: **CAP Node.js + TypeScript** (ESM, run via `tsx`). DB: **SQLite locally (file `db.sqlite`), HANA Cloud on BTP**. |
| D6 | Local runs talk to **real CPI tenants** (credentials entered via Configuration); no built-in CPI mock. |
| D7 | Frontend: Fiori Elements where it fits. FE has no CPI-like side nav, so a small **launcher shell** (UI5 `sap.tnt.ToolPage` + `SideNavigation`) hosts the feature UIs (owner agreed). Configuration = Fiori Elements (List Report + Object Page, draft). Version Comparator = custom (freeform) UI5 view, because FE has no template for “action with input returning a result + log”. UI5 is loaded from the SAPUI5 CDN (1.136.0), theme `sap_horizon`. |
| D8 | Extensibility: **each feature = own CDS service + handler module + own UI app**, announced through a feature registry. |
| D9 | Version comparator results are **not persisted**; the `compare` action returns the result plus a step log. |
| D10 | Deployment: one MTA, CAP server serves OData **and** the UI (`app/` copied into the bundle), standalone approuter + XSUAA for login, HANA Cloud HDI for persistence, `SECRET_KEY` from user-provided service `ci-toolkit-secrets`. No HTML5 repo / Work Zone. See `docs/deployment.md`. |
| D11 | Destination mode uses SAP Cloud SDK, a Destination service binding, and HTTP/Internet **OAuth2ClientCredentials** destinations in the application's subaccount (or bound service instance). Production resolves through Destination service only; local development can use hybrid bindings or SDK local destinations. |
| D12 | Each environment has **Allow CPI modifications**, default **off**, editable by Admin. All mutating CPI calls go through the shared client's `write` method, which checks active, enabled configuration each time and rejects with HTTP 403 when blocked. This setting does not affect app configuration updates, token requests, connection tests, or read-only comparison actions. CPI permissions must independently allow the operation; existing Viewer/Admin roles remain unchanged. |
| D13 | **Groovy IDE** executes scripts through the blog's script-runner iFlow ("CI based Script tester & ABAP Groovy IDE"), request/response contract unchanged. Exactly **one executor** (`ScriptExecutor`, row `DEFAULT`, Admin-maintained in Configuration): runtime endpoint URL with Direct OAuth client credentials (encrypted, write-only secret) **or** a BTP Destination whose URL is the full endpoint. Not tied to DEV/PROD; PROD execution is not offered. Executing is not a CPI design-time change, so it does not use `CpiClient.write`/Allow CPI modifications; it is gated by the Developer role and the executor's `enabled` flag (default off). |
| D14 | New scope/role template/role collection **`Developer` / `CiToolkitDeveloper`** (includes Viewer): edit Groovy IDE data and run scripts. Viewer opens the IDE read only. `CiToolkitAdmin` does **not** include Developer. |
| D15 | Groovy IDE data **is persisted** (exception to D9 for this feature): `Scripts` (working copy), immutable `ScriptVersions`, `ScriptInputs` (named run inputs per script); shared by all users, owner/changer recorded via `managed`. Run results are not stored. |
| D16 | Scripts are downloaded **read only from DEV** only (iFlows and Script Collections, active version, `$value` zip); nothing is uploaded to CPI. Standalone scripts that exist only in the app DB are allowed. |
| D17 | **Endpoints** lists inbound endpoints from the CPI `ServiceEndpoints` API (deployed artifacts with an HTTP-based sender: HTTPS, SOAP, IDoc, OData, AS2; polling senders have no endpoint). The API has no access role, so the detail view downloads the iFlow (runtime artifact `$value`, design-time active version as fallback) and parses the sender channel from the `.iflw`; `{{parameters}}` are resolved from `Configurations`. Read only, nothing persisted, Viewer/Admin. |
| D18 | **Search** reads one tenant at a time (DEV or PROD, chosen by the user), design-time **active** versions: iFlow configuration parameters from the `Configurations` API and Groovy files (`.groovy`/`.gsh`) from the iFlow / Script Collection `$value` zips. Scripts are scanned with a lightweight heuristic (no Groovy parser). Patterns are **contains** matches with wildcards `*` (any text) and `+` (one character). Read only, nothing persisted, Viewer/Admin. |

## 3. Architecture
```
db/                         domain models (namespace btp.toolkit); one file per area
  connections.cds           Connections (DEV/PROD)
  groovy-ide.cds            Scripts, ScriptVersions, ScriptInputs, ScriptExecutor
  data/*.csv                seed data (DEV/PROD rows, empty config)
srv/
  index.cds                 entry point: one `using from` line per service
  core/                     platform services (not features)
    config-service.*        ConfigService      /odata/v4/config
    feature-service.*       FeatureService     /odata/v4/features
  features/
    registry.ts             feature registry -> served by FeatureService (drives side nav)
    <feature>/service.cds|ts   one folder per feature
  lib/                      shared code: cpi-client (OAuth + OData V2 GET + zip download), http-auth (token cache,
                            destination lookup), script-executor, zip reader, crypto, connections loader
app/                        UI (static, served by CAP locally; one folder per UI app, each with webapp/)
  index.html                redirect to launcher
  launcher/webapp/          shell: ToolPage, side nav built from FeatureService, loads feature UI5 components on demand
  configuration/            Fiori Elements app (annotations.cds + webapp/manifest.json, ext/SecretAction.js)
  version-comparator/webapp/  freeform UI5 app (view/controller/formatter/i18n)
  groovy-ide/webapp/        freeform UI5 app with sap.ui.codeeditor (Groovy IDE)
  endpoints/webapp/         freeform UI5 app (Endpoints list -> detail, NavContainer)
  search/webapp/            freeform UI5 app (Search: filter header + findings table)
xs-security.json            roles Viewer / Admin / Developer
```

### Adding a feature
Full recipe with templates and checklist: [docs/adding-a-feature.md](docs/adding-a-feature.md). Short version: service
under `srv/features/<name>/`, `using from` in `srv/index.cds`, entry in `srv/features/registry.ts` (incl. `component`,
`componentUrl`), UI in `app/<name>/webapp/`, update this file. No launcher changes are needed.

### Repository
GitHub: https://github.com/devstylator/btp_ci_toolkit (branch `main`). Docs: [README.md](README.md), [AGENTS.md](AGENTS.md).

## 4. Functional requirements

### 4.1 Configuration (✅ backend, ✅ UI)
- FR-CFG-1 ✅ Exactly two connections, `DEV` and `PROD`, pre-seeded; can be read/updated, not created/deleted. The entity is **draft-enabled** (required by Fiori Elements for editing) – changes via OData must follow the draft flow (`draftEdit` → PATCH draft → `draftActivate`).
- FR-CFG-2 ✅ Fields: name, tenantUrl (API base URL), tokenUrl, clientId, enabled; plus read-only last-test info.
- FR-CFG-3 ✅ Client secret set only via action `setSecret`; entity exposes `secretSet` (boolean) only.
- FR-CFG-4 ✅ Action `test` on a connection: fetches a token and calls the CPI API; stores result (`lastTestAt/Ok/Message`).
- FR-CFG-5 ✅ URLs must be `https://` (`http://localhost` allowed for local testing).
- FR-CFG-6 ✅ Admin only.
- FR-CFG-7 ✅ UI: list of the two connections -> object page; Edit/Save (draft), `Test connection` (result as toast/warning, “Last connection test” section refreshes), `Set client secret` (custom action with masked password dialog, since FE action dialogs cannot mask input).
- FR-CFG-8 ✅ Per-connection `connectionMode` (`DIRECT`, default, or `DESTINATION`) and `destinationName`; destination name required on destination draft activation. Destination mode requires no direct credentials. Existing connections continue in direct mode. UI offers a fixed mode dropdown with conditional settings; direct secret action is hidden/rejected in destination mode.
- FR-CFG-9 ✅ Per-connection `allowModifications`, default false; only saved active configuration enables writes, independently for DEV and PROD. Disabled/missing connections and false/null modification flags block all CPI writes before authentication/network traffic. Existing client instances recheck saved policy; unsaved drafts cannot enable writes.
- FR-CFG-10 ✅ `test` uses the selected connection mode and records sanitized destination lookup/authentication failures. It only tests read connectivity and does not certify CPI write permission.
- FR-CFG-11 ✅ Existing SQLite installations can add the new configuration columns, create tables of new features (Groovy IDE) and recreate all CAP service views with `npm run upgrade:local`, preserving active and draft settings/secrets and data without recreating tables or reloading seed data.
- FR-CFG-12 ✅ URL fields are also validated on draft activation (draft PATCHes do not pass the UPDATE handler).
- FR-CFG-13 ✅ Configuration list report has two tabs: *CPI connections* and *Script executor (Groovy IDE)*; the executor object page offers Edit/Save (draft), `Test executor`, `Set client secret` (direct mode only). See D13.

### 4.2 Version Comparator (✅ backend, ✅ UI)
- FR-VC-1 ✅ User selects a package (value help: `listPackages`) and optionally one artifact (`listArtifacts`).
- FR-VC-2 ✅ `compare(packageId, artifactId?)` reads DEV and PROD and compares **version numbers only**.
- FR-VC-3 ✅ Per item status: `MATCH`, `MISMATCH`, `MISSING_IN_DEV`, `MISSING_IN_PROD`. The package itself is a row (type `PACKAGE`) when no artifact filter is given.
- FR-VC-4 ✅ Artifact types: IntegrationFlow, ValueMapping, MessageMapping, ScriptCollection (list in `comparator.ts`; types a tenant does not expose are logged as WARN and skipped).
- FR-VC-5 ✅ Result contains `summary`, `rows`, and `log` (timestamped INFO/WARN/ERROR step log); nothing is stored.
- FR-VC-6 ✅ Not configured / disabled connection -> HTTP 412; CPI failures during compare -> `success=false` with ERROR log; failures in value helps -> HTTP 502.
- FR-VC-7 ✅ UI: package/artifact comboboxes (value help from `listPackages`/`listArtifacts`, reload button), Compare, result tab (summary tags, status-coloured table, “Differences only” switch), log tab, error strip. Packages must be picked from the list (free text is not compared). Both dropdowns support type-ahead search: case-insensitive “contains” match on ID or name (`ComboBox.setFilterFunction`).

### 4.3 Feature registry / navigation (✅ backend, ✅ UI)
- FR-NAV-1 ✅ `FeatureService.Features` returns entries visible to the caller's roles, ordered by `position`; `group=SYSTEM` entries (Configuration) belong at the bottom of the side nav.
- FR-NAV-2 ✅ Launcher UI with left navigation built from `Features` (features on top, `SYSTEM` group pinned to the bottom, collapsible via the menu button). The selected feature is kept in the URL (`?feature=<route>`) and the first feature opens by default.
- FR-NAV-4 ✅ Breadcrumbs above every feature (launcher level), derived from the URL hash of the embedded app: `Configuration / Connections / DEV`. Every crumb except the last is a link; clicking `Configuration` or `Connections` goes back to the list.
- FR-NAV-5 ✅ Clicking a side-nav entry always opens the start page of that feature (switching features clears the hash, clicking the already open feature returns to its start page). Technical note: the hash must be cleared through `sap.ui.core.routing.HashChanger` (UI5 caches the last hash); the previous feature component is destroyed first.
- FR-NAV-6 ✅ Light/dark theme switch (`sap_horizon` / `sap_horizon_dark`) at the top right of the launcher header. The choice is stored in the browser's `localStorage` (key `btp-ci-toolkit.theme`, per browser profile, not in the DB) and applied before UI5 boots; without a stored choice the OS setting (`prefers-color-scheme`) is used.
- FR-NAV-3 ✅ `Features` additionally exposes `component` and `componentUrl` (UI5 component to load).

### 4.4 Groovy IDE (✅ backend, ✅ UI) – see [docs/groovy-ide.md](docs/groovy-ide.md)
- FR-GIDE-1 ✅ Layout like groovyide.com/cpi: saved-script list (search) | Groovy editor (dark) | input tabs (body, headers, properties, saved inputs) above output tabs (body, headers, properties, console, error) with status (success/failed, HTTP status, duration). Body editors switch XML/JSON/text highlighting automatically. Ctrl+Enter runs, Ctrl+S saves.
- FR-GIDE-2 ✅ `run(script, payload, headers, properties)` calls the executor (D13) and returns decoded body, headers, properties (runner-internal `inputScript`/`consoleLog` hidden), console, error, HTTP status, duration. HTTP 400 = Groovy error (`success=false`). Executor disabled/not configured -> 412; runner/network failures -> `success=false` with a sanitized message. Names/values containing `;` or `=` are rejected (runner format). Nothing is stored.
- FR-GIDE-3 ✅ Scripts: create (name, description; from the scratchpad or a template), save working copy, rename, delete (cascades to versions and saved inputs). Unsaved-changes indicator and confirmation before discarding.
- FR-GIDE-4 ✅ Versions: `saveVersion(comment, content)` stores the content as working copy and as immutable version `max+1`; list, compare with the editor (line diff), load into the editor (must be saved to keep), delete.
- FR-GIDE-5 ✅ Saved inputs: **N per script, independent of script versions** (they belong to the script only; saving or restoring a version does not touch them, and every version can run every input). Each has a name, body, headers and properties (JSON `[{name, value}]`). Tab *Saved inputs* lists them (body type, header/property counts, changed by/at) and shows which one is loaded. *Save input as new* stores the current input tabs as an additional input (default name "Input N"); clicking a row loads it into the input tabs; row actions: *Load and run* (with the script in the editor), *Edit* (rename; replaces the stored content with the current input only when "Replace the stored input" is ticked, default on for the loaded one), *Delete*. No expected output, comparison or pass/fail; run outputs are only shown, never stored.
- FR-GIDE-6 ✅ Download from DEV (D16): `listPackages`, `listArtifacts(packageId)` (iFlows + Script Collections), `listArtifactScripts(packageId, type, artifactId)` downloads the active version zip and returns all `.groovy`/`.gsh` files; artifact name/version from the package listing (CPI answers single-artifact GETs with HTTP 501). The UI previews and saves a file as a new script that records source tenant, package, artifact, version and path.
- FR-GIDE-7 ✅ Roles (D14): Viewer reads everything and may preview downloads; only Developer may create/update/delete scripts, versions and saved inputs and call `run`. `executorStatus()` tells the UI whether running is possible.

### 4.5 Endpoints (✅ backend, ✅ UI) – D17
- FR-EP-1 ✅ `listEndpoints()` returns one row per entry point of DEV and PROD: tenant, iFlow ID/name (resolved against the deployed artifacts, since the ServiceEndpoints `Id` is `<iflow>$endpointAddress=<path>`), adapter, protocol, URL, version. A tenant that is not configured/disabled or fails is skipped with a WARN/ERROR message (the other tenant is still listed).
- FR-EP-2 ✅ List adapter is derived from the runtime URL path (`/http/` HTTPS, `/gw/odata/` OData, `/as2/` AS2, `/cxf/` -> API protocol SOAP/IDoc/XI); the detail view shows the exact `ComponentType` from the iFlow.
- FR-EP-3 ✅ `endpointDetails(tenant, iflowId, url)` returns deployment info (`IntegrationRuntimeArtifacts`: version, status, deployed by/on) and the sender channel(s) whose address matches the URL (wildcards supported; all sender channels with `matched=false` otherwise): adapter, address, authentication, user role, allowed certificates, all channel properties (credential-like keys dropped). Content source (RUNTIME/DESIGNTIME/NONE) and partial failures are reported as messages. Not configured -> 412, bad tenant -> 400, CPI failure -> 502.
- FR-EP-4 ✅ UI: table (tenant, iFlow, adapter, endpoint) with tenant filter (All/DEV/PROD), search (iFlow, adapter, URL) and reload; click opens the detail page (endpoint, deployment, access per sender channel, collapsible property list, copy URL). Navigation inside the component, URL hash untouched.
- FR-EP-5 ⬜ Verify sender-channel property names (`senderAuthType`, `userRole`, `clientCertificates`) and the runtime `$value` format against a real tenant (the raw property list in the detail view shows the actual names).

### 4.6 Search (✅ backend, ✅ UI) – D18
- FR-SRCH-1 ✅ Filters: tenant (DEV/PROD), package (optional, value help `listPackages(tenant)`, type-ahead; empty = all packages), name pattern, value pattern (at least one required; both must match when both are given), object types *iFlow parameters* and/or *Scripts* (default both), *Case sensitive* (default off).
- FR-SRCH-2 ✅ Patterns match anywhere in the text; `*` = any text (also empty), `+` = exactly one character, all other characters literal.
- FR-SRCH-3 ✅ iFlow parameters: `IntegrationDesigntimeArtifacts(Id,Version='active')/Configurations` of every iFlow in scope; finding = parameter key (name), value, data type.
- FR-SRCH-4 ✅ Scripts: all `.groovy`/`.gsh` files in the active-version zips of iFlows and Script Collections. Only these are reported (comments and string contents ignored, names must be string literals):
  variables declared in the code (`def`/`var`/typed declarations; value = initializer), properties and headers read via the message API (`message.getProperty("x")`, `getHeader("x", ...)`, `getProperties()/getHeaders().get("x")`, `getHeaders().getHeader("x")`, `message.headers["x"]`) and written (`setProperty`/`setHeader("x", value)`, `getProperties()/getHeaders().put("x", value)`, `message.headers["x"] = value`; value = the passed expression). `System.getProperty` is ignored.
- FR-SRCH-5 ✅ `search(...)` returns `success`, `summary` (packages, artifacts, scripts, findings, failures, truncated), `findings` and a timestamped step `log`. Artifacts that cannot be read are skipped with a WARN (search continues); unknown package / package list failure -> `success=false` with ERROR; not configured tenant -> 412; bad input -> 400. At most 5000 findings (`truncated`). CPI calls run with at most 6 in parallel. Nothing is stored.
- FR-SRCH-6 ✅ UI: filters in a collapsible DynamicPage header; findings table (type, name + kind, value, artifact + package / script path:line) with a client-side filter and a log dialog. Rows are not clickable (no detail page for now, removed 2026-10-22).
- FR-SRCH-7 ⬜ Verify against a real tenant (performance of a tenant-wide search, `Configurations` for iFlows without externalized parameters, Script Collection `$value`).

## 5. Non-functional
- NFR-1 Secrets never logged, never returned. `SECRET_KEY` mandatory in production (app fails otherwise); dev falls back to a fixed local key.
- NFR-2 CPI calls: 30 s timeout, OAuth token cached in memory until expiry, `__next` paging followed.
- NFR-3 Local auth: mocked users `alice/alice` (Admin, Viewer), `bob/bob` (Viewer). Production: XSUAA (`xs-security.json`).
- NFR-4 UI: the browser shows its Basic-auth prompt locally (mocked users); static UI files are public, data calls are authorized. Do not open the UI with credentials in the URL (`http://user:pw@...` breaks `fetch`).
- NFR-5 Destination credentials/tokens never returned or persisted; SDK diagnostic logging is muted because debug output may contain credentials. Application errors expose only sanitized context/status. CPI requests and pagination stay inside the configured tenant API; redirects are not followed. URLs require HTTPS in production (localhost HTTP only in development).
- NFR-6 Request body limit 10 MB (`cds.server.body_parser.limit`) for scripts and input payloads; runner calls time out after 60 s.

## 6. Out of scope (for now)
- ❌ History/persistence of comparison runs · ❌ more than two environments · ❌ BTP Credential Store · ❌ CPI mock server.
- ❌ Groovy IDE: uploading scripts to CPI, running on PROD, deploying the runner iFlow from the app, Groovy autocompletion, storing run results, test cases with expected output (removed 2026-10-20).

## 7. Roadmap / open items
1. ✅ Backend: model + services, runnable locally (`npm run watch` / `cds watch`, http://localhost:4004).
2. ✅ Owner reviewed DB model + OData.
3. ✅ UI: launcher (http://localhost:4004/ -> `/launcher/webapp/index.html`), Configuration (FE), Version Comparator.
3a. 🚧 Owner reviews the UI; verify against real tenants (local DB `db.sqlite`, configure DEV/PROD in the Configuration page).
4. ✅ Deployed to CF (trial `48a865d4trial` / `dev`, ap21, 2026-10-16): https://48a865d4trial-dev-btp-ci-toolkit.cfapps.ap21.hana.ondemand.com . HANA Cloud instance `trial-hana` (hana-free) mapped to the org/space. `ci-toolkit-secrets` created with a random key. Remaining: assign role collections, configure DEV/PROD on the CF app, test against real tenants. Note: trial HANA instances stop nightly - start `trial-hana` before using the app. (Optional later: UI5 build/preload to remove the harmless `Component-preload.js` 404s.)
5. ⬜ Verify artifact entity-set names against a real tenant (MessageMapping / ScriptCollection).
6. ✅ `tsc` type check fixed (`types` must be listed explicitly with TypeScript 7; `UPDATE.entity(...)`); `npm run typecheck` passes.
7. ⬜ Ideas for next features: _(add here)_
8. 🚧 Groovy IDE: deploy the runner iFlow on the DEV/trial tenant, configure the executor, assign `CiToolkitDeveloper`, verify against the real runner (verified locally against a fake runner with the same contract and real DEV downloads).

## 8. Changelog
- 2026-10-22: Search: detail column removed, findings rows are no longer clickable (backend no longer returns code snippets). Launcher: light/dark theme switch stored in the browser (FR-NAV-6).
- 2026-10-22: Search feature (D18, FR-SRCH-1..7): `SearchService` (`listPackages`, `search`), Groovy scanner and wildcard matcher, UI app (FlexibleColumnLayout), tests with a fake tenant; approuter destination timeout raised to 5 min; test ZIP writer moved to `test/zip.ts`.
- 2026-10-20: Endpoints: `ServiceEndpoints.Id` is an endpoint key (`<iflow>$endpointAddress=<path>`), not the artifact ID; the iFlow ID is now resolved against `IntegrationRuntimeArtifacts` (by ID before `$`, then by name). Details no longer fail with 502 when the single deployed-artifact GET fails (falls back to the artifact list; reported as a message with the HTTP status).
- 2026-10-20: Endpoints: fixed detail page not opening (HBox inside SimpleForm broke rendering); copy-URL button moved to the page header.
- 2026-10-20: Endpoints feature (D17, FR-EP-1..5): `EndpointsService` (`listEndpoints`, `endpointDetails`), iFlow sender channel parser, UI app, tests with a fake tenant.
- 2026-10-20: Groovy IDE: test cases replaced by **saved inputs** per script (FR-GIDE-5, D15): entity `TestCases` -> `ScriptInputs` (no expected body / compare mode), `runTests` removed, tab *Saved inputs* with load, load-and-run, edit, delete. `upgrade:local` moves existing test cases into `ScriptInputs`; HANA undeploys the old table (`db/undeploy.json`).
- 2026-10-19: Groovy IDE test cases: *New test case* always creates an additional test case (the dialog no longer defaults to updating the loaded one); per-row *Edit* with optional input replacement. Fixed: editor texts set by the app (e.g. input body on a hidden tab) were read stale and stored as empty.
- 2026-10-19: Groovy IDE feature (D13-D16, FR-GIDE-1..7): DB model, `GroovyIdeService`, executor settings in Configuration, `CiToolkitDeveloper` role, read-only DEV download, UI app, `docs/groovy-ide.md`; shared OAuth/destination helpers extracted to `srv/lib/http-auth.ts`; `upgrade:local` creates new tables and recreates views; URL validation on draft activation.
- 2026-10-16: local configuration upgrade also refreshes the CAP SQL view; regression test verifies new fields are queryable and secrets remain excluded.
- 2026-10-16: added per-environment Direct/BTP Destination connection modes and default-off CPI modification access, shared backend write guard, Destination service binding, conditional Configuration UI, and isolated integration tests.
- 2026-10-16: first deployment to Cloud Foundry (MTA `btp-ci-toolkit` 1.0.0).
- 2026-10-16: deployment prepared (MTA, approuter, XSUAA role collections `CiToolkitViewer`/`CiToolkitAdmin`, HDI, `ci-toolkit-secrets`), TypeScript build fixed, CSRF token handling in Version Comparator, `docs/deployment.md`.
- 2026-10-15: added README.md, AGENTS.md and docs/adding-a-feature.md; project put under git.
- 2026-10-15: breadcrumbs in the launcher; side-nav always opens a feature's start page; type-ahead search in Version Comparator dropdowns.
- 2026-10-15: UI added (launcher shell, Configuration FE app, Version Comparator UI5 app); `Connections` made draft-enabled; `Features` got `component`/`componentUrl`; `test`/`setSecret` return user messages.
- 2026-10-15: initial backend (Connections, ConfigService, FeatureService, VersionComparatorService).

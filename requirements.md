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
| D3 | Connection settings and secrets are **stored in the app DB**; the client secret is **AES-256-GCM encrypted at app level** (key from env `SECRET_KEY`), write-only (never returned by any API). |
| D4 | Roles: **Viewer** (use tools) and **Admin** (edit configuration; also includes Viewer). In code/`@requires` these are the scopes `Viewer`/`Admin`; on BTP the role templates and role collections are named **`CiToolkitViewer`** / **`CiToolkitAdmin`**. |
| D5 | Runtime: **CAP Node.js + TypeScript** (ESM, run via `tsx`). DB: **SQLite locally (file `db.sqlite`), HANA Cloud on BTP**. |
| D6 | Local runs talk to **real CPI tenants** (credentials entered via Configuration); no built-in CPI mock. |
| D7 | Frontend: Fiori Elements where it fits. FE has no CPI-like side nav, so a small **launcher shell** (UI5 `sap.tnt.ToolPage` + `SideNavigation`) hosts the feature UIs (owner agreed). Configuration = Fiori Elements (List Report + Object Page, draft). Version Comparator = custom (freeform) UI5 view, because FE has no template for “action with input returning a result + log”. UI5 is loaded from the SAPUI5 CDN (1.136.0), theme `sap_horizon`. |
| D8 | Extensibility: **each feature = own CDS service + handler module + own UI app**, announced through a feature registry. |
| D9 | Version comparator results are **not persisted**; the `compare` action returns the result plus a step log. |
| D10 | Deployment: one MTA, CAP server serves OData **and** the UI (`app/` copied into the bundle), standalone approuter + XSUAA for login, HANA Cloud HDI for persistence, `SECRET_KEY` from user-provided service `ci-toolkit-secrets`. No HTML5 repo / Work Zone. See `docs/deployment.md`. |

## 3. Architecture
```
db/                         domain models (namespace btp.toolkit); one file per area
  connections.cds           Connections (DEV/PROD)
  data/*.csv                seed data (DEV/PROD rows, empty config)
srv/
  index.cds                 entry point: one `using from` line per service
  core/                     platform services (not features)
    config-service.*        ConfigService      /odata/v4/config
    feature-service.*       FeatureService     /odata/v4/features
  features/
    registry.ts             feature registry -> served by FeatureService (drives side nav)
    <feature>/service.cds|ts   one folder per feature
  lib/                      shared code: cpi-client (OAuth + OData V2 GET), crypto, connections loader
app/                        UI (static, served by CAP locally; one folder per UI app, each with webapp/)
  index.html                redirect to launcher
  launcher/webapp/          shell: ToolPage, side nav built from FeatureService, loads feature UI5 components on demand
  configuration/            Fiori Elements app (annotations.cds + webapp/manifest.json, ext/SecretAction.js)
  version-comparator/webapp/  freeform UI5 app (view/controller/formatter/i18n)
xs-security.json            roles Viewer / Admin
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
- FR-NAV-3 ✅ `Features` additionally exposes `component` and `componentUrl` (UI5 component to load).

## 5. Non-functional
- NFR-1 Secrets never logged, never returned. `SECRET_KEY` mandatory in production (app fails otherwise); dev falls back to a fixed local key.
- NFR-2 CPI calls: 30 s timeout, OAuth token cached in memory until expiry, `__next` paging followed.
- NFR-3 Local auth: mocked users `alice/alice` (Admin, Viewer), `bob/bob` (Viewer). Production: XSUAA (`xs-security.json`).
- NFR-4 UI: the browser shows its Basic-auth prompt locally (mocked users); static UI files are public, data calls are authorized. Do not open the UI with credentials in the URL (`http://user:pw@...` breaks `fetch`).

## 6. Out of scope (for now)
- ❌ History/persistence of comparison runs · ❌ more than two environments · ❌ BTP Credential Store · ❌ CPI mock server.

## 7. Roadmap / open items
1. ✅ Backend: model + services, runnable locally (`npm run watch` / `cds watch`, http://localhost:4004).
2. ✅ Owner reviewed DB model + OData.
3. ✅ UI: launcher (http://localhost:4004/ -> `/launcher/webapp/index.html`), Configuration (FE), Version Comparator.
3a. 🚧 Owner reviews the UI; verify against real tenants (local DB `db.sqlite`, configure DEV/PROD in the Configuration page).
4. 🚧 Deployment: files ready (`mta.yaml`, `approuter/`, `scripts/copy-ui.mjs`, `docs/deployment.md`), MTAR builds and the production bundle was smoke-tested locally. **Not yet deployed**: waiting for a HANA Cloud instance mapped to the CF space (trial account `48a865d4trial`/`dev`, region ap21: the `hana` offering exists but there is no database available). Remaining after HANA: create `ci-toolkit-secrets`, `cf deploy`, assign role collections, test against real tenants. (Optional later: UI5 build/preload to remove the harmless `Component-preload.js` 404s.) `mta.yaml`, HANA HDI, XSUAA, app router / managed approuter, `SECRET_KEY` provisioning (user-provided service or env).
5. ⬜ Verify artifact entity-set names against a real tenant (MessageMapping / ScriptCollection).
6. ✅ `tsc` type check fixed (`types` must be listed explicitly with TypeScript 7; `UPDATE.entity(...)`); `npm run typecheck` passes.
7. ⬜ Ideas for next features: _(add here)_

## 8. Changelog
- 2026-10-16: deployment prepared (MTA, approuter, XSUAA role collections `CiToolkitViewer`/`CiToolkitAdmin`, HDI, `ci-toolkit-secrets`), TypeScript build fixed, CSRF token handling in Version Comparator, `docs/deployment.md`.
- 2026-10-15: added README.md, AGENTS.md and docs/adding-a-feature.md; project put under git.
- 2026-10-15: breadcrumbs in the launcher; side-nav always opens a feature's start page; type-ahead search in Version Comparator dropdowns.
- 2026-10-15: UI added (launcher shell, Configuration FE app, Version Comparator UI5 app); `Connections` made draft-enabled; `Features` got `component`/`componentUrl`; `test`/`setSecret` return user messages.
- 2026-10-15: initial backend (Connections, ConfigService, FeatureService, VersionComparatorService).

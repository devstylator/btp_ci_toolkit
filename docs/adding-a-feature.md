# Adding a feature (guide for agents and developers)

The app is a **plugin-style cockpit**: a launcher shell with a side navigation, and independent *features*
(tools). A feature is self-contained and is announced to the shell through a registry. **Adding a feature never
requires changes to the launcher code.**

Read [requirements.md](../requirements.md) first (decisions, requirement IDs, status). Update it when you are done.

## 1. Anatomy of a feature

| Part | Location | Required |
|------|----------|----------|
| OData service definition | `srv/features/<name>/service.cds` | yes |
| Service handlers | `srv/features/<name>/service.ts` | if there is logic |
| Domain model (tables) | `db/<name>.cds` (+ `db/data/*.csv` seed) | only if the feature stores data |
| Service wiring | one `using from` line in `srv/index.cds` | yes |
| Registry entry | `srv/features/registry.ts` | yes |
| UI (UI5 component) | `app/<name>/webapp/` | yes |

How the pieces connect at runtime:

```
launcher  --GET /odata/v4/features/Features-->  FeatureService (reads srv/features/registry.ts, filters by role)
   |  builds side-nav entries from the result
   |  on click: registers `componentUrl` for `component`, Component.create({name: component}), shows it
   v
app/<name>/webapp  --OData-->  /odata/v4/<name>  (srv/features/<name>/service.*)  --> CPI via srv/lib
```

Naming used below: `<name>` = kebab-case folder/route (`version-comparator`), `<Name>` = PascalCase service
(`VersionComparatorService`), UI5 namespace `btp.toolkit.<name without dashes>` (`btp.toolkit.versioncomparator`).

## 2. Step by step

### Step 1 - service definition `srv/features/<name>/service.cds`

```cds
@path: '/odata/v4/<name>'
@requires: ['Viewer', 'Admin']          // Admin also has Viewer, listing both is just explicit
service <Name>Service {
  type Result { ok : Boolean; message : String; }
  action doSomething(param : String) returns Result;
}
```

Rules:
- One service per feature, path `/odata/v4/<name>`.
- Always set `@requires` (roles are `Viewer` = use tools, `Admin` = configuration + everything).
  Use `@restrict` for finer control. Do not invent new roles without adding them to `xs-security.json`
  (scope + role template + role collection, existing ones are `CiToolkitViewer`/`CiToolkitAdmin`) and `requirements.md`.
- Prefer returning structured results (and a `log` array, like the comparator) over streaming.
- No persistence unless the requirement says so (see decision D9 in `requirements.md`).

### Step 2 - handlers `srv/features/<name>/service.ts`

```ts
import cds from '@sap/cds'
import { CpiClient, CpiError } from '../../lib/cpi-client.js'
import { loadConnection } from '../../lib/connections.js'

export default class <Name>Service extends cds.ApplicationService {
  async init() {
    this.on('doSomething', async (req: any) => {
      const dev = new CpiClient(await loadConnection('DEV', req))   // rejects with 412 when not configured
      try {
        const packages = await dev.get('IntegrationPackages?$top=5')  // array, or undefined on HTTP 404
        return { ok: true, message: `${packages?.length ?? 0} package(s)` }
      } catch (e) {
        if (e instanceof CpiError) req.reject(502, e.message)         // upstream CPI problem
        throw e
      }
    })
    return super.init()
  }
}
```

The implementation file is picked up automatically when it sits next to the `.cds` file and has the same base
name (`service.cds` -> `service.ts`). Use ESM imports with the `.js` extension. TypeScript runs through `tsx`;
there is no build step locally.

Shared building blocks in `srv/lib/` (reuse, do not reimplement):

| Module | Purpose |
|--------|---------|
| `connections.ts` -> `loadConnection('DEV' \| 'PROD', req)` | Reads the configured connection, decrypts the secret, rejects with **412** if missing/disabled |
| `cpi-client.ts` -> `CpiClient`, `CpiError` | OAuth2 client-credentials token (cached), `get(path)` against `<tenantUrl>/api/v1/<path>` (OData V2 JSON, follows `__next` paging, 30 s timeout) |
| `crypto.ts` -> `encrypt`, `decrypt` | AES-256-GCM, key from `SECRET_KEY` |

`loadConnection` handles direct credentials and BTP Destination mode. Feature code must use the shared client
without assuming that token URL, client ID or secret exist on every connection.

For every mutating CPI operation, use `await client.write('POST' | 'PUT' | 'PATCH' | 'DELETE', path, data?)`.
It rechecks the **active** connection's `enabled` and `allowModifications` flags before authentication/network
traffic and throws an error with `statusCode: 403` if blocked. Propagate this application error as 403;
do not wrap it as a CPI 502 failure. Writes use SDK CSRF handling. Never send CPI writes through raw fetch,
an SDK call in a feature, or a mutating endpoint disguised as a GET. CPI permissions still apply.
The switch governs remote CPI changes; a local OData POST for read-only computation (like `compare`) is allowed.
Keep existing Viewer/Admin role behavior unless a new requirement explicitly adds a separate operator role.

Error conventions: not configured -> 412 (from `loadConnection`), CPI unreachable/failing -> 502 for plain
functions; for actions that return a result object prefer `success=false` + ERROR log entry (see
`srv/features/version-comparator/service.ts`). Never log or return secrets.

Keep pure logic (comparison, mapping) in separate, framework-free modules (like `comparator.ts`) so it is easy to test.

### Step 3 - wire the service `srv/index.cds`

```cds
using from './features/<name>/service';
```

### Step 4 - register the feature `srv/features/registry.ts`

Append a descriptor to `features`:

```ts
{
  ID: '<name>',                         // unique
  title: 'My Tool',
  subtitle: 'One line shown as tooltip',
  icon: 'sap-icon://detail-view',       // any SAP icon
  route: '<name>',                      // used in the launcher URL ?feature=<name>
  component: 'btp.toolkit.<name-without-dashes>',
  componentUrl: '/<name>/webapp',       // URL of the webapp folder (folder app/<name>/webapp)
  service: '/odata/v4/<name>',
  position: 20,                         // order in the side nav; features 10-999, keep 1000+ for SYSTEM
  group: 'FEATURE',                     // 'SYSTEM' entries are pinned to the bottom (e.g. Configuration)
  roles: ['Viewer', 'Admin']            // who sees the entry (any of); must be consistent with @requires
}
```

### Step 5 - UI `app/<name>/webapp/`

The launcher loads any UI5 component that lives at `componentUrl`, so the UI is a normal UI5 app folder.
Required files: `Component.js` and `manifest.json` (+ `i18n/i18n.properties` recommended).
The component id in `manifest.json` (`sap.app.id`) **must equal** the registry `component` value.

Pick one of two styles:

**A. Fiori Elements (preferred for list/detail/CRUD on an entity).** Copy the pattern of `app/configuration/`:
`webapp/Component.js` extends `sap/fe/core/AppComponent`; `manifest.json` has the OData model, routing with
`sap.fe.templates.ListReport` / `ObjectPage`; UI annotations live in `app/<name>/annotations.cds`
(`annotate <Name>Service.<Entity> with @(UI...)`). Gotchas learned here:
- Editing in Fiori Elements needs a **draft-enabled** entity (`@odata.draft.enabled`).
- Bound actions that change data need `@Common.SideEffects` (target `in/<property>`) so the page refreshes.
- Use `req.notify()` for success messages (toast); `req.info()` opens a blocking dialog; `req.warn()` for soft failures.
- FE action-parameter dialogs cannot mask input; for secrets use a custom action (see `webapp/ext/SecretAction.js`).
- Keep `initialLoad: Enabled` (and `hideFilterBar`) on list pages without filters.

**B. Freeform UI5 (for "input -> run action -> show result" tools).** Copy the pattern of
`app/version-comparator/webapp/`: `Component.js` extends `sap/ui/core/UIComponent` with `manifest: "json"`,
`rootView` in the manifest, an XML view + controller, JSON model and `fetch` against the OData service
(plain JSON, no CSRF token needed). Use `sap.m` controls only, put texts in `i18n`.

Common requirements for both:
- Do not touch the URL hash unless you are a Fiori Elements app (the hash belongs to the app; the launcher builds
  breadcrumbs from it: `#/<Entity>(<key>)` -> `Feature / Entity / key`).
- UI must work embedded in a `sap.ui.core.ComponentContainer` (no `index.html`, no own shell).
- Use relative/absolute service URLs from the manifest `dataSources`, never hard-code hosts.
- UI5 version is pinned in the launcher bootstrap (`app/launcher/webapp/index.html`, currently 1.136.0);
  set `minUI5Version` accordingly and use only libraries that version provides.

### Step 6 - verify

```bash
npm run watch                          # http://localhost:4004 , mocked users alice/alice (Admin), bob/bob (Viewer)
curl -u bob:bob 'http://localhost:4004/odata/v4/features/Features'          # your entry is listed for allowed roles
curl -u bob:bob 'http://localhost:4004/odata/v4/<name>/$metadata'          # service compiles
```

Then open http://localhost:4004/, log in, check the side nav entry, breadcrumbs, and that "Configuration"
still works. For tests against CPI without real tenants, run a throwaway fake CPI that serves
`/<env>/token` and `/<env>/api/v1/...` and enter `http://localhost:<port>/<env>` as tenant URL on the
Configuration page (remove the fake and reset `db.sqlite` afterwards: `rm db.sqlite* && npm run deploy:local`).

Browser automation hint: do not open the UI with credentials in the URL (breaks `fetch`); supply them through the
browser/context credentials instead.

### Step 7 - document

Update [requirements.md](../requirements.md): add the feature's requirements (IDs `FR-<ABBR>-n`), decisions,
status and changelog line. Update the feature table in [README.md](../README.md).

## 3. Adding tables for a feature

Create `db/<name>.cds` in namespace `btp.toolkit` (entities with `managed` if audit fields are useful), project
them in the feature service, and add `db/data/btp.toolkit-<Entity>.csv` only for seed data. Locally redeploy with
`npm run deploy:local` (SQLite). On BTP the same model is deployed to HANA. Never store secrets in plain text:
use `srv/lib/crypto.ts` and never expose the encrypted column through a service (see `Connections`).

## 4. Checklist

- [ ] `service.cds` with `@path` and `@requires`
- [ ] handlers use `loadConnection` / `CpiClient`, no secrets logged or returned
- [ ] `using from` added to `srv/index.cds`
- [ ] registry entry (`component` == `sap.app.id`, `componentUrl` points to `webapp`)
- [ ] UI works embedded in the launcher; texts in `i18n`
- [ ] roles consistent in `@requires`, registry `roles`, and `xs-security.json`
- [ ] `npm run typecheck` passes
- [ ] verified locally (metadata, side nav, breadcrumbs, happy path + "not configured" 412 path)
- [ ] `requirements.md` and `README.md` updated

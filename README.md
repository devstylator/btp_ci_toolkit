# BTP CI Toolkit

A custom cockpit for **SAP Integration Suite (Cloud Integration / CPI)**, built with **SAP CAP (Node.js, TypeScript)**
for deployment to SAP BTP Cloud Foundry. It is a small shell with a CPI-style left navigation that hosts independent
tools ("features"). New tools can be added without touching the shell.

Current features:

| Feature | What it does |
|---------|--------------|
| **Version Comparator** | Compares package / artifact versions between the DEV and PROD tenants (version numbers only), with a status per item (match, differs, missing in DEV/PROD) and a step log. Nothing is stored. |
| **Groovy IDE** | GroovyIDE-like editor for CPI Groovy scripts: run them on a script-runner iFlow (body, headers, properties, console), save scripts with versions and named inputs (body, headers, properties) in the app DB, download scripts read only from DEV iFlows / Script Collections. See [docs/groovy-ide.md](docs/groovy-ide.md). |
| **Endpoints** | Lists the inbound endpoints of deployed iFlows on DEV and PROD (tenant, iFlow, adapter, URL); the detail view adds the sender channel's authentication and access role (user role) and deployment info (version, status, deployed by/on). Read only. |
| **Search** | Searches one tenant (all packages or one) for iFlow configuration parameters and, in Groovy scripts of iFlows and Script Collections, for declared variables and properties/headers read or set via the message API. Name and/or value patterns with `*` / `+` wildcards, optional case sensitivity; findings table with package, artifact and script line. Read only. |
| **Configuration** | Maintains DEV/PROD connections using direct credentials (encrypted secret) or a BTP Destination, with enabled and Allow CPI modifications switches and a "Test connection" action. |

## Quick start (local)

Requirements: Node.js 22+, `@sap/cds-dk` (`npm i -g @sap/cds-dk`).

```bash
npm install
npm run deploy:local      # creates the local SQLite database db.sqlite (DEV/PROD rows, empty)
npm run watch             # http://localhost:4004
```

Open http://localhost:4004/ and log in with a mocked local user:

| User | Password | Roles | Can |
|------|----------|-------|-----|
| `alice` | `alice` | Admin, Viewer, Developer | everything, including Configuration and running Groovy scripts |
| `bob` | `bob` | Viewer | use tools (Version Comparator, Groovy IDE read only), not Configuration |

Then, as `alice`: **Configuration** -> pick DEV -> *Edit* -> fill tenant URL, token URL, client ID -> *Save* ->
*Set client secret* -> *Test connection*. Repeat for PROD. Local runs talk to the **real** tenants.

Alternatively select **BTP Destination** and enter the destination name; URL and credentials are maintained in BTP.
See [Destination setup and local development](docs/deployment.md#btp-destination-connections).
**Allow CPI modifications** defaults to off for each environment. Reads and comparisons work with it off;
future tools that change CPI must use the shared guarded write method. Enabling it does not grant CPI permissions.

For an existing local database, stop the app, back up `db.sqlite`, run `npm run upgrade:local`, then restart.
Use `deploy:local` for fresh/reset databases; it recreates tables and reloads seed data.

Where do the values come from? From a service key of the Integration Suite process-integration runtime
(`api` plan) in each subaccount: `url` (tenant URL), `tokenurl`, `clientid`, `clientsecret`.

## Project layout

```
db/                       domain model (namespace btp.toolkit), seed data in db/data
srv/
  index.cds               entry point, one `using from` line per service
  core/                   platform services: ConfigService, FeatureService
  features/
    registry.ts           the plugin registry: which features exist, their UI component, icon, roles
    <feature>/            one folder per feature: service.cds + service.ts (+ helpers)
  lib/                    shared code: CPI client (OAuth2 + OData V2), connection loader, crypto
app/
  index.html              redirects to the launcher
  launcher/webapp/        shell: side navigation, breadcrumbs, loads feature UIs on demand
  configuration/          Fiori Elements app (Configuration)
  version-comparator/webapp/  freeform UI5 app
  groovy-ide/webapp/      freeform UI5 app (Groovy IDE, sap.ui.codeeditor)
  endpoints/webapp/       freeform UI5 app (Endpoints list/detail)
  search/webapp/          freeform UI5 app (Search)
docs/adding-a-feature.md  how to add a feature (the plugin recipe)
docs/deployment.md        deploying to Cloud Foundry
mta.yaml, approuter/      deployment descriptor and the approuter (login, routing)
scripts/copy-ui.mjs       build helper: puts the UI into the server bundle
requirements.md           living requirements, decisions, status, roadmap
xs-security.json          XSUAA roles: Viewer, Admin, Developer
```

## How the plugin mechanism works

1. Each feature is its own OData service (`/odata/v4/<feature>`) plus its own UI5 component under `app/<feature>/webapp`.
2. `srv/features/registry.ts` lists the features (title, icon, UI component name and URL, roles, position).
3. The launcher asks `/odata/v4/features/Features` for the entries visible to the current user, builds the side
   navigation, and loads the selected feature's UI component dynamically. The breadcrumb above it follows the
   feature's navigation.

To add a tool: write the service, wire it in `srv/index.cds`, add one registry entry, drop the UI in `app/<name>/webapp`.
Details and templates: **[docs/adding-a-feature.md](docs/adding-a-feature.md)**.

## Services (OData V4)

| Path | Roles | Purpose |
|------|-------|---------|
| `/odata/v4/features` | any authenticated user | feature list for the side navigation |
| `/odata/v4/config` | Admin | `Connections` (DEV/PROD) and `ScriptExecutor` (Groovy IDE runner), draft-enabled, actions `test`, `setSecret` |
| `/odata/v4/version-comparator` | Viewer, Admin | `listPackages()`, `listArtifacts(packageId)`, `compare(packageId, artifactId?)` |
| `/odata/v4/endpoints` | Viewer, Admin | `listEndpoints()`, `endpointDetails(tenant, iflowId, url)` |
| `/odata/v4/search` | Viewer, Admin | `listPackages(tenant)`, `search(tenant, packageId, name, value, caseSensitive, iflows, scripts)` |
| `/odata/v4/groovy-ide` | Viewer (read), Developer | `Scripts`, `ScriptVersions`, `ScriptInputs`, `saveVersion`, `run`, `executorStatus()`, DEV download value helps |

Metadata: `http://localhost:4004/odata/v4/<service>/$metadata`.

Run `npm run typecheck` and `npm test` for type checking and isolated configuration/CPI integration tests.
Tests use an in-memory database and a temporary local CPI fixture; they do not change `db.sqlite` or real tenants.

## Security notes

- Client secrets are encrypted with AES-256-GCM before they are stored; no service ever returns them.
- `SECRET_KEY` encrypts the stored secrets. On Cloud Foundry it comes from the user-provided service
  `ci-toolkit-secrets` (see the deployment guide); secret handling fails in production without it. Locally a fixed
  development key is used.
- Local authentication is mocked; on BTP the app uses XSUAA (`xs-security.json`). Assign the role collections
  `CiToolkitViewer` / `CiToolkitAdmin` / `CiToolkitDeveloper` to users.
- The Groovy IDE runs arbitrary Groovy code on the configured runner iFlow; deploy that iFlow only on an isolated
  development/trial tenant ([docs/groovy-ide.md](docs/groovy-ide.md)).

## Status and roadmap

See [requirements.md](requirements.md). The first version is deployed to Cloud Foundry; these configuration changes
require a new build/deployment and the Destination service entitlement.

## Deployment to SAP BTP Cloud Foundry

MTA with CAP server, HANA (HDI), XSUAA and approuter: **[docs/deployment.md](docs/deployment.md)**
(`npm run typecheck`, `mbt build`, `cf deploy`).

## For AI agents

Start with [AGENTS.md](AGENTS.md).

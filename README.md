# BTP CI Toolkit

A custom cockpit for **SAP Integration Suite (Cloud Integration / CPI)**, built with **SAP CAP (Node.js, TypeScript)**
for deployment to SAP BTP Cloud Foundry. It is a small shell with a CPI-style left navigation that hosts independent
tools ("features"). New tools can be added without touching the shell.

Current features:

| Feature | What it does |
|---------|--------------|
| **Version Comparator** | Compares package / artifact versions between the DEV and PROD tenants (version numbers only), with a status per item (match, differs, missing in DEV/PROD) and a step log. Nothing is stored. |
| **Configuration** | Maintains the two CPI connections (DEV, PROD): tenant URL, token URL, client ID, client secret (stored encrypted, write-only), enabled flag, and a "Test connection" action. |

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
| `alice` | `alice` | Admin, Viewer | everything, including Configuration |
| `bob` | `bob` | Viewer | use tools (Version Comparator), not Configuration |

Then, as `alice`: **Configuration** -> pick DEV -> *Edit* -> fill tenant URL, token URL, client ID -> *Save* ->
*Set client secret* -> *Test connection*. Repeat for PROD. Local runs talk to the **real** tenants.

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
docs/adding-a-feature.md  how to add a feature (the plugin recipe)
requirements.md           living requirements, decisions, status, roadmap
xs-security.json          XSUAA roles: Viewer, Admin
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
| `/odata/v4/config` | Admin | `Connections` (DEV/PROD, draft-enabled), actions `test`, `setSecret` |
| `/odata/v4/version-comparator` | Viewer, Admin | `listPackages()`, `listArtifacts(packageId)`, `compare(packageId, artifactId?)` |

Metadata: `http://localhost:4004/odata/v4/<service>/$metadata`.

## Security notes

- Client secrets are encrypted with AES-256-GCM before they are stored; no service ever returns them.
- Set `SECRET_KEY` (any strong random string) as an environment variable in production - secret handling fails
  without it in production. Locally a fixed development key is used.
- Local authentication is mocked; on BTP the app uses XSUAA (`xs-security.json`). Assign the `Viewer` / `Admin`
  role collections to users.

## Status and roadmap

See [requirements.md](requirements.md). Not done yet: deployment descriptor (`mta.yaml`, HANA, XSUAA, approuter /
HTML5 repo), `SECRET_KEY` provisioning on BTP, verification against real tenants.

## For AI agents

Start with [AGENTS.md](AGENTS.md).

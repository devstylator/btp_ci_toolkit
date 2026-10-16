# Deployment to SAP BTP Cloud Foundry

The app is deployed as one MTA (`mta.yaml`) consisting of:

| Part | Type | Purpose |
|------|------|---------|
| `btp-ci-toolkit-srv` | Node.js app (`gen/srv`) | CAP server: OData services **and** the UI (`app/` is copied into the bundle) |
| `btp-ci-toolkit-db-deployer` | HDI deployer (`gen/db`) | Creates/updates the tables in HANA Cloud (also loads the DEV/PROD seed rows) |
| `btp-ci-toolkit` | Approuter (`approuter/`) | The only public entry point: login (XSUAA), forwards everything to the CAP server with the user's token |
| `btp-ci-toolkit-auth` | XSUAA (`xs-security.json`) | Scopes `Viewer`/`Admin`, role templates and **role collections `CiToolkitViewer` / `CiToolkitAdmin`** |
| `btp-ci-toolkit-db` | HDI container (`hana`, `hdi-shared`) | The database schema |
| `btp-ci-toolkit-destination` | Destination (`destination`, `lite`) | Resolves named CPI destinations on the CAP server |
| `ci-toolkit-secrets` | user-provided service | Holds `SECRET_KEY` (not in git) |

## Prerequisites (once per subaccount / space)

1. **HANA Cloud** instance in the subaccount, running (trial instances stop every night - start it) and
   **mapped to the CF org + space** (HANA Cloud Central -> instance -> Manage Configuration -> Instance Mapping).
   Entitlements: `hana-cloud` (plan `hana`/`hana-free`) and `hana` (plan `hdi-shared`).
   Check: `cf marketplace -e hana` lists `hdi-shared`, and a service of that plan can be created.
2. Entitlements for `xsuaa` (plan `application`). No Work Zone / HTML5 repo is needed.
3. Local tools: `cf` CLI with the `multiapps` plugin, `mbt`, Node.js 22+. Logged in: `cf login`, `cf target -o <org> -s <space>`.
4. The CF space needs outbound internet (to reach the CPI tenants and `ui5.sap.com` for the browser).
5. Destination service entitlement (`destination`, plan `lite`). The MTA creates and binds it to the CAP server.

## 1. Create the encryption key (once)

The client secrets of the CPI connections are stored AES-256-GCM encrypted. The key lives in a user-provided
service so it is never in git and survives redeployments:

```bash
cf create-user-provided-service ci-toolkit-secrets -p "{\"SECRET_KEY\":\"$(openssl rand -base64 32)\"}"
```

**Back the key up** (e.g. in a password manager: `cf env btp-ci-toolkit-srv` shows it after the first deploy).
If the key is lost or changed, the stored client secrets cannot be decrypted and must be entered again on the
Configuration page. To rotate: update the service (`cf update-user-provided-service ... -p ...`), restage the srv app,
then re-enter the secrets.

## 2. Build and deploy

```bash
npm install
npm run typecheck                 # must pass
mbt build -t mta_archives         # runs: npm ci, cds build --production, copies the UI, packages the MTAR
cf deploy mta_archives/btp-ci-toolkit_1.0.0.mtar
```

`cf deploy` creates the services, runs the DB deployer, starts the CAP server and the approuter. The URL of the
approuter is printed at the end (`btp-ci-toolkit-<org>-<space>`-style route or `cf apps` -> `btp-ci-toolkit`).

## 3. Assign roles

BTP cockpit -> Security -> Role Collections: the deployment created **`CiToolkitViewer`** and **`CiToolkitAdmin`**.
Assign them to your user (and your identity provider group, if used). Admin includes Viewer.
Log out and in again after changing roles (new token).

## 4. First use

Open the approuter URL -> **Configuration** -> DEV -> *Edit* -> fill in tenant URL, token URL, client ID -> *Save* ->
*Set client secret* -> *Test connection*. Repeat for PROD. Then use **Version Comparator**.
(Values come from the service key of the Integration Suite runtime `api` plan: `url`, `tokenurl`, `clientid`, `clientsecret`.)

### BTP Destination connections

For each environment, you can instead select **BTP Destination** and enter a destination name. Create the destination
in the application's subaccount (Connectivity -> Destinations), or in the bound Destination service instance:

| Setting | Value |
|---------|-------|
| Name | For example `CPI_DEV` / `CPI_PROD` |
| Type | `HTTP` |
| URL | CPI tenant base URL, the same value used for direct `tenantUrl`; omit `/api/v1` |
| Proxy Type | `Internet` |
| Authentication | `OAuth2ClientCredentials` |
| Client ID / Client Secret | From the target tenant's Integration Suite runtime `api` service key |
| Token Service URL | The service key's `tokenurl` |

The destination is configured where this toolkit runs, even if the target CPI tenant is in another subaccount.
Use distinct names when both instance and subaccount destinations exist; the SDK prioritizes instance destinations.
Production resolves through the Destination service using the application's service bindings, without forwarding the
user's token. Credentials/tokens resolved from BTP are never copied into HANA or returned to the browser.
Switching mode retains any previously stored direct settings and encrypted secret so you can switch back.
`Set client secret` applies only to direct mode. Save changes before using **Test connection**.

**Allow CPI modifications** defaults to off independently for DEV and PROD. Only Admin can change it, through
the normal Edit/Save draft flow. Turning it on permits guarded CPI writes by tools, subject to the target CPI
service account's permissions. It does not change those permissions. Connection tests only verify read access;
deploying packages and removing locks remain separate future features.

For local development against real BTP destinations, bind Destination and XSUAA services using CAP hybrid bindings
and run with the hybrid profile (`cds bind -2 <destination-instance>,<xsuaa-instance>` followed by
`npm run watch -- --profile hybrid`). Keep binding files/credentials out of git.
For isolated local tests, the SDK also supports its `destinations` environment variable or `registerDestination`
with resolved OAuth tokens; these are development mechanisms, ignored by the application's production lookup.
HTTPS is required in production; `http://localhost` is accepted only locally.

### Updating an existing installation

Build and redeploy the complete MTA so the new database columns and Destination binding are deployed together.
New connection fields have defaults `DIRECT` and `false`, preserving existing direct credentials and read behavior.
For an existing local database, stop the app, back up `db.sqlite`, run `npm run upgrade:local`, and restart.
This adds the three new columns to the active and draft connection tables and refreshes the service view;
it can safely be rerun.
`deploy:local` recreates tables and reloads seed data, so reserve it for new/reset databases.
For HANA use your normal backup and full MTA deployment process. The existing seed CSV is unchanged.
After deployment, verify the existing DEV/PROD settings and test both.
Keep `ci-toolkit-secrets` and its key while any stored direct credentials are retained.

## Current deployment (trial)

- Org/space: `48a865d4trial` / `dev` (region ap21), URL: https://48a865d4trial-dev-btp-ci-toolkit.cfapps.ap21.hana.ondemand.com
- HANA Cloud instance `trial-hana` (plan `hana-free`), mapped to the org/space. **Trial instances stop every night**: start it in
  HANA Cloud Central before using the app, otherwise the server cannot reach its database.

## Operations

| Task | Command |
|------|---------|
| Logs | `cf logs btp-ci-toolkit-srv --recent` |
| Status | `cf apps`, `cf services` |
| Redeploy after code changes | `mbt build -t mta_archives && cf deploy mta_archives/btp-ci-toolkit_1.0.0.mtar` |
| Remove everything | `cf undeploy btp-ci-toolkit --delete-services` (deletes the database and its data!) |

## How it works / design notes

- The approuter route `^/(.*)$` sends all traffic to the CAP server (`srv-api` destination) with `forwardAuthToken`,
  so CAP validates the XSUAA JWT. `csrfProtection` is on: the Version Comparator UI fetches a CSRF token before POSTs
  (Fiori Elements does it itself).
- UI and OData are same-origin, so the absolute paths used by the launcher (`/odata/...`, `/configuration/webapp`)
  work unchanged. `scripts/copy-ui.mjs` copies `app/` (without `.cds` files) into `gen/srv/app`.
- TypeScript is compiled during `cds build --production`; the production server runs plain JS (no `tsx`).
- Scope names stay `Viewer`/`Admin` (they are what `@requires` uses); the role templates and role collections carry
  the `CiToolkit` names. If you add a feature that needs new roles, add scope + role template + role collection
  in `xs-security.json`.
- XSUAA app name is `btp-ci-toolkit-${org}-${space}`; role collection names must be unique per subaccount, so a
  second deployment of this app into the same subaccount (another space) needs different role collection names.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `no database available in space` when creating the HDI container | HANA Cloud not running / not mapped to the space |
| Deployment fails: service `ci-toolkit-secrets` not found | step 1 not done |
| App crashes: `SECRET_KEY is required in production` | the srv app is not bound to `ci-toolkit-secrets` / key missing |
| 403 / "lacking required roles" after login | role collection not assigned, or not logged in again |
| Config page shows 412 `not fully configured` | connection data/secret missing (Configuration page) |
| CPI calls fail with 502 / connection errors | no outbound internet, wrong URLs, or wrong service key |
| Destination lookup fails | wrong destination name, missing Destination/XSUAA binding, or destination in a different subaccount |
| Destination rejected | use HTTP, Internet, OAuth2ClientCredentials and a valid HTTPS tenant base URL |
| CPI modifications return 403 | save Allow CPI modifications for the target environment and ensure the connection is enabled; CPI may also deny insufficient service-account permissions |

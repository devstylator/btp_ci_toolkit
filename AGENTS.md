# Agent instructions

Project: **BTP CI Toolkit** - a SAP CAP (Node.js/TypeScript) cockpit for SAP Integration Suite (CPI) on BTP Cloud Foundry.

Before doing anything:
1. Read [requirements.md](requirements.md) - decisions (D1-D9), requirement IDs, status, roadmap. It is the source of truth
   and **must be updated** with every new or changed requirement/decision (including a changelog line).
2. Read [README.md](README.md) for the layout and how to run it.
3. Deployment (MTA, approuter, roles, HANA, secrets): [docs/deployment.md](docs/deployment.md). Keep `mta.yaml` and `xs-security.json` in sync with new features/roles.
4. To add or change a tool ("feature"), follow [docs/adding-a-feature.md](docs/adding-a-feature.md). The app is
   plugin-style: a new feature must not require changes to `app/launcher`.

Conventions:
- Backend in TypeScript (ESM, `.js` import suffix), run through `tsx` (`npm run watch`). Frontend is plain UI5 JavaScript
  (UI5 1.136.0 from the CDN); Fiori Elements where it fits, freeform UI5 otherwise.
- Reuse `srv/lib` (CPI client, connection loader, crypto). Never log or return client secrets.
- Roles: scopes `Viewer` (use tools), `Admin` (configuration, includes Viewer) and `Developer` (Groovy IDE edit/run, includes Viewer); BTP role templates/collections `CiToolkitViewer` / `CiToolkitAdmin` / `CiToolkitDeveloper`. Keep `@requires`, registry `roles` and `xs-security.json` consistent.
- Run `npm run typecheck` before committing (TypeScript 7: `types` are listed explicitly in `tsconfig.json`).
- Do not persist comparison results or other data unless a requirement says so.
- Local dev users: `alice/alice` (Admin, Viewer, Developer), `bob/bob` (Viewer). Local DB `db.sqlite` is git-ignored; reset with
  `rm db.sqlite* && npm run deploy:local`.
- Verify changes by running the app and checking the OData and UI, not only by compiling. Clean up temporary fake services and test data.
- Commits: small and focused, imperative message, keep the `Co-authored-by` trailer when requested by the tooling.

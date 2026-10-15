/**
 * Feature registry served to the UI (side navigation). Backed by code (srv/features/registry.ts),
 * not by the database. Items are filtered by the roles of the calling user.
 */
@path: '/odata/v4/features'
@requires: 'authenticated-user'
service FeatureService {

  @readonly
  @cds.persistence.skip
  entity Features {
    key ID       : String(40);
        title    : String(60);
        subtitle : String(120);
        icon     : String(60);      // SAP icon name, e.g. sap-icon://compare
        route    : String(120);     // key used in the launcher URL (?feature=<route>)
        component    : String(120); // UI5 component name of the feature UI, loaded by the launcher
        componentUrl : String(120); // URL of the component's webapp folder
        service  : String(120);     // OData service path of the feature (informational)
        position : Integer;         // ordering in the side navigation
        group    : String(20);      // 'FEATURE' | 'SYSTEM' (system items are shown at the bottom, e.g. Configuration)
  }
}

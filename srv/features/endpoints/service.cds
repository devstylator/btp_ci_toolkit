/**
 * Endpoints: inbound endpoints of deployed artifacts of DEV or PROD (CPI `ServiceEndpoints` API), filtered on the
 * server, with the sender channel's authentication and access role (read from the iFlows), the Process Integration
 * Runtime (PIR) instances granting that role (SAP Service Manager, when BTP platform access is configured) and
 * deployment information on request. Read only; nothing is persisted.
 */
@path: '/odata/v4/endpoints'
@requires: ['Viewer', 'Admin']
service EndpointsService {

  type Tenant : String enum { DEV; PROD; }
  type MessageLevel : String enum { INFO; WARN; ERROR; }

  type Message {
    tenant  : Tenant;
    level   : MessageLevel;
    message : String;
  }

  type Endpoint {
    tenant         : Tenant;
    iflowId        : String;
    iflowName      : String;
    adapter        : String;   // derived from the URL path / API protocol (exact type: details)
    protocol       : String;   // `Protocol` of the ServiceEndpoints API
    url            : String;
    path           : String;   // service path without the tenant host, e.g. /http/orders
    version        : String;
    /** Sender channel authentication / user role (comma separated when several); empty unless `accessRoles`. */
    authentication : String;
    userRole       : String;
    /** RUNTIME | DESIGNTIME | NONE (could not be read) | '' (not requested). */
    roleSource     : String;
    /** Names of the PIR instances granting the access role (comma separated); empty unless `pirsAvailable`. */
    pirs           : String;
  }

  type EndpointList {
    endpoints     : many Endpoint;
    /** True when access roles were read and the PIR instances of the tenant's subaccount could be read. */
    pirsAvailable : Boolean;
    messages      : many Message;  // skipped tenant, failed reads (summarized)
  }

  /** Process Integration Runtime instance (service `it-rt`). Never contains credentials. */
  type Pir {
    id             : String;
    name           : String;
    plan           : String;       // integration-flow | api | '' (plan not visible to the Service Manager key)
    roles          : many String;
    grantTypes     : many String;
    parametersRead : Boolean;
    spaceName      : String;
    orgName        : String;
    createdAt      : String;
    cockpitLink    : String;       // instance page in the BTP cockpit
    /** The requested roles (endpoint access role / `role` filter) this instance grants. */
    matchedRoles   : many String;
  }

  type PirList {
    pirs     : many Pir;
    messages : many Message;
  }

  type PackageInfo {
    id   : String;
    name : String;
  }

  type Property {
    ![key] : String;
    value : String;
  }

  type SenderChannel {
    name           : String;
    adapter        : String;
    address        : String;
    authentication : String;
    userRole       : String;
    certificates   : String;
    properties     : many Property;
    /** PIR instances granting `userRole`; empty when the platform access is not configured (`pirsAvailable`). */
    pirs           : many Pir;
  }

  type Deployment {
    version    : String;
    status     : String;
    deployedBy : String;
    deployedOn : Timestamp;
  }

  type EndpointDetails {
    deployment    : Deployment;
    /** Sender channels serving the URL; all sender channels when none could be matched (`matched=false`). */
    channels      : many SenderChannel;
    matched       : Boolean;
    contentSource : String;  // RUNTIME | DESIGNTIME | NONE
    pirsAvailable : Boolean;
    messages      : many Message;
  }

  /** Packages of a tenant (value help for the package filter). */
  function listPackages(tenant : Tenant) returns many PackageInfo;

  /**
   * Endpoints of one tenant. All filters are optional: `packageId` (iFlows of that package only), `iflow` (name or
   * ID), `url`, `role` are patterns (contains match; `*` any string, `+` one character, case-insensitive);
   * `adapter` is an exact adapter (HTTPS, SOAP, ...). `accessRoles` (default true; forced when `role` is given)
   * reads every listed iFlow to fill authentication and user role.
   */
  function listEndpoints(tenant : Tenant, packageId : String, iflow : String, url : String, adapter : String,
                         role : String, accessRoles : Boolean) returns EndpointList;

  /** Deployment information and sender channel (adapter, authentication, user role) of one endpoint. */
  function endpointDetails(tenant : Tenant, iflowId : String, url : String) returns EndpointDetails;

  /**
   * PIR instances of the tenant's subaccount (BTP platform access, see Configuration) with the roles they grant.
   * `role` (optional) is a pattern like the other filters; only instances granting a matching role are returned.
   * Not configured / disabled -> 412.
   */
  function listPirs(tenant : Tenant, role : String) returns PirList;
}

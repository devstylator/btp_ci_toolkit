/**
 * Endpoints: inbound endpoints of deployed artifacts of DEV or PROD (CPI `ServiceEndpoints` API), filtered on the
 * server, with the sender channel's authentication and access role (read from the iFlows) and deployment information
 * on request. Read only; nothing is persisted.
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
  }

  type EndpointList {
    endpoints : many Endpoint;
    messages  : many Message;  // skipped tenant, failed reads (summarized)
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
}

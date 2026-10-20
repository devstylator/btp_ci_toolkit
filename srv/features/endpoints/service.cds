/**
 * Endpoints: inbound endpoints of deployed artifacts on DEV and PROD (CPI `ServiceEndpoints` API), with the sender
 * channel's access role and deployment information on request. Read only; nothing is persisted.
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
    tenant    : Tenant;
    iflowId   : String;
    iflowName : String;
    adapter   : String;   // derived from the URL path / API protocol (exact type: details)
    protocol  : String;   // `Protocol` of the ServiceEndpoints API
    url       : String;
    version   : String;
  }

  type EndpointList {
    endpoints : many Endpoint;
    messages  : many Message;  // tenants that are not configured or failed are skipped with a message
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

  /** All endpoints of DEV and PROD. */
  function listEndpoints() returns EndpointList;

  /** Deployment information and sender channel (adapter, authentication, user role) of one endpoint. */
  function endpointDetails(tenant : Tenant, iflowId : String, url : String) returns EndpointDetails;
}

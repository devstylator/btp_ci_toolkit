/**
 * Search: finds iFlow configuration parameters (externalized parameters) and, in Groovy scripts of iFlows and
 * Script Collections, declared variables and the properties/headers read or written through the message API.
 * Read only; nothing is persisted (the result including a step log is returned by `search`).
 */
@path: '/odata/v4/search'
@requires: ['Viewer', 'Admin']
service SearchService {

  type Tenant : String enum { DEV; PROD; }
  type LogLevel : String enum { INFO; WARN; ERROR; }

  type ObjectType : String enum { IFLOW; SCRIPT; }

  /** PARAMETER = iFlow configuration parameter; the others are script findings. */
  type FindingKind : String enum {
    PARAMETER;
    VARIABLE;
    PROPERTY_READ;
    PROPERTY_WRITE;
    HEADER_READ;
    HEADER_WRITE;
  }

  type PackageInfo {
    id   : String;
    name : String;
  }

  type Finding {
    objectType   : ObjectType;
    kind         : FindingKind;
    name         : String;
    value        : String;
    dataType     : String;   // iFlow parameters
    packageId    : String;
    packageName  : String;
    artifactId   : String;
    artifactName : String;
    artifactType : String;   // IFLOW | SCRIPT_COLLECTION
    version      : String;
    scriptPath   : String;   // scripts: path inside the artifact
    line         : Integer;  // scripts: 1-based line of the finding
  }

  type SearchSummary {
    packages  : Integer;
    artifacts : Integer;
    scripts   : Integer;
    findings  : Integer;
    failures  : Integer;  // artifacts that could not be read (see log)
    truncated : Boolean;
  }

  type LogEntry {
    timestamp : Timestamp;
    level     : LogLevel;
    message   : String;
  }

  type SearchResult {
    success  : Boolean;
    summary  : SearchSummary;
    findings : many Finding;
    log      : many LogEntry;
  }

  /** Packages of a tenant (value help). */
  function listPackages(tenant : Tenant) returns many PackageInfo;

  /**
   * Searches a tenant (all packages or one). `name` and `value` are patterns (contains match; `*` any string,
   * `+` one character); at least one is required, both must match when both are given. `iflows` / `scripts`
   * select the object types (default: both).
   */
  function search(tenant : Tenant, packageId : String, name : String, value : String, caseSensitive : Boolean,
                  iflows : Boolean, scripts : Boolean) returns SearchResult;
}

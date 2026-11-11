/**
 * Version Comparator: lists the DEV packages and compares the artifact versions of one package between the DEV and
 * PROD CPI tenants. Nothing is persisted - the result (including a step log) is returned by the `compare` action.
 */
@path: '/odata/v4/version-comparator'
@requires: ['Viewer', 'Admin']
service VersionComparatorService {

  type ComparisonStatus : String enum {
    MATCH;
    MISMATCH;
    MISSING_IN_DEV;
    MISSING_IN_PROD;
  }

  type LogLevel : String enum { INFO; WARN; ERROR; }

  /** Package of the DEV tenant (no version: equal package versions say nothing about the artifacts). */
  type PackageInfo {
    id          : String;
    name        : String;
    description : String;
  }

  /** Package header of a comparison: where the package exists. */
  type PackageDetails {
    id          : String;
    name        : String;
    description : String;
    inDev       : Boolean;
    inProd      : Boolean;
  }

  type ComparisonRow {
    packageId    : String;
    artifactId   : String;
    artifactName : String;
    artifactType : String;      // IntegrationFlow | ValueMapping | MessageMapping | ScriptCollection
    devVersion   : String;
    prodVersion  : String;
    status       : ComparisonStatus;
  }

  type ComparisonSummary {
    total          : Integer;
    matching       : Integer;
    mismatching    : Integer;
    missingInDev   : Integer;
    missingInProd  : Integer;
  }

  type LogEntry {
    timestamp : Timestamp;
    level     : LogLevel;
    message   : String;
  }

  type ComparisonResult {
    success : Boolean;
    package : PackageDetails;
    summary : ComparisonSummary;
    rows    : many ComparisonRow;
    log     : many LogEntry;
  }

  /** Lists the packages of the DEV tenant. */
  function listPackages() returns many PackageInfo;

  /** Compares all artifacts of a package between DEV and PROD (version numbers). */
  action compare(packageId : String) returns ComparisonResult;
}

/**
 * Version Comparator: compares package/artifact versions between the DEV and PROD CPI tenants.
 * Nothing is persisted - the result (including a step log) is returned by the `compare` action.
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

  type PackageInfo {
    id    : String;
    name  : String;
    inDev : Boolean;
    inProd: Boolean;
  }

  type ArtifactInfo {
    id    : String;
    name  : String;
    type  : String;
    inDev : Boolean;
    inProd: Boolean;
  }

  type ComparisonRow {
    packageId    : String;
    artifactId   : String;      // empty for the package row itself
    artifactName : String;
    artifactType : String;      // PACKAGE | IntegrationFlow | ValueMapping | ...
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
    summary : ComparisonSummary;
    rows    : many ComparisonRow;
    log     : many LogEntry;
  }

  /** Lists packages found in DEV and/or PROD (value help). */
  function listPackages() returns many PackageInfo;

  /** Lists artifacts of a package found in DEV and/or PROD (value help). */
  function listArtifacts(packageId : String) returns many ArtifactInfo;

  /** Compares a package (all artifacts) or a single artifact (artifactId set). */
  action compare(packageId : String, artifactId : String) returns ComparisonResult;
}

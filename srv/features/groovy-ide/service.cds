using { btp.toolkit as db } from '../../../db/groovy-ide';

/**
 * Groovy IDE: edit, version and test CPI Groovy scripts and run them through the script-runner iFlow.
 * Scripts can be downloaded (read-only) from DEV iFlows / Script Collections; nothing is uploaded to CPI.
 * Viewer: read only. Developer: create/edit, download into the IDE, run.
 */
@path: '/odata/v4/groovy-ide'
@requires: ['Viewer', 'Developer']
service GroovyIdeService {

  @restrict: [
    { grant: 'READ', to: ['Viewer', 'Developer'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE', 'saveVersion'], to: 'Developer' }
  ]
  entity Scripts as projection on db.Scripts actions {
    /** Stores the current content (optionally the given one) as a new immutable version. */
    action saveVersion(comment : String, content : LargeString) returns ScriptVersions;
  };

  @restrict: [
    { grant: 'READ', to: ['Viewer', 'Developer'] },
    { grant: 'DELETE', to: 'Developer' }
  ]
  @Capabilities: { InsertRestrictions.Insertable: false, UpdateRestrictions.Updatable: false }
  entity ScriptVersions as projection on db.ScriptVersions;

  @restrict: [
    { grant: 'READ', to: ['Viewer', 'Developer'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'Developer' }
  ]
  entity TestCases as projection on db.TestCases;

  type NameValue {
    name  : String;
    value : String;
  }

  type RunResult {
    success    : Boolean;      // false on Groovy errors (runner HTTP 400) and runner failures
    httpStatus : Integer;
    body       : LargeString;
    headers    : many NameValue;
    properties : many NameValue;
    console    : LargeString;
    error      : LargeString;
    durationMs : Integer;
  }

  type TestCaseResult {
    testCaseId : UUID;
    name       : String;
    status     : String enum { PASSED; FAILED; ERROR; NO_EXPECTATION };
    result     : RunResult;
  }

  type ExecutorStatus {
    enabled : Boolean;          // executor configured and enabled by an Admin
    canRun  : Boolean;          // caller has the Developer role
  }

  type PackageInfo {
    id   : String;
    name : String;
  }

  type ArtifactInfo {
    id      : String;
    name    : String;
    type    : String enum { IFLOW; SCRIPT_COLLECTION };
    version : String;
  }

  type ScriptFile {
    path    : String;
    content : LargeString;
  }

  type ArtifactScripts {
    packageId    : String;
    artifactId   : String;
    artifactName : String;
    type         : String;
    version      : String;
    scripts      : many ScriptFile;
  }

  function executorStatus() returns ExecutorStatus;

  /** DEV packages (download source). */
  function listPackages() returns many PackageInfo;

  /** iFlows and Script Collections of a DEV package. */
  function listArtifacts(packageId : String) returns many ArtifactInfo;

  /** Downloads the artifact (active version) from DEV and returns its Groovy files. Read only. */
  function listArtifactScripts(packageId : String, type : String, artifactId : String) returns ArtifactScripts;

  /** Runs a script through the script-runner iFlow. Nothing is stored. */
  @requires: 'Developer'
  action run(script : LargeString, payload : LargeString, headers : many NameValue, properties : many NameValue) returns RunResult;

  /** Runs `script` against test cases of a saved script (all, or the given IDs) and compares the output body. */
  @requires: 'Developer'
  action runTests(scriptId : UUID, script : LargeString, testCaseIds : many UUID) returns many TestCaseResult;
}

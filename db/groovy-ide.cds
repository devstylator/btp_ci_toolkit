namespace btp.toolkit;

using { cuid, managed } from '@sap/cds/common';

/**
 * Groovy IDE: scripts edited in the app, their immutable versions and test cases (shared by all users).
 * Scripts are created from scratch or downloaded (read-only) from a DEV iFlow / Script Collection.
 */
entity Scripts : cuid, managed {
  name                  : String(120) @mandatory;
  description           : String(500);
  content               : LargeString;           // working copy, overwritten by Save
  sourceType            : String(20) enum { LOCAL; IFLOW; SCRIPT_COLLECTION } default 'LOCAL';
  sourceTenant          : String(10);            // DEV when downloaded
  sourcePackageId       : String(255);
  sourceArtifactId      : String(255);
  sourceArtifactName    : String(255);
  sourceArtifactVersion : String(40);
  sourcePath            : String(500);           // file inside the artifact zip
  versions              : Composition of many ScriptVersions on versions.script = $self;
  testCases             : Composition of many TestCases on testCases.script = $self;
}

/** Immutable snapshot of a script, created by the `saveVersion` action. */
entity ScriptVersions : cuid, managed {
  script  : Association to Scripts;
  version : Integer;
  comment : String(500);
  content : LargeString;
}

/** Input of a script run, optionally with the expected output body. Headers/properties: JSON `[{name, value}]`. */
entity TestCases : cuid, managed {
  script       : Association to Scripts;
  name         : String(120) @mandatory;
  payload      : LargeString;
  headers      : LargeString;
  properties   : LargeString;
  expectedBody : LargeString;
  compareMode  : String(10) enum { EXACT; TRIMMED; JSON; XML } default 'TRIMMED';
}

/**
 * The script-runner iFlow (see docs/groovy-ide.md) that executes Groovy scripts. Exactly one row, `DEFAULT`,
 * created on first read. Same credential options as Connections; the secret is write-only.
 */
entity ScriptExecutor : managed {
  key code            : String(10) enum { DEFAULT };
      connectionMode  : String(20) enum { DIRECT; DESTINATION } default 'DIRECT';
      endpointUrl     : String(500);   // full HTTPS endpoint of the runner iFlow (Direct mode)
      tokenUrl        : String(255);
      clientId        : String(255);
      clientSecretEnc : LargeString;   // AES-256-GCM encrypted, never exposed through any service
      destinationName : String(255);   // destination URL = full endpoint URL (Destination mode)
      enabled         : Boolean default false;
      lastTestAt      : Timestamp;
      lastTestOk      : Boolean;
      lastTestMessage : String(500);
}

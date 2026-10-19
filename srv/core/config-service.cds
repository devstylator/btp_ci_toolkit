using { btp.toolkit as db } from '../../db/connections';
using { btp.toolkit.ScriptExecutor as Executor } from '../../db/groovy-ide';

/**
 * Configuration of the CPI connections (DEV / PROD). Admin only.
 * Also the script executor (runner iFlow) used by the Groovy IDE.
 * Client secrets are write-only: set them with the `setSecret` action, read `secretSet` to know if one is stored.
 */
@path: '/odata/v4/config'
@requires: 'Admin'
service ConfigService {

  @readonly
  @cds.persistence.skip
  entity ConnectionModes {
    key code : String(20);
        name : String(60);
  }

  @restrict: [{ grant: ['READ', 'UPDATE', 'test', 'setSecret'], to: 'Admin' }]
  @Capabilities: {
    InsertRestrictions.Insertable : false,
    DeleteRestrictions.Deletable  : false
  }
  @odata.draft.enabled
  entity Connections as projection on db.Connections {
    *,
    virtual null as secretSet : Boolean   // filled on read
  } excluding { clientSecretEnc }
  actions {
    /** Stores the OAuth client secret (encrypted). It can never be read back. */
    action setSecret(secret : String) returns Boolean;

    /** Requests an OAuth token and calls the CPI API to verify the connection. */
    action test() returns TestResult;
  };

  type TestResult {
    ok      : Boolean;
    message : String;
  }

  /** Script-runner iFlow used by the Groovy IDE. Exactly one row (`DEFAULT`), created on first read. */
  @restrict: [{ grant: ['READ', 'UPDATE', 'test', 'setSecret'], to: 'Admin' }]
  @Capabilities: {
    InsertRestrictions.Insertable : false,
    DeleteRestrictions.Deletable  : false
  }
  @odata.draft.enabled
  entity ScriptExecutor as projection on Executor {
    *,
    virtual null as secretSet : Boolean   // filled on read
  } excluding { clientSecretEnc }
  actions {
    /** Stores the OAuth client secret (encrypted). It can never be read back. */
    action setSecret(secret : String) returns Boolean;

    /** Runs a trivial script through the runner iFlow. */
    action test() returns TestResult;
  };
}

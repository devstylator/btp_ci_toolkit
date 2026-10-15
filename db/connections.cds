namespace btp.toolkit;

using { managed } from '@sap/cds/common';

/**
 * Connection to one SAP Integration Suite (CPI) tenant.
 * Environments are fixed (DEV, PROD) - rows are seeded from db/data and can only be updated.
 */
entity Connections : managed {
  key code          : String(10) enum { DEV; PROD };
      name          : String(60);
      tenantUrl     : String(255);   // API base URL, e.g. https://<tenant>.it-cpi001.cfapps.eu10.hana.ondemand.com
      tokenUrl      : String(255);   // OAuth2 token endpoint, e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token
      clientId      : String(255);
      clientSecretEnc : LargeString;  // AES-256-GCM encrypted, never exposed through any service
      enabled       : Boolean default true;
      lastTestAt      : Timestamp;
      lastTestOk      : Boolean;
      lastTestMessage : String(500);
}

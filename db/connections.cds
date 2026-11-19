namespace btp.toolkit;

using { managed } from '@sap/cds/common';

/**
 * Connection to one SAP Integration Suite (CPI) tenant.
 * Environments are fixed (DEV, PROD) - rows are seeded from db/data and can only be updated.
 */
entity Connections : managed {
  key code          : String(10) enum { DEV; PROD };
      name          : String(60);
      connectionMode : String(20) enum { DIRECT; DESTINATION } default 'DIRECT';
      destinationName : String(255);
      allowModifications : Boolean default false;
      tenantUrl     : String(255);   // API base URL, e.g. https://<tenant>.it-cpi001.cfapps.eu10.hana.ondemand.com
      tokenUrl      : String(255);   // OAuth2 token endpoint, e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token
      clientId      : String(255);
      clientSecretEnc : LargeString;  // AES-256-GCM encrypted, never exposed through any service
      enabled       : Boolean default true;
      lastTestAt      : Timestamp;
      lastTestOk      : Boolean;
      lastTestMessage : String(500);
}

/**
 * Read access to the BTP platform of one environment's subaccount (SAP Service Manager), used to list the Process
 * Integration Runtime (PIR, `it-rt`) instances and the roles they grant. One row per environment (DEV, PROD),
 * created on first read. Service key of a `service-manager` instance (plan `subaccount-audit` is enough).
 */
entity PlatformAccess : managed {
  key code            : String(10) enum { DEV; PROD };
      connectionMode  : String(20) enum { DIRECT; DESTINATION } default 'DIRECT';
      smUrl           : String(255);   // `sm_url` of the service key
      tokenUrl        : String(255);   // `url` of the service key + /oauth/token
      clientId        : String(255);
      clientSecretEnc : LargeString;   // AES-256-GCM encrypted, never exposed through any service
      destinationName : String(255);   // destination URL = sm_url (Destination mode)
      cockpitUrl      : String(255) default 'https://emea.cockpit.btp.cloud.sap/cockpit'; // links to the PIR instances
      enabled         : Boolean default false;
      lastTestAt      : Timestamp;
      lastTestOk      : Boolean;
      lastTestMessage : String(500);
}

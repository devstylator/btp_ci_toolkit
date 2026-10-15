using ConfigService as service from '../../srv/core/config-service';

annotate service.Connections with {
  code            @title: 'Environment';
  name            @title: 'Name';
  tenantUrl       @title: 'Tenant URL'       @description: 'API base URL of the Integration Suite tenant';
  tokenUrl        @title: 'Token URL'        @description: 'OAuth2 token endpoint from the service key';
  clientId        @title: 'Client ID';
  secretSet       @title: 'Client secret stored';
  enabled         @title: 'Enabled';
  lastTestAt      @title: 'Last test'        @readonly;
  lastTestOk      @title: 'Last test successful' @readonly;
  lastTestMessage @title: 'Last test message' @readonly;
};

annotate service.Connections with @(
  UI.HeaderInfo: {
    TypeName      : 'Connection',
    TypeNamePlural: 'Connections',
    Title         : { Value: name },
    Description   : { Value: code }
  },

  UI.LineItem: [
    { Value: code },
    { Value: name },
    { Value: tenantUrl },
    { Value: secretSet },
    { Value: enabled },
    { Value: lastTestOk },
    { Value: lastTestAt }
  ],

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'ConfigService.test', Label: 'Test connection' }
  ],

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Connection', Label: 'Connection',           Target: '@UI.FieldGroup#Connection' },
    { $Type: 'UI.ReferenceFacet', ID: 'Test',       Label: 'Last connection test', Target: '@UI.FieldGroup#Test' }
  ],

  UI.FieldGroup #Connection: {
    Data: [
      { Value: name },
      { Value: tenantUrl },
      { Value: tokenUrl },
      { Value: clientId },
      { Value: secretSet },
      { Value: enabled }
    ]
  },

  UI.FieldGroup #Test: {
    Data: [
      { Value: lastTestAt },
      { Value: lastTestOk },
      { Value: lastTestMessage }
    ]
  }
);

// setSecret is invoked from a custom header action (webapp/ext/SecretAction.js) to get a masked input.
annotate service.Connections actions {
  @Common.SideEffects: { TargetProperties: ['in/lastTestAt', 'in/lastTestOk', 'in/lastTestMessage'] }
  test();
};

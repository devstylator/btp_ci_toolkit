using ConfigService as service from '../../srv/core/config-service';

annotate service.Connections with {
  code            @title: 'Environment';
  name            @title: 'Name';
  connectionMode  @title: 'Connection mode'
    @Common.ValueListWithFixedValues: true
    @Common.ValueList: {
      CollectionPath: 'ConnectionModes',
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: connectionMode, ValueListProperty: 'code' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
      ]
    };
  destinationName @title: 'BTP Destination name'
    @description: 'Name of an OAuth2ClientCredentials destination in the application subaccount';
  allowModifications @title: 'Allow CPI modifications'
    @description: 'Allows tools to change this CPI tenant, subject to CPI permissions. Off means read only.';
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
    { Value: connectionMode },
    { Value: destinationName },
    { Value: allowModifications },
    { Value: enabled },
    { Value: lastTestOk },
    { Value: lastTestAt }
  ],

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'ConfigService.test', Label: 'Test connection' }
  ],

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Connection', Label: 'Connection',           Target: '@UI.FieldGroup#Connection' },
    { $Type: 'UI.ReferenceFacet', ID: 'Direct', Label: 'Direct credentials', Target: '@UI.FieldGroup#Direct', ![@UI.Hidden]: (connectionMode = 'DESTINATION') },
    { $Type: 'UI.ReferenceFacet', ID: 'Destination', Label: 'BTP Destination', Target: '@UI.FieldGroup#Destination', ![@UI.Hidden]: (connectionMode <> 'DESTINATION') },
    { $Type: 'UI.ReferenceFacet', ID: 'Test',       Label: 'Last connection test', Target: '@UI.FieldGroup#Test' }
  ],

  UI.FieldGroup #Connection: {
    Data: [
      { Value: name },
      { Value: connectionMode },
      { Value: enabled },
      { Value: allowModifications }
    ]
  },

  UI.FieldGroup #Destination: {
    Data: [{ Value: destinationName }]
  },

  UI.FieldGroup #Direct: {
    Data: [
      { Value: tenantUrl },
      { Value: tokenUrl },
      { Value: clientId },
      { Value: secretSet }
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

// Tabs of the list report (one per entity set, see manifest "views").
annotate service.Connections with @(
  UI.SelectionPresentationVariant #Connections: {
    Text               : 'CPI connections',
    SelectionVariant   : { SelectOptions: [] },
    PresentationVariant: { Visualizations: ['@UI.LineItem'] }
  }
);

annotate service.ScriptExecutor with {
  code            @title: 'Executor';
  connectionMode  @title: 'Connection mode'
    @Common.ValueListWithFixedValues: true
    @Common.ValueList: {
      CollectionPath: 'ConnectionModes',
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: connectionMode, ValueListProperty: 'code' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
      ]
    };
  endpointUrl     @title: 'Endpoint URL'
    @description: 'Full HTTPS endpoint of the script-runner iFlow, e.g. https://<tenant>-rt.cfapps.<region>.hana.ondemand.com/http/groovy/execute';
  tokenUrl        @title: 'Token URL'        @description: 'OAuth2 token endpoint of the integration-flow service key';
  clientId        @title: 'Client ID';
  secretSet       @title: 'Client secret stored';
  destinationName @title: 'BTP Destination name'
    @description: 'OAuth2ClientCredentials destination whose URL is the full runner endpoint';
  enabled         @title: 'Script execution enabled'
    @description: 'Developers can run scripts in the Groovy IDE only when this is on';
  lastTestAt      @title: 'Last test'        @readonly;
  lastTestOk      @title: 'Last test successful' @readonly;
  lastTestMessage @title: 'Last test message' @readonly;
};

annotate service.ScriptExecutor with @(
  UI.HeaderInfo: {
    TypeName      : 'Script executor',
    TypeNamePlural: 'Script executor',
    Title         : { Value: 'Script executor (Groovy IDE)' },
    Description   : { Value: endpointUrl }
  },

  UI.SelectionPresentationVariant #Executor: {
    Text               : 'Script executor (Groovy IDE)',
    SelectionVariant   : { SelectOptions: [] },
    PresentationVariant: { Visualizations: ['@UI.LineItem'] }
  },

  UI.LineItem: [
    { Value: connectionMode },
    { Value: endpointUrl },
    { Value: destinationName },
    { Value: enabled },
    { Value: lastTestOk },
    { Value: lastTestAt }
  ],

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'ConfigService.test', Label: 'Test executor' }
  ],

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Executor', Label: 'Script executor', Target: '@UI.FieldGroup#Executor' },
    { $Type: 'UI.ReferenceFacet', ID: 'Direct', Label: 'Direct credentials', Target: '@UI.FieldGroup#Direct', ![@UI.Hidden]: (connectionMode = 'DESTINATION') },
    { $Type: 'UI.ReferenceFacet', ID: 'Destination', Label: 'BTP Destination', Target: '@UI.FieldGroup#Destination', ![@UI.Hidden]: (connectionMode <> 'DESTINATION') },
    { $Type: 'UI.ReferenceFacet', ID: 'Test', Label: 'Last executor test', Target: '@UI.FieldGroup#Test' }
  ],

  UI.FieldGroup #Executor: {
    Data: [
      { Value: connectionMode },
      { Value: enabled }
    ]
  },

  UI.FieldGroup #Destination: {
    Data: [{ Value: destinationName }]
  },

  UI.FieldGroup #Direct: {
    Data: [
      { Value: endpointUrl },
      { Value: tokenUrl },
      { Value: clientId },
      { Value: secretSet }
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

annotate service.ScriptExecutor actions {
  @Common.SideEffects: { TargetProperties: ['in/lastTestAt', 'in/lastTestOk', 'in/lastTestMessage'] }
  test();
};

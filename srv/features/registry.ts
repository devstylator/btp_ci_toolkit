export interface FeatureDescriptor {
  ID: string
  title: string
  subtitle?: string
  icon: string
  route: string
  /** UI5 component name and the URL of its webapp folder; the launcher loads it on demand. */
  component: string
  componentUrl: string
  service?: string
  position: number
  group: 'FEATURE' | 'SYSTEM'
  /** Roles allowed to see the entry (any of). */
  roles: string[]
}

/**
 * Feature registry - the single place where features are announced to the UI.
 * To add a feature follow docs/adding-a-feature.md (service, `using from` in srv/index.cds, an entry here, UI in app/<name>/webapp).
 */
export const features: FeatureDescriptor[] = [
  {
    ID: 'version-comparator',
    title: 'Version Comparator',
    subtitle: 'Compare package and artifact versions between DEV and PROD',
    icon: 'sap-icon://compare',
    route: 'version-comparator',
    component: 'btp.toolkit.versioncomparator',
    componentUrl: '/version-comparator/webapp',
    service: '/odata/v4/version-comparator',
    position: 10,
    group: 'FEATURE',
    roles: ['Viewer', 'Admin']
  },
  {
    ID: 'groovy-ide',
    title: 'Groovy IDE',
    subtitle: 'Edit, version and test Groovy scripts on the CPI script runner',
    icon: 'sap-icon://source-code',
    route: 'groovy-ide',
    component: 'btp.toolkit.groovyide',
    componentUrl: '/groovy-ide/webapp',
    service: '/odata/v4/groovy-ide',
    position: 20,
    group: 'FEATURE',
    roles: ['Viewer', 'Developer']
  },
  {
    ID: 'endpoints',
    title: 'Endpoints',
    subtitle: 'Inbound endpoints of DEV and PROD with adapter, access role and deployment',
    icon: 'sap-icon://chain-link',
    route: 'endpoints',
    component: 'btp.toolkit.endpoints',
    componentUrl: '/endpoints/webapp',
    service: '/odata/v4/endpoints',
    position: 30,
    group: 'FEATURE',
    roles: ['Viewer', 'Admin']
  },
  {
    ID: 'search',
    title: 'Search',
    subtitle: 'Find iFlow parameters, script variables, properties and headers by name or value',
    icon: 'sap-icon://search',
    route: 'search',
    component: 'btp.toolkit.search',
    componentUrl: '/search/webapp',
    service: '/odata/v4/search',
    position: 40,
    group: 'FEATURE',
    roles: ['Viewer', 'Admin']
  },
  {
    ID: 'configuration',
    title: 'Configuration',
    subtitle: 'DEV and PROD connections',
    icon: 'sap-icon://action-settings',
    route: 'configuration',
    component: 'btp.toolkit.configuration',
    componentUrl: '/configuration/webapp',
    service: '/odata/v4/config',
    position: 1000,
    group: 'SYSTEM',
    roles: ['Admin']
  }
]

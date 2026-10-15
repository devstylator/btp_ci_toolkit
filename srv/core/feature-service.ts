import cds from '@sap/cds'
import { features } from '../features/registry.js'

export default class FeatureService extends cds.ApplicationService {
  async init() {
    this.on('READ', 'Features', (req: any) => {
      const visible = features
        .filter(f => f.roles.some(r => req.user.is(r)))
        .sort((a, b) => a.position - b.position)
        .map(({ roles, ...f }) => f)
      const key = req.data?.ID
      return key ? visible.find(f => f.ID === key) : visible
    })
    return super.init()
  }
}

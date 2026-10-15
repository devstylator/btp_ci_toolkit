export type Status = 'MATCH' | 'MISMATCH' | 'MISSING_IN_DEV' | 'MISSING_IN_PROD'

export interface Item {
  id: string
  name: string
  type: string
  version: string
}

export interface Row {
  packageId: string
  artifactId: string
  artifactName: string
  artifactType: string
  devVersion: string | null
  prodVersion: string | null
  status: Status
}

/** Artifact collections of an integration package in the CPI Management API. */
export const ARTIFACT_TYPES: { entitySet: string; type: string }[] = [
  { entitySet: 'IntegrationDesigntimeArtifacts', type: 'IntegrationFlow' },
  { entitySet: 'ValueMappingDesigntimeArtifacts', type: 'ValueMapping' },
  { entitySet: 'MessageMappingDesigntimeArtifacts', type: 'MessageMapping' },
  { entitySet: 'ScriptCollectionDesigntimeArtifacts', type: 'ScriptCollection' }
]

const keyOf = (i: Item) => `${i.type}:${i.id}`

export function compareItems(packageId: string, dev: Item[], prod: Item[]): Row[] {
  const devMap = new Map(dev.map(i => [keyOf(i), i]))
  const prodMap = new Map(prod.map(i => [keyOf(i), i]))
  const keys = [...new Set([...devMap.keys(), ...prodMap.keys()])].sort((a, b) => +!a.startsWith('PACKAGE:') - +!b.startsWith('PACKAGE:') || a.localeCompare(b))
  return keys.map(k => {
    const d = devMap.get(k)
    const p = prodMap.get(k)
    const ref = (d ?? p)!
    const status: Status = !d ? 'MISSING_IN_DEV' : !p ? 'MISSING_IN_PROD' : d.version === p.version ? 'MATCH' : 'MISMATCH'
    return {
      packageId,
      artifactId: ref.type === 'PACKAGE' ? '' : ref.id,
      artifactName: ref.name,
      artifactType: ref.type,
      devVersion: d?.version ?? null,
      prodVersion: p?.version ?? null,
      status
    }
  })
}

export function summarize(rows: Row[]) {
  const count = (s: Status) => rows.filter(r => r.status === s).length
  return {
    total: rows.length,
    matching: count('MATCH'),
    mismatching: count('MISMATCH'),
    missingInDev: count('MISSING_IN_DEV'),
    missingInProd: count('MISSING_IN_PROD')
  }
}

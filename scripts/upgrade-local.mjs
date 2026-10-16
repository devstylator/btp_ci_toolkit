import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cds from '@sap/cds'

/** Add the configuration fields to existing SQLite installations without recreating tables or loading seeds. */
export async function upgradeLocal(filename = 'db.sqlite') {
  const path = resolve(filename)
  if (!existsSync(path)) throw new Error('Database does not exist; use npm run deploy:local for a new installation')
  const model = await cds.load('*')
  const view = cds.compile.to.sql(model, { dialect: 'sqlite' }).find(statement => statement.startsWith('CREATE VIEW ConfigService_Connections AS'))
  if (!view) throw new Error('Connection service view was not found in the current model')
  const db = new DatabaseSync(path)
  try {
    const tables = ['btp_toolkit_Connections', 'ConfigService_Connections_drafts']
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(tables[0])) {
      throw new Error('Connections table not found; this database cannot be upgraded')
    }
    db.exec('BEGIN IMMEDIATE')
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all()
      if (!columns.length) continue
      for (const [name, definition] of [
        ['connectionMode', "NVARCHAR(20) DEFAULT 'DIRECT'"],
        ['destinationName', 'NVARCHAR(255)'],
        ['allowModifications', 'BOOLEAN DEFAULT 0']
      ]) {
        if (!columns.some(column => String(column.name).toLowerCase() === name.toLowerCase())) {
          db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`)
        }
      }
    }
    db.exec('DROP VIEW IF EXISTS ConfigService_Connections')
    db.exec(view)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await upgradeLocal(process.argv[2])
  console.log('Local configuration schema upgraded; existing settings preserved')
}

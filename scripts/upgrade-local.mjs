import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cds from '@sap/cds'

/**
 * Upgrade existing SQLite installations without recreating tables or loading seeds: add the configuration
 * fields, create tables of new features (e.g. Groovy IDE) and recreate all views from the current model.
 * Groovy IDE test cases (removed) are moved into ScriptInputs: their name and input are kept, expectations dropped.
 */
export async function upgradeLocal(filename = 'db.sqlite') {
  const path = resolve(filename)
  if (!existsSync(path)) throw new Error('Database does not exist; use npm run deploy:local for a new installation')
  const model = await cds.load('*')
  const statements = cds.compile.to.sql(model, { dialect: 'sqlite' })
  const nameOf = statement => /^CREATE (?:TABLE|VIEW) "?([^\s"(]+)/.exec(statement)[1]
  const tables = statements.filter(statement => statement.startsWith('CREATE TABLE'))
  const views = statements.filter(statement => statement.startsWith('CREATE VIEW'))
  if (!views.some(view => nameOf(view) === 'ConfigService_Connections')) throw new Error('Connection service view was not found in the current model')
  const db = new DatabaseSync(path)
  try {
    const exists = name => !!db.prepare("SELECT name FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(name)
    const connectionTables = ['btp_toolkit_Connections', 'ConfigService_Connections_drafts']
    if (!exists(connectionTables[0])) {
      throw new Error('Connections table not found; this database cannot be upgraded')
    }
    db.exec('BEGIN IMMEDIATE')
    for (const table of connectionTables) {
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
    for (const table of tables) {
      if (!exists(nameOf(table))) db.exec(table)
    }
    if (exists('btp_toolkit_TestCases')) {
      const columns = 'ID, createdAt, createdBy, modifiedAt, modifiedBy, script_ID, name, payload, headers, properties'
      db.exec(`INSERT INTO btp_toolkit_ScriptInputs (${columns}) SELECT ${columns} FROM btp_toolkit_TestCases
        WHERE ID NOT IN (SELECT ID FROM btp_toolkit_ScriptInputs)`)
      db.exec('DROP VIEW IF EXISTS GroovyIdeService_TestCases')
      db.exec('DROP TABLE btp_toolkit_TestCases')
    }
    for (const view of views) db.exec(`DROP VIEW IF EXISTS "${nameOf(view)}"`)
    for (const view of views) db.exec(view)
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
  console.log('Local database schema upgraded; existing settings and data preserved')
}

// Copies the UI apps into the production server bundle so CAP serves them (same as locally).
import { cpSync, rmSync } from 'node:fs'

rmSync('gen/srv/app', { recursive: true, force: true })
// .cds files (UI annotations) are already compiled into srv/csn.json; loading them again would clash
cpSync('app', 'gen/srv/app', { recursive: true, filter: (src) => !src.endsWith('.cds') })

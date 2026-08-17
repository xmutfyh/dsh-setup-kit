#!/usr/bin/env node
/**
 * Smoke test: scan the real local session stores and run a few searches.
 * Requires the plugin to be built (lib/) and real session files present.
 */
import { discoverFiles } from '../lib/discovery.js'
import { defaultRoots } from '../lib/discovery.js'
import { searchArtifacts } from '../lib/search.js'

const roots = defaultRoots()
const enabled = new Set(['dsh', 'codex', 'claude', 'pi', 'opencode'])

const files = await discoverFiles(enabled, roots)
console.log(`discovered ${files.length} artifacts`)
for (const f of files.slice(0, 10)) console.log(`  ${f.source} ${f.path}`)

const query = 'session search'
const started = Date.now()
const hits = await searchArtifacts(files, enabled, { query, limit: 3 })
console.log(`\nquery "${query}": ${hits.length} hits (${Date.now() - started}ms)`)
for (const hit of hits) {
  console.log(`  [${hit.session.source}] ${hit.session.title} (${hit.session.cwd})`)
  console.log(`    snippet: ${hit.snippet.slice(0, 120)}`)
}

/**
 * Session-file discovery across all supported agent sources.
 *
 * Each source family declares a root and a walk pattern; discovery returns
 * the candidate files with their logical source and session id derived from
 * the path. The dsh source additionally resolves zstd-compressed logs.
 * @module @dsh-external/dsh-session-search/discovery
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import type { AgentSource } from './types.js'

/** One discovered session artifact. */
export interface SessionFile {
  /** Source family owning the file. */
  source: AgentSource
  /** Absolute path of the artifact. */
  path: string
  /** Session id derived from the path (source-native). */
  sessionId: string
}

/** Resolved per-source roots; overrides only replace the default home root. */
export interface SourceRoots {
  /** dsh session store (`$DSH_HOME/sessions`). */
  dsh?: string
  /** Codex session + archived session roots (`~/.codex`). */
  codex?: string
  /** Claude Code project transcripts (`~/.claude/projects`). */
  claude?: string
  /** pi session store (`~/.pi/agent/sessions`). */
  pi?: string
  /** OpenCode data dir containing `opencode.db` (`~/.local/share/opencode`). */
  opencode?: string
}

/** Default per-source roots under the current user's home. */
export function defaultRoots(): Required<SourceRoots> {
  const home = homedir()
  return {
    dsh: join(home, '.dsh', 'sessions'),
    codex: join(home, '.codex'),
    claude: join(home, '.claude', 'projects'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    opencode: join(home, '.local', 'share', 'opencode'),
  }
}

/** Recursively list regular files under `root`, bounded by depth. */
async function walkFiles(root: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // absent or unreadable root: no files
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path, maxDepth, depth + 1))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}

/** Basename without any `.jsonl` / `.jsonl.zstd` suffix. */
function bareSessionId(name: string): string {
  return name.replace(/\.jsonl(\.zstd)?$/, '')
}

/**
 * Discover candidate session artifacts for the enabled sources.
 * @param enabled - set of enabled source families.
 * @param roots - per-source roots (defaults fill gaps).
 * @returns discovered files, newest-mtime first per source.
 */
export async function discoverFiles(
  enabled: ReadonlySet<AgentSource>,
  roots: SourceRoots = {},
): Promise<SessionFile[]> {
  const all = defaultRoots()
  const files: SessionFile[] = []

  if (enabled.has('dsh')) {
    // dsh: <root>/<sanitized-cwd>/<session-dir>/session.jsonl.zstd
    const root = roots.dsh ?? all.dsh
    for (const path of await walkFiles(root, 4)) {
      const name = path.split(sep).pop() ?? ''
      if (name === 'session.jsonl.zstd' || name === 'main-session.jsonl.zstd' || name.endsWith('.jsonl.zstd')) {
        const sessionId = name === 'session.jsonl.zstd' || name === 'main-session.jsonl.zstd'
          ? basename(dirname(path))
          : bareSessionId(name)
        files.push({ source: 'dsh', path, sessionId })
      }
    }
  }

  if (enabled.has('codex')) {
    // codex: <root>/sessions/YYYY/MM/DD/rollout-<id>.jsonl + archived_sessions/
    const root = roots.codex ?? all.codex
    for (const dir of ['sessions', 'archived_sessions']) {
      for (const path of await walkFiles(join(root, dir), 5)) {
        if (path.endsWith('.jsonl')) {
          const name = path.split(sep).pop() ?? ''
          files.push({ source: 'codex', path, sessionId: bareSessionId(name) })
        }
      }
    }
  }

  if (enabled.has('claude')) {
    // claude: <root>/<sanitized-cwd>/<uuid>.jsonl (subagent files live beside)
    const root = roots.claude ?? all.claude
    for (const path of await walkFiles(root, 3)) {
      if (path.endsWith('.jsonl')) {
        const name = path.split(sep).pop() ?? ''
        if (name.startsWith('agent-')) continue // subagent transcripts are part of the parent
        files.push({ source: 'claude', path, sessionId: bareSessionId(name) })
      }
    }
  }

  if (enabled.has('pi')) {
    // pi: <root>/<sanitized-cwd>/<ts>_<id>.jsonl
    const root = roots.pi ?? all.pi
    for (const path of await walkFiles(root, 3)) {
      if (path.endsWith('.jsonl')) {
        const name = path.split(sep).pop() ?? ''
        files.push({ source: 'pi', path, sessionId: bareSessionId(name) })
      }
    }
  }

  if (enabled.has('opencode')) {
    // opencode: single SQLite database <root>/opencode.db
    const root = roots.opencode ?? all.opencode
    const dbPath = join(root, 'opencode.db')
    try {
      const st = await stat(dbPath)
      if (st.isFile()) files.push({ source: 'opencode', path: dbPath, sessionId: 'opencode-db' })
    } catch {
      // absent source database: nothing to search
    }
  }

  return files
}

/** Relative path from the root, used by diagnostics. */
export function relativePath(root: string, path: string): string {
  return relative(root, path)
}

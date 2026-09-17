/**
 * Filesystem primitives over the `allure-results` directory: listing, stability checks and the handful of
 * chunking/grouping helpers the streaming push and the final reconciliation pass both need.
 *
 * No `fs.watch` anywhere here — see the module doc in `watcher.ts` for why a poll loop is used instead.
 */

import { readFile, readdir, stat, lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export interface FileSnapshot {
  mtimeMs: number
  size: number
}

async function listByExt(dir: string, ext: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // The directory may not exist yet the first few polls — a reporter often creates it lazily on its
    // first write, which is not an error worth surfacing.
    return []
  }
  return entries.filter(e => e.isFile() && e.name.endsWith(ext)).map(e => path.join(dir, e.name)).sort()
}

export const listResultFiles = (dir: string): Promise<string[]> => listByExt(dir, '-result.json')
export const listContainerFiles = (dir: string): Promise<string[]> => listByExt(dir, '-container.json')

export async function snapshot(file: string): Promise<FileSnapshot | null> {
  try {
    const s = await stat(file)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

export async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Mirrors `allureImportService.ts`'s `parseEnvironmentProperties` — trivial enough that importing across
 * packages would cost more than the duplication. */
export async function readEnvironmentProperties(dir: string): Promise<Array<{ key: string; value: string }>> {
  let text: string
  try {
    const file = path.join(await realpath(dir), 'environment.properties')
    const expected = await lstat(file)
    // Optional report metadata must not turn a supplied symlink into a read of the runner's .env.
    if (!expected.isFile()) return []
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      // Read the checked descriptor, not the path again. This also refuses replacements on platforms
      // without O_NOFOLLOW; O_NONBLOCK keeps a concurrent replacement with a FIFO from hanging CI.
      const actual = await handle.stat()
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) return []
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
  const pairs: Array<{ key: string; value: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    pairs.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
  }
  return pairs
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Associates each raw `-container.json` with the results chunk(s) it can attach to, so the final
 * reconciliation pass (which may need several `/results` requests once a suite exceeds the server's
 * 200-per-batch cap) still lands each container in the *same request* as a result it links to — the
 * server's `attachContainers` only matches uuids within one request body, so a container sent alongside
 * results it has nothing to do with is silently ignored, but one sent alone (no matching result in that
 * same request) can never attach at all.
 */
export function groupContainersByResultChunk(resultChunks: unknown[][], containers: unknown[]): unknown[][] {
  const chunkOfUuid = new Map<string, number>()
  resultChunks.forEach((results, idx) => {
    for (const r of results) {
      const uuid = (r as { uuid?: unknown } | null)?.uuid
      if (typeof uuid === 'string') chunkOfUuid.set(uuid, idx)
    }
  })

  const perChunk: unknown[][] = resultChunks.map(() => [])
  for (const container of containers) {
    const children = Array.isArray((container as { children?: unknown } | null)?.children)
      ? (container as { children: unknown[] }).children
      : []
    const matchedChunks = new Set<number>()
    for (const child of children) {
      const idx = chunkOfUuid.get(String(child))
      if (idx !== undefined) matchedChunks.add(idx)
    }
    // An orphaned container (its children aren't in any chunk we know about, e.g. a root suite container)
    // still needs somewhere to go — the last chunk is as good a guess as any, and a mismatch is harmless.
    if (matchedChunks.size === 0 && resultChunks.length > 0) matchedChunks.add(resultChunks.length - 1)
    for (const idx of matchedChunks) perChunk[idx]!.push(container)
  }
  return perChunk
}

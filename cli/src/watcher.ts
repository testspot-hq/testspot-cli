/**
 * The streaming half of `testpilot run`: polls the results directory while the wrapped command is alive
 * and pushes newly-stable results in batches, so the TMS shows progress while the suite is still running
 * rather than only at the very end.
 *
 * Not `fs.watch` — deliberately. It is unreliable on the overlay/bind-mounted filesystems most CI runners
 * use (Docker, GitLab's own runner, GitHub-hosted overlayfs): events get coalesced or dropped entirely
 * there. A 2-second poll is slower but never lies.
 *
 * A file is "ready" once its `mtime` and `size` are unchanged across two consecutive polls — a reporter
 * writes JSON in one shot but not atomically, so a naive read-on-first-sight risks a truncated file.
 * Containers are deliberately not part of this loop: `attachContainers` matches them against results
 * within a single request, and mid-run a container can still gain children after this pass has already
 * sent its result — that gap is exactly what the final reconciliation pass (see `ingest.ts`) closes.
 *
 * Every tick that finds anything ready gets flushed immediately, capped at `FLUSH_BATCH_SIZE` per request
 * — there used to also be a "wait up to 5s since the last flush" throttle, but the poll cadence itself
 * already bounds this to at most one request per `POLL_INTERVAL_MS` per run, and the ingest route's own
 * rate limit (6000/min per token, `routes/projects.ts`) has room to spare for that. The throttle bought
 * next to nothing and cost up to a full extra window of end-to-end latency, which is what criterion 12
 * actually measures.
 */

import { FileSnapshot, listResultFiles, readJsonFile, snapshot } from './resultsDir.js'

const POLL_INTERVAL_MS = 2_000
const FLUSH_BATCH_SIZE = 100

export interface WatchHandle {
  /** Resolves once the loop has stopped and flushed everything it had confirmed as stable. */
  stop: () => Promise<void>
}

export function startWatching(dir: string, onBatch: (rawResults: unknown[]) => Promise<void>): WatchHandle {
  let stopped = false


  const loop = (async () => {
    const previous = new Map<string, FileSnapshot>()
    const sent = new Set<string>()
    const pending: string[] = []

    const flush = async (files: string[]) => {
      if (!files.length) return
      const raw = (await Promise.all(files.map(readJsonFile))).filter((r): r is unknown => r !== null)
      for (const f of files) sent.add(f)
      if (raw.length) await onBatch(raw)
    }

    while (!stopped) {
      await sleep(POLL_INTERVAL_MS)
      const files = await listResultFiles(dir)
      for (const file of files) {
        if (sent.has(file) || pending.includes(file)) continue
        const snap = await snapshot(file)
        if (!snap) continue
        const last = previous.get(file)
        previous.set(file, snap)
        if (last && last.mtimeMs === snap.mtimeMs && last.size === snap.size) pending.push(file)
      }

      // No time-based throttle: whatever is ready gets sent this tick, just capped per request. Anything
      // beyond the cap waits for the next tick rather than a 5s clock, which is what used to make the
      // first files of a burst wait for a flush window that had nothing to do with when they stabilized.
      if (pending.length > 0) {
        const batch = pending.splice(0, FLUSH_BATCH_SIZE)
        await flush(batch)
      }
    }

    // Drain whatever was confirmed stable but not yet flushed when `stop()` was called — the caller's
    // final reconciliation pass covers everything else regardless (including files still mid-write here).
    while (pending.length) await flush(pending.splice(0, FLUSH_BATCH_SIZE))
  })()

  loop.catch(() => { /* onBatch owns its own error handling; a rejection here would be a bug in this loop itself */ })

  return {
    stop: async () => {
      stopped = true
      await loop
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

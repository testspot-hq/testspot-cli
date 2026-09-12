import { readFile } from 'node:fs/promises'
/**
 * Talks to the CI ingest endpoints on behalf of `index.ts`. Every export here is meant to be called from
 * inside a catch-log-continue wrapper (see `guarded` in `index.ts`) — nothing in this module is allowed to
 * be the reason a CI job fails, per criterion 13.
 */

import { HttpClient } from './httpClient.js'
import { chunk, groupContainersByResultChunk, listContainerFiles, listResultFiles, readEnvironmentProperties } from './resultsDir.js'
import type { CiRunInfo } from './ciEnv.js'

// The server caps `results`/`containers` at 200 entries per `/results` call (`ingestResultsSchema`) —
// batches here stay well under that (100 while streaming, per the plan's own flush size) but the final
// reconciliation pass has to chunk explicitly once a suite has more than 200 results.
const MAX_BATCH = 200

export interface IngestResultsOutcome {
  accepted: number; created: number; updated: number
  total: number; passed: number; failed: number; broken: number; unknown: number; skipped: number
}

export async function ensureLaunch(
  client: HttpClient, project: string, run: CiRunInfo, planId: string | undefined,
): Promise<string> {
  const launch = await client.requestWithRetry<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/launches/ci`, {
    name: run.name,
    planId,
    branch: run.branch,
    sha: run.sha,
    pipelineUrl: run.pipelineUrl,
    externalRunId: run.externalRunId,
  })
  return launch.id
}

function resultsPath(project: string, launchId: string): string {
  return `/api/projects/${encodeURIComponent(project)}/launches/${encodeURIComponent(launchId)}/results`
}

/** One streaming batch — retried on 429/5xx, per the plan's step 4. */
export async function pushBatch(
  client: HttpClient, project: string, launchId: string, results: unknown[],
): Promise<IngestResultsOutcome> {
  return client.requestWithRetry('POST', resultsPath(project, launchId), { results })
}

/**
 * The final sweep once the wrapped command has exited: rereads the *entire* directory, including
 * `-container.json` files the streaming loop never sends, and resends everything. The upsert on
 * `ingestKey` server-side makes this idempotent — results the streaming loop already pushed are simply
 * re-written with the same values (or gain fixtures a late container adds), never duplicated.
 */
export async function reconcile(
  client: HttpClient, project: string, launchId: string, dir: string,
): Promise<IngestResultsOutcome | undefined> {
  const [resultFiles, containerFiles] = await Promise.all([listResultFiles(dir), listContainerFiles(dir)])
  const [results, containers] = await Promise.all([
    Promise.all(resultFiles.map(readCompleteJsonFile)).then(rs => rs.filter((r): r is unknown => r !== null)),
    Promise.all(containerFiles.map(readCompleteJsonFile)).then(cs => cs.filter((c): c is unknown => c !== null)),
  ])
  const envPairs = await readEnvironmentProperties(dir)

  const resultChunks = chunk(results, MAX_BATCH)
  if (!resultChunks.length) {
    // Nothing to reconcile against, but environment.properties may still be worth recording.
    if (!envPairs.length) return undefined
    return client.requestWithRetry(
      'POST', resultsPath(project, launchId), { results: [], containers: [], envPairs },
    )
  }
  const containersByChunk = groupContainersByResultChunk(resultChunks, containers)

  let last: IngestResultsOutcome | undefined
  for (let i = 0; i < resultChunks.length; i++) {
    const containerSubChunks = chunk(containersByChunk[i]!, MAX_BATCH)
    if (!containerSubChunks.length) containerSubChunks.push([])
    for (let j = 0; j < containerSubChunks.length; j++) {
      // The results chunk is resent with every container sub-chunk — redundant when a chunk needs more
      // than one container sub-chunk, but harmless (upsert) and the only way a container lands in the
      // same request as the result it attaches to (see resultsDir.ts's grouping helper doc).
      last = await client.requestWithRetry('POST', resultsPath(project, launchId), {
        results: resultChunks[i],
        containers: containerSubChunks[j],
        envPairs: i === 0 && j === 0 ? envPairs : [],
      })
    }
  }
  return last
}

export async function finishLaunch(client: HttpClient, project: string, launchId: string): Promise<void> {
  await client.request('PATCH', `/api/projects/${encodeURIComponent(project)}/launches/${encodeURIComponent(launchId)}`, { action: 'finish' })
}

export async function readCompleteJsonFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch {
    throw new Error(`Cannot read a complete Allure JSON file: ${file}`)
  }
}
export async function validateResultsDirectory(dir: string): Promise<void> {
  const files = await listResultFiles(dir)
  if (!files.length) throw new Error(`No Allure results in ${dir}`)
  for (const file of [...files, ...await listContainerFiles(dir)]) {
    const value = await readCompleteJsonFile(file)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Allure object: ${file}`)
    if (files.includes(file)) {
      const result = value as { name?: unknown; fullName?: unknown }
      if (typeof result.name !== 'string' || !result.name.trim() || typeof result.fullName !== 'string' || !result.fullName.trim()) {
        throw new Error(`Allure result requires name and fullName: ${file}`)
      }
    }
  }
}

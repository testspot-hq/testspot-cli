/**
 * Derives the one identity a retried CI job needs to resend the same `externalRunId` instead of minting a
 * second launch (see `createCiLaunchSchema` / the unique index on `(projectId, externalRunId)` server-side).
 * GitLab and GitHub are the two providers this stage targets; anything else — a local run, a third
 * provider — falls back to a random id, trading idempotency for "it still works".
 */

import { createHash, randomUUID } from 'node:crypto'

export interface CiRunInfo {
  externalRunId: string
  branch?: string
  sha?: string
  pipelineUrl?: string
  /** A human-readable label for the launch, when the provider exposes one; otherwise the server's own default. */
  name?: string
}

export function detectCiRun(env: Record<string, string | undefined>): CiRunInfo {
  if (env.CI_PROJECT_ID && env.CI_PIPELINE_ID && env.CI_JOB_ID) {
    return {
      externalRunId: `gitlab/${env.CI_PROJECT_ID}/${env.CI_PIPELINE_ID}/${env.CI_JOB_ID}`,
      branch: env.CI_COMMIT_REF_NAME,
      sha: env.CI_COMMIT_SHA,
      pipelineUrl: env.CI_PIPELINE_URL,
      name: env.CI_JOB_NAME,
    }
  }
  // GitHub exposes no matrix-entry id. Without an explicit job key, isolate each CLI invocation.
  if (env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT) {
    return {
      externalRunId: `github/${createHash('sha256').update(JSON.stringify([env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB, env.TESTSPOT_JOB_KEY ?? env.TESTPILOT_JOB_KEY ?? randomUUID()])).digest('hex')}`,
      branch: env.GITHUB_REF_NAME,
      sha: env.GITHUB_SHA,
      pipelineUrl: env.GITHUB_SERVER_URL
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined,
      name: env.GITHUB_WORKFLOW,
    }
  }
  // No recognized CI provider: still usable for a local dry run, just without retry-idempotency — there is
  // no "job" here to retry.
  return { externalRunId: randomUUID() }
}

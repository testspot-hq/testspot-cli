/**
 * Configuration comes from the environment (plus a couple of same-named CLI flags for the two options a
 * CI job commonly overrides per-step: the results directory and strict mode). This mirrors
 * `mcp/src/config.ts` — a misconfigured value should fail with a specific, actionable message rather than
 * a generic one, since the person reading it is staring at a CI log, not a debugger.
 */

import { z } from 'zod'
import { branded } from './brand.js'

/** Marks a token as ours. Mirrors TOKEN_PREFIX in server/src/domain/apiTokens.ts. */
const TOKEN_PREFIX = 'tp_'

export class ConfigError extends Error {
  constructor(message: string) { super(branded(message)) }
}

/** New names take precedence, including an explicitly empty value. Never silently select an old target. */
function withTestSpotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const resolved = { ...env }
  for (const key of ['URL', 'TOKEN', 'PROJECT', 'LAUNCH_ID', 'PLAN_ID', 'RESULTS_DIR']) {
    if (env[`TESTSPOT_${key}`] !== undefined) resolved[`TESTPILOT_${key}`] = env[`TESTSPOT_${key}`]
  }
  return resolved
}

export interface CliOptions {
  results?: string
  strict: boolean
}

const configSchema = z.object({
  baseUrl:    z.string().min(1),
  token:      z.string().startsWith(TOKEN_PREFIX),
  project:    z.string().min(1),
  launchId:   z.string().min(1).optional(),
  planId:     z.string().min(1).optional(),
  resultsDir: z.string().min(1),
  strict:     z.boolean(),
})

export type Config = z.infer<typeof configSchema>

export interface PlanConfig {
  baseUrl: string
  token: string
  project: string
  launchId: string
}

const planConfigSchema = z.object({
  baseUrl:  z.string().min(1),
  token:    z.string().startsWith(TOKEN_PREFIX),
  project:  z.string().min(1),
  launchId: z.string().min(1),
})

/**
 * Reduces the configured value to origin + path, with no trailing slash, so callers can join `/api/...`
 * onto it. Rebuilt from the parsed URL rather than trimmed with a regex — see the identical helper in
 * `mcp/src/config.ts` for why a stray query string or fragment would otherwise fold the whole API path
 * into it.
 */
function normalizeBaseUrl(parsed: URL): string {
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '')
}

/** The bit every subcommand needs — where the server is and who's calling. Split out of `resolveConfig`
 * so `plan` (below) doesn't have to also supply a results directory to get a validated base URL/token. */
function resolveConnection(env: Record<string, string | undefined>): { baseUrl: string; token: string; project: string } {
  const rawUrl = (env.TESTPILOT_URL ?? '').trim()
  const token = (env.TESTPILOT_TOKEN ?? '').trim()
  const project = (env.TESTPILOT_PROJECT ?? '').trim()

  if (!rawUrl) {
    throw new ConfigError('TESTPILOT_URL is not set. Point it at this Testpilot instance, e.g. "https://tms.example.com".')
  }
  if (!token) {
    throw new ConfigError(
      'TESTPILOT_TOKEN is not set. Issue a personal access token on the Tokens page and put it in your CI secrets — ' +
      'see docs/ci-cli.md.',
    )
  }
  if (!project) {
    throw new ConfigError('TESTPILOT_PROJECT is not set. Use the project\'s publicId, shown on its overview page.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new ConfigError(`TESTPILOT_URL is not a valid URL: ${rawUrl}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigError(`TESTPILOT_URL must be http or https, got "${parsedUrl.protocol}" in ${rawUrl}`)
  }
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new ConfigError(`TESTPILOT_TOKEN does not look like a Testpilot token — it should start with "${TOKEN_PREFIX}".`)
  }

  return { baseUrl: normalizeBaseUrl(parsedUrl), token, project }
}

export function resolveConfig(env: Record<string, string | undefined>, options: CliOptions): Config {
  env = withTestSpotEnv(env)
  const connection = resolveConnection(env)
  const launchId = (env.TESTPILOT_LAUNCH_ID ?? '').trim() || undefined
  const planId = (env.TESTPILOT_PLAN_ID ?? '').trim() || undefined
  const resultsDir = (options.results ?? env.TESTPILOT_RESULTS_DIR ?? './allure-results').trim() || './allure-results'

  const parsed = configSchema.safeParse({ ...connection, launchId, planId, resultsDir, strict: options.strict })
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map(i => i.message).join('; '))
  return parsed.data
}

/**
 * `plan` needs one specific already-existing launch to read the case selection off — unlike `run`, it
 * never creates one, so TESTPILOT_LAUNCH_ID is required rather than optional here.
 */
export function resolvePlanConfig(env: Record<string, string | undefined>): PlanConfig {
  env = withTestSpotEnv(env)
  const connection = resolveConnection(env)
  const launchId = (env.TESTPILOT_LAUNCH_ID ?? '').trim()
  if (!launchId) {
    throw new ConfigError(
      '`plan` reads its case selection off one specific launch — set TESTPILOT_LAUNCH_ID to the launch this ' +
      'pipeline step belongs to.',
    )
  }

  const parsed = planConfigSchema.safeParse({ ...connection, launchId })
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map(i => i.message).join('; '))
  return parsed.data
}

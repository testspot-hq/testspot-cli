/**
 * `testpilot plan` — prints the case selection a launch already carries (seeded from a test plan, or from
 * a bulk pick in Test Cases; the server's /selectors endpoint treats both the same way, off the launch),
 * one selector per line, exactly as the reporter recorded it.
 *
 * Deliberately runner-agnostic. The selector is whatever the Allure adapter wrote, and turning it into a
 * particular runner's invocation syntax is the pipeline's job: pytest wants node ids, JUnit takes the
 * `Class#method` shape almost as-is, every runner differs. Translating here would mean one heuristic per
 * adapter-and-runner pair, none of them checkable without that stack's real output — and a wrong guess
 * runs the wrong tests silently, which is worse than making the pipeline spell out its own syntax.
 *
 * Unlike `run`, this command's whole output IS what the caller consumes, so failures are not swallowed
 * the way they are for `run`: silence would mean an empty argument list, not a safe no-op.
 */

import { HttpClient } from './httpClient.js'

export interface LaunchSelectorItem { name: string; selector: string }

export async function fetchLaunchSelectors(client: HttpClient, project: string, launchId: string): Promise<LaunchSelectorItem[]> {
  const res = await client.requestWithRetry<{ items: LaunchSelectorItem[] }>(
    'GET', `/api/projects/${encodeURIComponent(project)}/launches/${encodeURIComponent(launchId)}/selectors`,
  )
  return res.items
}

export interface PlanCommandResult {
  exitCode: number
  stdoutLines: string[]
  stderrLines: string[]
}

export async function runPlanCommand(client: HttpClient, project: string, launchId: string): Promise<PlanCommandResult> {
  const items = await fetchLaunchSelectors(client, project, launchId)
  return { exitCode: 0, stdoutLines: items.map(item => item.selector), stderrLines: [] }
}

export function allureTestPlan(items: LaunchSelectorItem[]): { version: string; tests: Array<{ selector: string }> } {
  if (!items.length) throw new Error('The launch has no selected automated tests; refusing to run the entire suite')
  if (items.some(item => typeof item.selector !== 'string' || !item.selector.trim())) throw new Error('Invalid test selector in the launch')
  return { version: '1.0', tests: [...new Set(items.map(item => item.selector))].map(selector => ({ selector })) }
}

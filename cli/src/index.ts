#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cliName } from './brand.js'
import { parseArgs, CliUsageError, HELP, type ReportArgs } from './args.js'
import { resolveConfig, resolvePlanConfig, type Config } from './config.js'
import { detectCiRun } from './ciEnv.js'
import { HttpClient } from './httpClient.js'
import { ensureLaunch, finishLaunch, pushBatch, reconcile, validateResultsDirectory } from './ingest.js'
import { fetchLaunchSelectors, allureTestPlan } from './plan.js'
import { startWatching } from './watcher.js'
import { uploadAttachmentBatches } from './attachmentBatches.js'
import { VERSION } from './version.js'

const log = (message: string) => process.stderr.write(`${cliName}: ${message}\n`)
const message = (err: unknown) => err instanceof Error ? err.message : String(err)

function runCommand(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), { env, stdio: 'inherit', shell: process.platform === 'win32' && !/\.exe$/i.test(command[0]!) })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    child.on('error', err => { cleanup(); log(`could not start command: ${message(err)}`); resolve(127) })
    child.on('exit', code => { cleanup(); resolve(code ?? 1) })
  })
}

async function report(config: Config, client: HttpClient, launchId: string, args: ReportArgs) {
  await validateResultsDirectory(config.resultsDir)
  const results = await reconcile(client, config.project, launchId, config.resultsDir)
  const attachments = await uploadAttachmentBatches(config.resultsDir, args, async buffer => {
    await client.uploadAttachments(`/api/projects/${encodeURIComponent(config.project)}/launches/${encodeURIComponent(launchId)}/results/attachments/batch`, buffer, 'allure-results.zip')
  }, log)
  return { results, attachments }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.sub === 'help') { process.stdout.write(HELP); return 0 }
  if (args.sub === 'version') { process.stdout.write(`${cliName} ${VERSION}\n`); return 0 }
  if (args.sub === 'plan' || args.sub === 'finish') {
    const config = resolvePlanConfig(process.env)
    const client = new HttpClient(config)
    if (args.sub === 'finish') {
      await finishLaunch(client, config.project, config.launchId)
      log(`finished launch ${config.launchId}`)
      return 0
    }
    const items = await fetchLaunchSelectors(client, config.project, config.launchId)
    const output = args.format === 'allure' ? JSON.stringify(allureTestPlan(items), null, 2) + '\n' : items.map(i => i.selector).join('\n') + (items.length ? '\n' : '')
    if (args.outputFile) await writeFile(args.outputFile, output); else process.stdout.write(output)
    return 0
  }
  if (args.sub === 'doctor') {
    const config = resolveConfig(process.env, { strict: true })
    const project = await new HttpClient(config).requestWithRetry<{ name: string }>('GET', `/api/projects/${encodeURIComponent(config.project)}`)
    log(`connection OK; project ${config.project}: ${project.name}. Read access verified; uploads require write permission.`)
    return 0
  }

  let hadFailure = false
  let config: Config | undefined
  let client: HttpClient | undefined
  let launchId: string | undefined
  let planDir: string | undefined
  let exitCode = 0
  let outcome: Awaited<ReturnType<typeof report>> | undefined
  const childEnv = { ...process.env }
  const guarded = async <T>(description: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn() } catch (err) { hadFailure = true; log(`${description}: ${message(err)}`); return undefined }
  }
  // Selection is execution policy. Fetching it must fail closed, unlike optional result reporting.
  try {
    config = resolveConfig(process.env, { results: args.results, strict: args.sub === 'upload' || args.strict })
    client = new HttpClient(config)
    if (args.sub === 'upload') await validateResultsDirectory(config.resultsDir)
    launchId = config.launchId ?? await ensureLaunch(client, config.project, detectCiRun(process.env), config.planId)
    log(`launch ${launchId}`)
    if (args.sub === 'run' && args.select) {
      const plan = allureTestPlan(await fetchLaunchSelectors(client, config.project, launchId))
      planDir = await mkdtemp(path.join(tmpdir(), 'testspot-plan-'))
      childEnv.ALLURE_TESTPLAN_PATH = path.join(planDir, 'testplan.json')
      await writeFile(childEnv.ALLURE_TESTPLAN_PATH, JSON.stringify(plan))
      log(`selected ${plan.tests.length} tests; the runner's Allure adapter must support test plans`)
    }
  } catch (err) {
    if (planDir) await rm(planDir, { recursive: true, force: true })
    if (args.sub === 'upload' || args.select) throw err
    hadFailure = true; log(`reporting unavailable: ${message(err)}`)
  }

  try {
    const watch = args.sub === 'run' && config && client && launchId
      ? startWatching(config.resultsDir, async raw => { await guarded('pushing results', () => pushBatch(client!, config!.project, launchId!, raw)) })
      : undefined
    try { if (args.sub === 'run') exitCode = await runCommand(args.command, childEnv) }
    finally { if (watch) await guarded('stopping results watcher', () => watch.stop()) }
    if (config && client && launchId) {
      outcome = await guarded('uploading results', () => report(config!, client!, launchId!, args))
      // An incomplete upload must stay recoverable with `upload` using the same launch id.
      if (!args.noFinish && outcome) await guarded('finishing launch', () => finishLaunch(client!, config!.project, launchId!))
      else log(`launch ${launchId} left open; call finish after all uploads succeed`)
      const launchUrl = `${config.baseUrl}/projects/${encodeURIComponent(config.project)}/launches/${encodeURIComponent(launchId)}`
      log(`report: ${launchUrl}`)
      if (outcome) log(`results: ${outcome.results?.total ?? 0} total; attachments: ${outcome.attachments.uploaded} uploaded, ${outcome.attachments.skipped} skipped, ${outcome.attachments.batches} batches`)
      if (args.outputFile) await guarded('writing summary', () => writeFile(args.outputFile!, JSON.stringify({
        launchId, launchUrl, ...outcome, reportingFailed: hadFailure, testExitCode: args.sub === 'run' ? exitCode : null,
      }, null, 2) + '\n'))
    }
  } finally { if (planDir) await rm(planDir, { recursive: true, force: true }) }
  return exitCode !== 0 ? exitCode : hadFailure && (args.sub === 'upload' || args.strict) ? 1 : 0
}

main().then(code => { process.exitCode = code }).catch(err => {
  log(message(err)); process.exitCode = err instanceof CliUsageError ? 2 : 1
})

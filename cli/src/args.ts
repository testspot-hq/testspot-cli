import { cliName } from './brand.js'

export class CliUsageError extends Error {}
export const HELP = `Usage: ${cliName} run [options] -- <command…>
       ${cliName} upload [directory] [options]
       ${cliName} plan [--format selectors|allure] [--output-file path]
       ${cliName} finish
       ${cliName} doctor

run / upload options:
  --results <dir>                  Allure results directory
  --no-finish                      Leave a shared launch open; call finish after all jobs
  --output-file <path>             Write a JSON summary for later CI steps
  --exclude-files <regex>          Exclude attachments by relative path (JavaScript regex)
  --ignore-passed-test-attachments Keep failed-test and fixture attachments
  --max-attachment-size <bytes>    Skip larger files (default 16777216)
  --batch-size <bytes>             Attachment ZIP budget (default 20971520, max 52428800)
run only:
  --strict                        Fail if reporting fails (tests still run)
  --select                        Fetch an Allure test plan before running; fail on empty/error

Connection: TESTSPOT_URL, TESTSPOT_TOKEN, TESTSPOT_PROJECT (TESTPILOT_* also accepted).
Optional: TESTSPOT_LAUNCH_ID, TESTSPOT_PLAN_ID, TESTSPOT_RESULTS_DIR, TESTSPOT_JOB_KEY.
Matrix jobs: use a unique JOB_KEY per matrix entry for a repeatable identity.
--help, --version require no connection. Node 20+ is required.
`

export interface ReportArgs {
  results?: string
  noFinish: boolean
  outputFile?: string
  excludeFiles?: string
  ignorePassedTestAttachments: boolean
  maxAttachmentSize: number
  batchSize: number
}
export type ParsedArgs =
  | ({ sub: 'run'; strict: boolean; select: boolean; command: string[] } & ReportArgs)
  | ({ sub: 'upload' } & ReportArgs)
  | { sub: 'plan'; format: 'selectors' | 'allure'; outputFile?: string }
  | { sub: 'finish' } | { sub: 'doctor' } | { sub: 'help' } | { sub: 'version' }

export function parseArgs(argv: string[]): ParsedArgs {
  const [sub, ...rest] = argv
  if (argv.length === 1 && (sub === '--version' || sub === '-v')) return { sub: 'version' }
  if (!sub || (argv.length === 1 && (sub === '--help' || sub === '-h'))) return { sub: 'help' }
  if (!['run', 'upload', 'plan', 'finish', 'doctor'].includes(sub)) throw new CliUsageError(`Unknown command "${sub}".\n${HELP}`)
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) return { sub: 'help' }
  if (sub === 'finish' || sub === 'doctor') {
    if (rest.length) throw new CliUsageError(`Unexpected option "${rest[0]}"`)
    return { sub }
  }
  let format: 'selectors' | 'allure' = 'selectors'
  let outputFile: string | undefined
  const report: ReportArgs = { noFinish: false, ignorePassedTestAttachments: false, maxAttachmentSize: 16 * 1024 * 1024, batchSize: 20 * 1024 * 1024 }
  let strict = false; let select = false
  const separator = rest.indexOf('--')
  if (sub === 'run' && separator < 0) throw new CliUsageError(`Missing "--" before the wrapped command.\n${HELP}`)
  const flags = sub === 'run' ? rest.slice(0, separator) : rest
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    const value = () => {
      const next = flags[++i]
      if (!next || next.startsWith('--')) throw new CliUsageError(`${flag} requires a value`)
      return next
    }
    if (flag === '--output-file') outputFile = value()
    else if (sub === 'plan' && flag === '--format') {
      const v = value()
      if (v !== 'selectors' && v !== 'allure') throw new CliUsageError('--format must be selectors or allure')
      format = v
    } else if (sub !== 'plan' && flag === '--results') report.results = value()
    else if (sub !== 'plan' && flag === '--no-finish') report.noFinish = true
    else if (sub !== 'plan' && flag === '--ignore-passed-test-attachments') report.ignorePassedTestAttachments = true
    else if (sub !== 'plan' && flag === '--exclude-files') {
      report.excludeFiles = value()
      try { new RegExp(report.excludeFiles) } catch { throw new CliUsageError('Invalid --exclude-files regular expression') }
    } else if (sub !== 'plan' && ['--max-attachment-size', '--batch-size'].includes(flag)) {
      const n = Number(value())
      if (!Number.isSafeInteger(n) || n < 1 || n > 50 * 1024 * 1024) throw new CliUsageError(`${flag} must be 1..52428800 bytes`)
      if (flag === '--batch-size') report.batchSize = n; else report.maxAttachmentSize = n
    } else if (sub === 'run' && flag === '--strict') strict = true
    else if (sub === 'run' && flag === '--select') select = true
    else if (sub === 'upload' && !flag.startsWith('-') && !report.results) report.results = flag
    else throw new CliUsageError(`Unknown option "${flag}".\n${HELP}`)
  }
  if (sub === 'plan') return { sub, format, outputFile }
  if (sub === 'upload') return { sub, ...report, outputFile }
  const command = rest.slice(separator + 1)
  if (!command.length) throw new CliUsageError(`The wrapped command must not be empty.\n${HELP}`)
  return { sub: 'run', ...report, outputFile, strict, select, command }
}

# TestSpot CLI

<p><img src="https://raw.githubusercontent.com/testspot-hq/testspot-cli/main/cli/assets/github-avatar.png" width="80" height="80" alt="TestSpot logo"></p>

Run automated tests and send their Allure results to TestSpot. Download the executable for your operating system from [GitHub Releases](https://github.com/testspot-hq/testspot-cli/releases). No Node.js, Bun or npm installation is needed to use the executable.

| Platform | Release asset |
| --- | --- |
| Linux x64 (glibc) | `testspot_linux_amd64` |
| Linux ARM64 (glibc) | `testspot_linux_arm64` |
| macOS Intel | `testspot_darwin_amd64` |
| macOS Apple Silicon | `testspot_darwin_arm64` |
| Windows x64 | `testspot_windows_amd64.exe` |

Linux builds require glibc; Alpine/musl is not included. macOS and Windows binaries are unsigned. Release assets include `SHA256SUMS` for integrity checking and `THIRD_PARTY_NOTICES.md` for embedded dependencies.

For Linux x64, download the latest executable and make it runnable:

```sh
curl -fL https://github.com/testspot-hq/testspot-cli/releases/latest/download/testspot_linux_amd64 -o testspot
chmod +x testspot
./testspot --help
```

On Windows, run `./testspot_windows_amd64.exe --help` in PowerShell.

Configure an API token with write access to your project using CI secrets or environment variables:

```sh
export TESTSPOT_URL=https://testspot.example.com
export TESTSPOT_TOKEN=tp_your_token
export TESTSPOT_PROJECT=1234
./testspot doctor
./testspot run --results allure-results -- pytest --alluredir=allure-results
```

The runner and its Allure adapter must already be installed. The CLI wraps your command and uploads reports; it does not install test frameworks.

## Commands

- `run -- <command>` streams results during execution, then uploads fixtures and attachments. The exit code follows the test command. `--strict` also fails on reporting errors.
- `upload <directory>` uploads completed results. Reporting errors return exit code 1 and leave the launch open for recovery.
- `plan` prints launch selectors, one per line. `plan --format allure --output-file testplan.json` writes a standard Allure test plan.
- `run --select -- <command>` fetches the selected launch's test plan and sets `ALLURE_TESTPLAN_PATH` for the child. An empty or unavailable selection stops execution. Your Allure adapter must support and apply the plan; the CLI cannot enforce filtering inside the framework.
- `finish` closes the launch specified by `TESTSPOT_LAUNCH_ID`.
- `doctor` verifies connection, token and read access to the project. It does not prove write permission.
- `--help` and `--version` work offline.

`TESTSPOT_LAUNCH_ID` appends to an existing running CI launch. `TESTSPOT_PLAN_ID` associates a newly created launch with a plan; filtering requires `--select`. `TESTSPOT_RESULTS_DIR` defaults to `./allure-results`. Existing `TESTPILOT_*` connection names remain supported; explicit `TESTSPOT_*` values take precedence.

## Parallel jobs and recovery

For several jobs sharing a launch, set the same `TESTSPOT_LAUNCH_ID` in every job and use `--no-finish`. A final dependent job calls `finish` after all uploads have succeeded. Do not close a launch while other jobs are still uploading.

For independently created GitHub launches, each CLI invocation gets a distinct identity by default, including matrix entries. Set `TESTSPOT_JOB_KEY` to a unique stable key per matrix entry if you need repeated invocations within one run attempt to reuse the same launch. A new GitHub run attempt or GitLab job ID creates a new launch. Results can only be appended while the launch is running.

If upload fails, keep the Allure directory as a CI artifact, then retry `upload` with the same launch ID. The CLI prints that ID and a report link. `--output-file summary.json` saves the ID, link, upload statistics and reporting failure status for following CI steps. The link uses `TESTSPOT_URL`; substitute your browser-facing origin if runners use an internal API address.

## Attachments

Requires a TestSpot server with `/results/attachments/batch` support. Older servers reject attachment batches with 404, without silently falling back to non-idempotent uploads.

Attachments are sent in bounded ZIP batches with their matching result/fixture metadata. Temporary network errors, HTTP 429/5xx and partial object-storage failures are retried three times (1, 2 and 4 seconds). Ordinary API calls time out after 30 seconds; attachment requests after 120 seconds.

- `--ignore-passed-test-attachments` omits passed-test attachments; fixture attachments remain.
- `--exclude-files <regex>` excludes attachment source paths using JavaScript regular expressions.
- `--max-attachment-size <bytes>` skips larger files with a warning; default 16 MiB.
- `--batch-size <bytes>` bounds each attachment batch; default 20 MiB, maximum 50 MiB. A single file and its required metadata must fit.

Use a fresh results directory for every run. Missing files and malformed completed JSON are reported as errors. Filters are explicit skips and appear in the summary.

## Build and release

Development requires Node.js 20+ and npm 10. Native packaging additionally requires Bun **1.4.2**, pinned in `release-targets.json` and the GitHub workflow. End users need neither runtime.

```sh
cd cli
npm ci
npm run typecheck
npm run bundle                 # compatible .mjs builds
npm run build:executables       # all five native builds in dist/release
# Or: npm run build:executables -- darwin_arm64
```

`BUN_BINARY` selects the compiler executable. The build disables implicit `.env`/`bunfig.toml` loading so runtime configuration follows the same environment contract as the .mjs CLI.

In the standalone GitHub repository, `.github/workflows/release.yml` builds and tests each executable on its native OS/architecture. Pushing a tag matching `cli/package.json` and `cli/src/version.ts`, e.g. `v0.1.0`, publishes the files and checksums to GitHub Releases only after every platform passes. A manual workflow run builds artifacts without publishing a release.

The TestSpot application repository remains the source of shared CLI development. Export only the CLI into a new directory with `npm --prefix cli run export:github -- /path/to/new-directory`; the allowlist excludes the server, application, credentials and git history. Review that directory before its initial publication. Later updates should be copied from the same source, not independently reimplemented.

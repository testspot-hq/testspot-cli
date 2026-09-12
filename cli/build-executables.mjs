import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(await readFile(path.join(root, 'release-targets.json'), 'utf8'))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const versionSource = await readFile(path.join(root, 'src/version.ts'), 'utf8')
if (!versionSource.includes(`VERSION = '${pkg.version}'`)) throw new Error('package.json and src/version.ts versions differ')
const bun = process.env.BUN_BINARY || 'bun'
const installed = spawnSync(bun, ['--version'], { encoding: 'utf8' })
if (installed.status !== 0 || installed.stdout.trim() !== config.bunVersion) throw new Error(`Build requires Bun ${config.bunVersion}; set BUN_BINARY or install that version`)
const keys = process.argv.slice(2)
const selected = keys.length ? keys : Object.keys(config.targets)
if (selected.some(key => !config.targets[key])) throw new Error(`Unknown target; choose ${Object.keys(config.targets).join(', ')}`)
const out = path.resolve(process.env.CLI_RELEASE_DIR || path.join(root, 'dist/release'))
await mkdir(out, { recursive: true })
const checksums = []
for (const key of selected) {
  const { target, file } = config.targets[key]
  const result = spawnSync(bun, ['build', '--compile', `--target=${target}`, '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--define', 'TESTSPOT_EXECUTABLE=true', 'src/testspot.ts', '--outfile', path.join(out, file)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Build failed for ${key}`)
  checksums.push(`${createHash('sha256').update(await readFile(path.join(out, file))).digest('hex')}  ${file}`)
}
await writeFile(path.join(out, 'THIRD_PARTY_NOTICES.md'), await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md')))
await writeFile(path.join(out, selected.length === Object.keys(config.targets).length ? 'SHA256SUMS' : `SHA256SUMS-${selected.join('-')}`), checksums.join('\n') + '\n')

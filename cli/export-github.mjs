import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(fileURLToPath(import.meta.url))
const destination = process.argv[2]
if (!destination) throw new Error('Usage: npm run export:github -- /path/to/new-directory')
const out = path.resolve(destination)
// Refuse an existing directory: exporting must never overwrite somebody else's repository.
await mkdir(out)
await mkdir(path.join(out, 'cli'))
const allowlist = ['src', 'tests', 'github', 'assets', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'bundle.mjs', 'build-executables.mjs', 'release-targets.json', 'export-github.mjs', 'README.md']
for (const name of allowlist) await cp(path.join(root, name), path.join(out, 'cli', name), { recursive: true })
await cp(path.join(root, 'README.md'), path.join(out, 'README.md'))
await mkdir(path.join(out, '.github/workflows'), { recursive: true })
await cp(path.join(root, 'github/release.yml'), path.join(out, '.github/workflows/release.yml'))
await writeFile(path.join(out, '.gitignore'), '**/node_modules/\n**/dist/\ncli/testspot.mjs\ncli/testpilot.mjs\n.env\n.env.*\n')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
process.stdout.write(`CLI ${pkg.version} exported to ${out}; no application, credentials or git history were copied.\n`)

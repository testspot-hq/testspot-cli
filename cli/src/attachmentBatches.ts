import AdmZip from 'adm-zip'
import { readFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { listContainerFiles, listResultFiles } from './resultsDir.js'
import type { ReportArgs } from './args.js'

export interface AttachmentStats { uploaded: number; skipped: number; batches: number; bytes: number }
type Json = Record<string, unknown>
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function sources(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(sources)
  if (!object(value)) return []
  const own = Array.isArray(value.attachments) ? value.attachments.flatMap(a => object(a) && typeof a.source === 'string' ? [a.source] : []) : []
  return [...own, ...Object.entries(value).filter(([key]) => key !== 'attachments').flatMap(([, v]) => sources(v))]
}
function withoutAttachments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAttachments)
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'attachments').map(([key, v]) => [key, withoutAttachments(v)]))
}

/** Each ZIP carries the result and fixture metadata needed to resolve its binaries on the server. */
export async function uploadAttachmentBatches(
  dir: string, options: Pick<ReportArgs, 'excludeFiles' | 'ignorePassedTestAttachments' | 'maxAttachmentSize' | 'batchSize'>,
  upload: (buffer: Buffer) => Promise<void>, warn: (message: string) => void,
): Promise<AttachmentStats> {
  const stats: AttachmentStats = { uploaded: 0, skipped: 0, batches: 0, bytes: 0 }
  const files = await listResultFiles(dir)
  const metadata = new Map<string, Buffer>()
  const resultsByUuid = new Map<string, string>()
  const owners = new Map<string, Set<string>>()
  const containersByResult = new Map<string, string[]>()
  const addOwner = (source: string, names: string[]) => {
    const set = owners.get(source) ?? new Set<string>(); names.forEach(name => set.add(name)); owners.set(source, set)
  }
  for (const file of files) {
    let value = JSON.parse(await readFile(file, 'utf8')) as Json
    if (options.ignorePassedTestAttachments && value.status === 'passed') value = withoutAttachments(value) as Json
    const name = path.basename(file)
    metadata.set(name, Buffer.from(JSON.stringify(value)))
    if (typeof value.uuid === 'string') resultsByUuid.set(value.uuid, name)
    sources(value).forEach(source => addOwner(source, [name]))
  }
  for (const file of await listContainerFiles(dir)) {
    const value = JSON.parse(await readFile(file, 'utf8')) as Json
    const children = Array.isArray(value.children) ? value.children.flatMap(id => typeof id === 'string' && resultsByUuid.has(id) ? [resultsByUuid.get(id)!] : []) : []
    if (!children.length) continue
    const name = path.basename(file)
    metadata.set(name, Buffer.from(JSON.stringify(value)))
    for (const child of children) containersByResult.set(child, [...containersByResult.get(child) ?? [], name])
    sources(value).forEach(source => addOwner(source, [name, ...children]))
  }
  // Fixture indices depend on all preceding containers, even those with no attachments. Sending
  // only a file's own container would attach a later setup screenshot to the first setup step.
  for (const names of owners.values()) {
    for (const name of [...names]) for (const container of containersByResult.get(name) ?? []) names.add(container)
  }
  const root = await realpath(dir)
  const exclude = options.excludeFiles ? new RegExp(options.excludeFiles) : undefined
  let entries = new Map<string, Buffer>(); let size = 0; let binaries = 0
  const flush = async () => {
    if (!binaries) return
    const zip = new AdmZip()
    for (const [name, data] of entries) zip.addFile(name, data)
    const buffer = zip.toBuffer()
    if (buffer.length > options.batchSize) throw new Error('Attachment ZIP exceeds --batch-size; increase the budget')
    await upload(buffer)
    stats.uploaded += binaries; stats.batches++; stats.bytes += buffer.length
    entries = new Map(); size = 0; binaries = 0
  }
  for (const [source, names] of owners) {
    // Allure source names are archive paths, never filesystem escape hatches or symlink targets.
    if (source.includes('\\') || path.isAbsolute(source) || source.split('/').includes('..')) throw new Error(`Unsafe attachment source: ${source}`)
    if (exclude?.test(source)) { stats.skipped++; warn(`excluded attachment: ${source}`); continue }
    const file = path.join(root, source)
    const info = await lstat(file).catch(() => null)
    if (!info?.isFile()) throw new Error(`Missing or non-regular attachment: ${source}`)
    const resolved = await realpath(file)
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Attachment escapes results directory: ${source}`)
    if (info.size > options.maxAttachmentSize) { stats.skipped++; warn(`attachment exceeds --max-attachment-size: ${source} (${info.size} bytes)`); continue }
    if (metadata.has(source)) throw new Error(`Attachment source collides with result metadata: ${source}`)
    const additions = new Map([...names].map(name => [name, metadata.get(name)!]))
    // Reserve ZIP headers and compression overhead before reading the binary into memory.
    const estimate = [...additions.values()].reduce((n, b) => n + b.length + 1024, info.size + 1024)
    if (estimate > options.batchSize) throw new Error(`Attachment and its metadata exceed --batch-size: ${source}`)
    if (size + estimate > options.batchSize || entries.size + additions.size + 1 > 1000) await flush()
    additions.set(source, await readFile(file))
    for (const [name, data] of additions) if (!entries.has(name)) { entries.set(name, data); size += data.length + 1024 }
    binaries++
  }
  await flush()
  return stats
}

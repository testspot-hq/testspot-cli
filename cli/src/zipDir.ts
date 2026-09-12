/**
 * Packs the whole results directory — results, containers and attachment binaries together — because that
 * is the shape `POST /results/attachments` expects: the same bundle `parseAllureBundle` already unpacks
 * for a manual ZIP import, so the server can recompute each result's `ingestKey` and find the LaunchCase
 * rows `/results` already created. Matching attachments to cases positionally — what the manual ZIP
 * import does — cannot work here: on the ingest path the cases were created earlier, by separate
 * `/results` calls, so by upload time there is no shared ordering left to match against.
 */

import AdmZip from 'adm-zip'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

async function addDirectory(zip: AdmZip, dir: string, zipPrefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await addDirectory(zip, full, `${zipPrefix}${entry.name}/`)
    } else if (entry.isFile()) {
      zip.addLocalFile(full, zipPrefix)
    }
  }
}

export async function zipDirectory(dir: string): Promise<Buffer> {
  const zip = new AdmZip()
  await addDirectory(zip, dir, '')
  return zip.toBuffer()
}

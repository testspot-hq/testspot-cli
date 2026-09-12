/**
 * Thin HTTP client over the CI ingest endpoints — global `fetch`, no HTTP library, per the dependency
 * budget (mirrors the `notificationService.ts` pattern this whole package was modeled on).
 *
 * Two request shapes are exposed on purpose. `request` is a single attempt: used for the calls the plan
 * does not ask to be retried (create launch, attachments upload, finish) — each is already wrapped by the
 * caller in a catch-log-continue so a single failure there degrades the run rather than crashing it.
 * `requestWithRetry` adds the backoff the plan specifically asks for on `POST /results`: a transient blip
 * or an overloaded server is worth another try, a plain 4xx is not.
 */

import type { Config } from './config.js'

const REQUEST_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class HttpClient {
  constructor(private readonly config: Pick<Config, 'baseUrl' | 'token'>) {}

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`
  }

  /** One attempt. Throws `ApiError` with status 0 for a connection failure, the HTTP status otherwise. */
  private async attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (cause) {
      // `fetch` rejects with a bare "fetch failed" for a refused connection, a DNS miss and a timeout alike;
      // naming the base URL (no secret in it) saves the reader from guessing what "unreachable" means here.
      const reason = cause instanceof Error && cause.name === 'TimeoutError'
        ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
        : cause instanceof Error ? cause.message : String(cause)
      throw new ApiError(`could not reach ${this.config.baseUrl} (${reason})`, 0)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(`${method} ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, res.status)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.attempt<T>(method, path, body)
  }

  async requestWithRetry<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await this.attempt<T>(method, path, body)
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0
        const retryable = status === 0 || status === 429 || status >= 500
        if (!retryable || i >= RETRY_DELAYS_MS.length) throw err
        await sleep(RETRY_DELAYS_MS[i]!)
      }
    }
  }

  /**
   * Multipart upload of the whole zipped results directory. Built with the global `FormData`/`Blob` (both
   * available since Node 18, same floor as the rest of this package) rather than a hand-encoded body —
   * `fetch` sets the `multipart/form-data` boundary itself, which is what `@fastify/multipart` on the
   * server expects and is exactly the shape `request.parts()` reads a file part from.
   */
  async uploadAttachments<T>(path: string, buffer: Buffer, fileName: string): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        const result = await this.uploadAttempt<T & { skipped?: boolean }>(path, buffer, fileName)
        if (result?.skipped) throw new ApiError('Object storage could not store all attachments', 503)
        return result
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0
        if (!(status === 0 || status === 429 || status >= 500) || i >= RETRY_DELAYS_MS.length) throw err
        await sleep(RETRY_DELAYS_MS[i]!)
      }
    }
  }

  private async uploadAttempt<T>(path: string, buffer: Buffer, fileName: string): Promise<T> {
    const form = new FormData()
    form.set('file', new Blob([Uint8Array.from(buffer)], { type: 'application/zip' }), fileName)

    let res: Response
    try {
      res = await fetch(this.url(path), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
    } catch (cause) {
      const reason = cause instanceof Error && cause.name === 'TimeoutError'
        ? `no response within 120s`
        : cause instanceof Error ? cause.message : String(cause)
      throw new ApiError(`could not reach ${this.config.baseUrl} (${reason})`, 0)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(`POST ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, res.status)
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}

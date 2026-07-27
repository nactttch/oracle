/**
 * The fetch layer.
 *
 * Stream hosts are hostile to naive clients: they gate on Referer, they set a
 * cookie on the first hit and 403 the second one without it, and they hand out
 * 302 chains that a `redirect: "follow"` fetch would swallow before we could
 * read the intermediate Location headers. So this wraps `fetch` with a cookie
 * jar, manual redirect handling, a request cache, and a concurrency gate.
 *
 * Zero dependencies — `fetch`, `AbortController` and `node:zlib` only.
 */

import { DEFAULT_USER_AGENT } from "./types.js"

export interface FetchResult {
  url: string
  /** After following redirects. */
  finalUrl: string
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
  bytes: number
  contentType: string
  ms: number
  /** Every URL in the redirect chain, excluding the first. */
  redirects: string[]
}

export interface RequestOptions {
  referer?: string
  method?: string
  body?: string
  headers?: Record<string, string>
  timeout?: number
  /** Cap the body we read. Prevents a rogue video URL from eating memory. */
  maxBytes?: number
  /** Skip the cache for this one request. */
  noCache?: boolean
}

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024
const MAX_REDIRECTS = 8

/** Very small cookie jar: host -> name -> value. Ignores paths on purpose. */
class CookieJar {
  private jar = new Map<string, Map<string, string>>()

  store(url: string, setCookieHeaders: string[]) {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return
    }
    const registrable = baseDomain(host)
    for (const raw of setCookieHeaders) {
      const [pair] = raw.split(";")
      if (!pair) continue
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const bucket = this.jar.get(registrable) ?? new Map()
      bucket.set(name, value)
      this.jar.set(registrable, bucket)
    }
  }

  header(url: string): string | undefined {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    const bucket = this.jar.get(baseDomain(host))
    if (!bucket || bucket.size === 0) return undefined
    return [...bucket].map(([k, v]) => `${k}=${v}`).join("; ")
  }
}

/** `a.b.example.co.uk` -> `example.co.uk` (good enough, no PSL dependency). */
function baseDomain(host: string): string {
  const parts = host.split(".")
  if (parts.length <= 2) return host
  const twoLevelTlds = new Set(["co", "com", "net", "org", "gov", "edu", "ac"])
  const secondLast = parts[parts.length - 2]!
  if (twoLevelTlds.has(secondLast) && parts.length >= 3) return parts.slice(-3).join(".")
  return parts.slice(-2).join(".")
}

/** Runs at most `limit` tasks at once; everything else queues. */
export class Gate {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

export class HttpClient {
  private jar = new CookieJar()
  private cache = new Map<string, Promise<FetchResult>>()
  private gate: Gate
  private _requests = 0
  private _bytes = 0

  constructor(
    private opts: {
      userAgent?: string
      timeout?: number
      concurrency?: number
      headers?: Record<string, string>
    } = {},
  ) {
    this.gate = new Gate(opts.concurrency ?? 8)
  }

  get requests() {
    return this._requests
  }
  get bytesRead() {
    return this._bytes
  }

  /** Cached GET. Two callers asking for the same URL share one request. */
  get(url: string, options: RequestOptions = {}): Promise<FetchResult> {
    const key = `${options.method ?? "GET"} ${url} ${options.referer ?? ""}`
    if (!options.noCache) {
      const hit = this.cache.get(key)
      if (hit) return hit
    }
    const pending = this.gate.run(() => this.execute(url, options))
    if (!options.noCache) this.cache.set(key, pending)
    return pending
  }

  private async execute(url: string, options: RequestOptions): Promise<FetchResult> {
    const started = Date.now()
    const redirects: string[] = []
    let current = url
    let response: Response | null = null

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeout ?? this.opts.timeout ?? 15_000)
      try {
        this._requests++
        response = await fetch(current, {
          method: options.method ?? "GET",
          body: options.body,
          redirect: "manual",
          signal: controller.signal,
          headers: this.buildHeaders(current, options),
        })
      } finally {
        clearTimeout(timer)
      }

      const setCookie = readSetCookie(response)
      if (setCookie.length) this.jar.store(current, setCookie)

      const location = response.headers.get("location")
      if (location && response.status >= 300 && response.status < 400) {
        const next = absolutize(location, current)
        if (!next || next === current) break
        // The redirect target inherits the *current* page as its referer.
        options = { ...options, referer: current }
        redirects.push(next)
        current = next
        continue
      }
      break
    }

    if (!response) throw new Error("no response")

    const body = await readCapped(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this._bytes += body.length

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })

    return {
      url,
      finalUrl: current,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      headers,
      body,
      bytes: body.length,
      contentType: (headers["content-type"] ?? "").toLowerCase(),
      ms: Date.now() - started,
      redirects,
    }
  }

  private buildHeaders(url: string, options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent ?? DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,ar;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site",
      "upgrade-insecure-requests": "1",
      ...this.opts.headers,
      ...options.headers,
    }
    if (options.referer) {
      headers.referer = options.referer
      // Players commonly check Origin too, and derive it from the referer.
      try {
        headers.origin = new URL(options.referer).origin
      } catch {
        /* referer wasn't absolute — skip Origin rather than send a broken one */
      }
    }
    const cookie = this.jar.header(url)
    if (cookie) headers.cookie = cookie
    return headers
  }
}

/** `getSetCookie` is newer than the runtimes we support; fall back gracefully. */
function readSetCookie(response: Response): string[] {
  const anyHeaders = response.headers as unknown as { getSetCookie?: () => string[] }
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie()
  const single = response.headers.get("set-cookie")
  return single ? [single] : []
}

/** Reads a response body but stops at `maxBytes` instead of buffering forever. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return await response.text().catch(() => "")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    /* a truncated body is still worth scanning */
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged)
}

/** Resolve a possibly-relative URL against a base. Returns null if hopeless. */
export function absolutize(href: string, base: string): string | null {
  const trimmed = href.trim().replace(/^['"]|['"]$/g, "")
  if (!trimmed || trimmed.startsWith("#")) return null
  if (/^(javascript|data|about|blob|mailto|tel):/i.test(trimmed)) return null
  try {
    return new URL(trimmed, base).toString()
  } catch {
    return null
  }
}

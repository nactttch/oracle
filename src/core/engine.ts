/**
 * The dig orchestrator.
 *
 * Breadth-first over a graph of documents: the page, the iframes it embeds, the
 * scripts those load, the XHR endpoints those scripts call, and the sibling
 * servers the whole thing is mirrored across. Every document goes through the
 * same pipeline — read it raw, statically deobfuscate it, run it in the
 * honeypot, and harvest everything all three produce.
 *
 * BFS (rather than depth-first) matters: the real stream is almost always one
 * or two hops in, so a level-by-level sweep surfaces it early even when a page
 * also links to something twelve hops deep.
 */

import { HttpClient } from "./http.js"
import { deobfuscate, needsExecution } from "./deobfuscate.js"
import {
  cleanUrl,
  classify,
  findEmbeddedDocuments,
  findScripts,
  harvestConfigUrls,
  harvestUrls,
  isJunk,
  isMediaUrl,
  isStreamBearingPath,
} from "./extract.js"
import { isDashManifest, isPlaylist } from "./hls.js"
import { createHoneypot, type HoneypotSession } from "./sandbox.js"
import { looksLikeApiResponse, rankApiBases, synthesizeEndpoints } from "./api.js"
import { findTokenEndpoints } from "./token.js"
import { initialConfidence, probeCandidate } from "./probe.js"
import { discoverServers } from "./servers.js"
import { detectPlatform, type PlatformEmbed } from "./platforms.js"
import { absolutize } from "./http.js"
import type { Candidate, DigOptions, Reporter, ServerVariant, Technique } from "./types.js"
import { DEFAULT_OPTIONS } from "./types.js"

export interface DigResult {
  input: string
  candidates: Candidate[]
  servers: ServerVariant[]
  /** Third-party embeds found instead of a manifest (YouTube, Dailymotion...). */
  platforms: PlatformEmbed[]
  stats: {
    documents: number
    scripts: number
    requests: number
    bytes: number
    ms: number
  }
}

type TaskKind = "document" | "script" | "api"

interface FetchedDocument {
  url: string
  body: string
  kind: TaskKind
}

interface Task {
  url: string
  kind: TaskKind
  depth: number
  referer?: string
  /** Server variant label this branch belongs to. */
  server?: string
  /** Techniques already applied upstream, inherited by anything found here. */
  via: Technique[]
}

export class Oracle {
  private http: HttpClient
  private options: DigOptions
  private report: Reporter
  private visited = new Set<string>()
  private candidates = new Map<string, Candidate>()
  private servers: ServerVariant[] = []
  private platforms = new Map<string, PlatformEmbed>()
  private tokenEndpoints = new Set<string>()
  private documents = 0
  private scripts = 0
  private aborted = false

  constructor(options: Partial<DigOptions> = {}, report: Reporter = () => {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.report = report
    this.http = new HttpClient({
      userAgent: this.options.userAgent,
      timeout: this.options.timeout,
      concurrency: this.options.concurrency,
      headers: this.options.headers,
    })
  }

  /** Stops the dig at the next checkpoint. Safe to call from a key handler. */
  abort() {
    this.aborted = true
  }

  async dig(rawInput: string): Promise<DigResult> {
    const started = Date.now()
    const input = normalizeInput(rawInput)

    this.report({ type: "phase", phase: "crawl", detail: hostOf(input) })
    const rootTask: Task = {
      url: input,
      kind: "document",
      depth: 0,
      referer: this.options.referer ?? originOf(input),
      via: [],
    }
    const visitedDocuments = await this.crawl([rootTask])

    if (this.options.digServers && !this.aborted) {
      await this.digServers(input, visitedDocuments)
    }

    if (this.options.probe && !this.aborted) {
      await this.probeAll()
    }

    const candidates = this.rank()
    this.report({ type: "done", candidates, servers: this.servers })

    return {
      input,
      candidates,
      servers: this.servers,
      platforms: [...this.platforms.values()],
      stats: {
        documents: this.documents,
        scripts: this.scripts,
        requests: this.http.requests,
        bytes: this.http.bytesRead,
        ms: Date.now() - started,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Crawl
  // -------------------------------------------------------------------------

  /** Level-by-level sweep. Returns the documents actually fetched. */
  private async crawl(roots: Task[]): Promise<FetchedDocument[]> {
    const fetched: FetchedDocument[] = []
    let frontier = roots

    for (let depth = 0; depth <= this.options.maxDepth && frontier.length; depth++) {
      if (this.aborted || this.documents >= this.options.maxDocuments) break
      const next: Task[] = []

      await mapLimit(frontier, this.options.concurrency, async (task) => {
        const outcome = await this.processDocument(task)
        if (outcome.body !== undefined) fetched.push({ url: task.url, body: outcome.body, kind: task.kind })
        next.push(...outcome.children)
      })

      frontier = dedupeTasks(next).filter((task) => !this.visited.has(key(task.url)))
    }

    return fetched
  }

  private async processDocument(task: Task): Promise<{ children: Task[]; body?: string }> {
    const children: Task[] = []
    const identity = key(task.url)
    if (this.visited.has(identity)) return { children }
    this.visited.add(identity)
    if (this.aborted || this.documents >= this.options.maxDocuments) return { children }
    if (this.enoughFound()) return { children }

    this.documents++
    if (task.kind === "script") this.scripts++
    this.report({ type: "fetch", url: task.url, depth: task.depth })

    let body: string
    let finalUrl: string
    let contentType: string
    try {
      const response = await this.http.get(task.url, { referer: task.referer, timeout: this.options.timeout })
      body = response.body
      finalUrl = response.finalUrl
      contentType = response.contentType
      this.report({
        type: "fetched",
        url: task.url,
        status: response.status,
        bytes: response.bytes,
        ms: response.ms,
      })
      if (response.redirects.length) {
        this.report({ type: "layer", url: task.url, technique: "redirect", detail: `${response.redirects.length} hop(s)` })
      }
      if (!response.ok) return { children }
    } catch (error) {
      this.report({
        type: "fetch-failed",
        url: task.url,
        error: error instanceof Error ? error.message : String(error),
      })
      return { children }
    }

    // A manifest is not a document to crawl — it *is* the answer.
    if (isPlaylist(body) || isDashManifest(body)) {
      this.addCandidate(finalUrl, {
        origin: task.referer ?? task.url,
        via: [...task.via, "plain-text"],
        depth: task.depth,
        server: task.server,
        referer: task.referer,
      })
      return { children, body }
    }

    // --- layer 1: what is sitting in plain sight ---------------------------
    this.harvest(body, finalUrl, task, [])

    // --- layer 2: static deobfuscation -------------------------------------
    const deobfuscated = deobfuscate(body)
    if (deobfuscated.techniques.length) {
      for (const technique of deobfuscated.techniques) {
        this.report({ type: "layer", url: finalUrl, technique })
      }
      this.harvest(deobfuscated.text, finalUrl, task, deobfuscated.techniques)
    }

    const isHtml = /<\s*(?:html|head|body|div|script|iframe)\b/i.test(body.slice(0, 4000))

    // A JSON body is an API response: follow the URLs inside it, because the
    // manifest is regularly one more hop behind a config endpoint.
    if (!isHtml && looksLikeApiResponse(body, contentType)) {
      children.push(...this.followApiResponse(body, finalUrl, task))
    }

    // --- layer 3: the honeypot ---------------------------------------------
    if (!isHtml) {
      if (this.options.sandbox && body.trim().length > 24) {
        children.push(...this.runScripts([{ code: body, name: finalUrl }], finalUrl, task))
      }
      return { children, body }
    }

    // One session for the whole page: inline scripts and external ones run in
    // document order in a single global, which is the only way a bundled app
    // (webpack, Nuxt, Vite) ever gets far enough to ask for its stream.
    if (this.options.sandbox) {
      const before = this.mediaCandidateCount()
      const sources = await this.collectPageScripts(body, finalUrl)
      if (sources.length) children.push(...this.runScripts(sources, finalUrl, task))

      // Synthesis is a last resort, not a routine step: it costs a burst of
      // requests, so it only fires for a page that gave up nothing playable —
      // which is exactly the single-page-app case it exists for.
      if (sources.length && this.mediaCandidateCount() === before) {
        const bundleText = sources.map((source) => source.code).join("\n")
        children.push(...this.synthesizeApiCalls(bundleText, body, finalUrl, task))
      }
    }

    // --- layer 4: follow the document graph --------------------------------
    for (const embedded of findEmbeddedDocuments(body, finalUrl)) {
      // A platform embed is a terminal answer, not another hop: there is no
      // manifest behind it, and crawling a video SPA burns the budget.
      const platform = detectPlatform(embedded.url)
      if (platform) {
        if (!this.platforms.has(platform.url)) {
          this.platforms.set(platform.url, platform)
          this.report({ type: "warn", message: `${platform.platform} embed — no raw manifest here` })
        }
        continue
      }
      children.push({
        url: embedded.url,
        kind: "document",
        depth: task.depth + 1,
        // Players check Referer; the embedding page is what a browser sends.
        referer: finalUrl,
        server: task.server,
        via: task.via,
      })
    }

    return { children, body }
  }

  /**
   * Every script belonging to a page, inline and external, in document order.
   *
   * External bodies are fetched here rather than queued as separate documents
   * so they can be replayed into one shared context below. Order is preserved
   * because a bundler's runtime chunk has to run before the chunks that
   * register into it.
   */
  private async collectPageScripts(html: string, baseUrl: string): Promise<Array<{ code: string; name: string }>> {
    const refs = findScripts(html, baseUrl)
    const sources: Array<{ code: string; name: string }> = new Array(refs.length)

    await mapLimit(
      refs.map((ref, index) => ({ ref, index })),
      this.options.concurrency,
      async ({ ref, index }) => {
        if (ref.code !== undefined) {
          sources[index] = { code: ref.code, name: `${baseUrl}#inline${index}` }
          return
        }
        if (!ref.url) return
        const identity = key(ref.url)
        if (this.visited.has(identity)) return
        this.visited.add(identity)
        try {
          this.scripts++
          const response = await this.http.get(ref.url, { referer: baseUrl, timeout: this.options.timeout })
          if (response.ok && response.body) {
            sources[index] = { code: response.body, name: ref.url }
            // Bundles hide URLs in plain text too, not only at runtime.
            this.harvestText(response.body, ref.url, baseUrl)
          }
        } catch {
          /* a missing chunk is survivable; the rest still runs */
        }
      },
    )

    return sources.filter(Boolean)
  }

  /** Replays a page's scripts into one honeypot and reaps what falls out. */
  private runScripts(
    sources: Array<{ code: string; name: string }>,
    documentUrl: string,
    task: Task,
  ): Task[] {
    const session = createHoneypot({
      pageUrl: documentUrl,
      timeout: Math.min(this.options.timeout, 6000),
    })

    for (const source of sources) {
      if (this.aborted) break
      session.run(source.code, source.name)
    }
    session.drain()

    return this.reapSession(session, documentUrl, task)
  }

  /** Runs code in the honeypot and turns its hits into candidates and tasks. */
  private reapSession(result: HoneypotSession, documentUrl: string, task: Task): Task[] {
    const children: Task[] = []

    if (result.hits.length) {
      this.report({
        type: "layer",
        url: documentUrl,
        technique: "sandbox",
        detail: `${result.hits.length} value${result.hits.length === 1 ? "" : "s"} observed`,
      })
    }

    for (const hit of result.hits) {
      const cleaned = cleanUrl(hit.value)
      if (!cleaned) continue
      const resolved = absolutize(cleaned, documentUrl)
      if (!resolved || isJunk(resolved)) continue

      const looksLikeStream = isMediaUrl(resolved) || isStreamBearingPath(hit.path)
      if (looksLikeStream) {
        this.addCandidate(resolved, {
          origin: documentUrl,
          via: [...task.via, "sandbox"],
          depth: task.depth,
          server: task.server,
          referer: documentUrl,
        })
        continue
      }

      // Not a stream, but the script asked the network for it — that endpoint
      // very often returns the manifest as JSON.
      if (hit.network && this.candidates.size < 400) {
        children.push({
          url: resolved,
          kind: hit.network === "script" ? "script" : hit.network === "navigate" ? "document" : "api",
          depth: task.depth + 1,
          referer: documentUrl,
          server: task.server,
          via: [...task.via, "api"],
        })
      }
    }

    // Code handed to eval()/Function() is the next layer down.
    for (const source of result.evaluated) {
      const inner = deobfuscate(source)
      this.harvest(inner.text, documentUrl, task, ["sandbox", ...inner.techniques])
    }

    // document.write() output is markup — it can carry the real iframe.
    for (const markup of result.written) {
      this.harvest(markup, documentUrl, task, ["sandbox"])
      for (const embedded of findEmbeddedDocuments(markup, documentUrl)) {
        children.push({
          url: embedded.url,
          kind: "document",
          depth: task.depth + 1,
          referer: documentUrl,
          server: task.server,
          via: [...task.via, "sandbox"],
        })
      }
    }

    return children
  }

  /**
   * Reconstructs the request the page's own app would have made.
   *
   * When a bundled player never boots far enough to call its backend, the
   * backend can still be deduced: the bundle names its API origin, and the page
   * URL carries the id. Combining the two is what a human does after one glance
   * at the Network tab, and it reaches manifests that no amount of static
   * reading ever will.
   */
  private synthesizeApiCalls(bundleText: string, html: string, documentUrl: string, task: Task): Task[] {
    if (task.depth >= this.options.maxDepth) return []

    // Origins mentioned anywhere in the page or its bundle.
    const mentioned = [
      ...harvestUrls(bundleText, { base: documentUrl, includeAll: true }),
      ...harvestUrls(html, { base: documentUrl, includeAll: true }),
    ]
    const bases = rankApiBases(mentioned, documentUrl)
    const endpoints = synthesizeEndpoints({ pageUrl: documentUrl, bases })
    if (!endpoints.length) return []

    this.report({
      type: "layer",
      url: documentUrl,
      technique: "api",
      detail: `${endpoints.length} endpoint guess${endpoints.length === 1 ? "" : "es"}`,
    })

    return endpoints.map((url) => ({
      url,
      kind: "api" as const,
      depth: task.depth + 1,
      referer: documentUrl,
      server: task.server,
      via: [...task.via, "api" as const],
    }))
  }

  /**
   * Walks a JSON response for more to chase.
   *
   * Config endpoints chain: `/api/events/{id}` hands back a stream URL, but it
   * just as often hands back another endpoint. Media URLs become candidates;
   * same-domain non-media URLs become one more hop.
   */
  private followApiResponse(body: string, documentUrl: string, task: Task): Task[] {
    const children: Task[] = []
    if (task.depth >= this.options.maxDepth) return children

    for (const url of harvestUrls(body, { base: documentUrl, includeAll: true })) {
      if (isMediaUrl(url)) continue // already harvested as a candidate
      if (detectPlatform(url)) continue
      if (!sameSite(url, documentUrl) && !sameSite(url, task.referer ?? documentUrl)) continue
      children.push({
        url,
        kind: "api",
        depth: task.depth + 1,
        referer: documentUrl,
        server: task.server,
        via: [...task.via, "api"],
      })
      if (children.length >= 8) break
    }
    return children
  }

  /** Harvests a fetched script body without treating it as its own document. */
  private harvestText(text: string, scriptUrl: string, pageUrl: string) {
    const pseudoTask: Task = { url: scriptUrl, kind: "script", depth: 1, referer: pageUrl, via: [] }
    this.harvest(text, scriptUrl, pseudoTask, [])
    const deobfuscated = deobfuscate(text)
    if (deobfuscated.techniques.length) {
      this.harvest(deobfuscated.text, scriptUrl, pseudoTask, deobfuscated.techniques)
    }
  }

  /** Records any signing service mentioned, for use when a manifest 403s. */
  private noteTokenEndpoints(text: string, base: string) {
    if (this.tokenEndpoints.size >= 8) return
    const urls = harvestUrls(text, { base, includeAll: true })
    for (const endpoint of findTokenEndpoints(urls, text)) {
      if (this.tokenEndpoints.size >= 8) break
      if (!this.tokenEndpoints.has(endpoint)) {
        this.tokenEndpoints.add(endpoint)
        this.report({ type: "layer", url: base, technique: "token-signed", detail: hostOf(endpoint) })
      }
    }
  }

  /** Pulls candidates out of a blob of text. */
  private harvest(text: string, base: string, task: Task, extra: Technique[]) {
    this.noteTokenEndpoints(text, base)
    for (const url of harvestUrls(text, { base })) {
      this.addCandidate(url, {
        origin: base,
        via: [...task.via, ...extra, "plain-text"],
        depth: task.depth,
        server: task.server,
        referer: base,
      })
    }
    for (const url of harvestConfigUrls(text, base)) {
      this.addCandidate(url, {
        origin: base,
        via: [...task.via, ...extra, "json"],
        depth: task.depth,
        server: task.server,
        referer: base,
      })
    }
  }

  private addCandidate(
    url: string,
    meta: { origin: string; via: Technique[]; depth: number; server?: string; referer?: string },
  ) {
    if (isJunk(url) || !isPlausibleStream(url)) return
    const identity = key(url)
    const existing = this.candidates.get(identity)
    if (existing) {
      // Found twice by different routes: keep the richer provenance.
      const merged = new Set([...existing.via, ...meta.via])
      existing.via = [...merged]
      if (!existing.server && meta.server) existing.server = meta.server
      return
    }
    if (this.candidates.size >= 600) return

    const via = dedupeTechniques(meta.via)
    const candidate: Candidate = {
      url,
      kind: classify(url),
      origin: meta.origin,
      via,
      depth: meta.depth,
      confidence: initialConfidence({ url, kind: classify(url), via }),
      headers: meta.referer ? { referer: meta.referer } : {},
      server: meta.server,
    }
    this.candidates.set(identity, candidate)
    this.report({ type: "candidate", candidate })
    this.report({
      type: "stat",
      docs: this.documents,
      scripts: this.scripts,
      bytes: this.http.bytesRead,
      candidates: this.candidates.size,
    })
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  private async digServers(input: string, visited: FetchedDocument[]) {
    const player = this.pickPlayerDocument(input, visited)
    if (!player) return

    this.report({ type: "phase", phase: "servers", detail: hostOf(player.url) })

    const context = visited.filter((doc) => doc.url !== player.url).slice(0, 4)
    const found = await discoverServers(
      this.http,
      { playerUrl: player.url, playerBody: player.body, context },
      {
        depth: this.options.serverDepth,
        maxProbes: Math.max(12, this.options.serverDepth * 6),
        timeout: this.options.timeout,
        referer: this.options.referer ?? originOf(player.url),
      },
      (variant) => {
        this.servers.push(variant)
        this.report({ type: "server", variant })
      },
    )

    if (!found.length || this.aborted) return

    this.report({ type: "phase", phase: "crawl-servers", detail: `${found.length} server(s)` })
    const tasks: Task[] = found.map((variant) => ({
      url: variant.url,
      kind: "document" as const,
      depth: 1,
      referer: player.url,
      server: variant.label,
      via: [],
    }))
    await this.crawl(tasks)
  }

  /**
   * The document sibling servers hang off is the *player* — the thing an
   * iframe points at — not the article page around it and not the JSON an XHR
   * returned. Scoring rather than "first match" because an API response often
   * mentions `.m3u8` while being the worst possible base for `?serv=2`.
   */
  private pickPlayerDocument(input: string, visited: FetchedDocument[]): FetchedDocument | undefined {
    const pages = visited.filter((doc) => doc.kind === "document")
    if (!pages.length) return undefined

    const scored = pages.map((doc) => {
      let score = 0
      if (doc.url !== input) score += 3 // an embed we followed into
      if (/<iframe|jwplayer|clappr|videojs|hls\.js|playerjs|<video/i.test(doc.body)) score += 3
      if (/\.m3u8|\.mpd/i.test(doc.body)) score += 2
      // Player pages are small and script-heavy; article pages are not.
      if (doc.body.length < 40_000) score += 1
      if (/\bserv(?:er)?\s*=|سيرفر|server\s*\d/i.test(doc.body)) score += 2
      return { doc, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored[0]!.doc
  }

  // -------------------------------------------------------------------------
  // Probing and ranking
  // -------------------------------------------------------------------------

  private async probeAll() {
    this.report({ type: "phase", phase: "verify" })
    // Probe the plausible ones first so an early stop keeps the best results.
    const queue = [...this.candidates.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 120)
    const pending: Candidate[] = []

    await mapLimit(queue, Math.max(2, Math.floor(this.options.concurrency / 2)), async (candidate) => {
      if (this.aborted || this.enoughFound()) return
      this.report({ type: "probe", url: candidate.url })
      const outcome = await probeCandidate(this.http, candidate, {
        timeout: this.options.timeout,
        expandVariants: this.options.expandVariants,
        tokenEndpoints: [...this.tokenEndpoints],
      })
      this.candidates.set(key(candidate.url), outcome.candidate)
      this.report({ type: "probed", candidate: outcome.candidate })

      for (const extra of outcome.discovered) {
        const identity = key(extra.url)
        if (this.candidates.has(identity)) continue
        this.candidates.set(identity, extra)
        this.report({ type: "candidate", candidate: extra })
        pending.push(extra)
      }
    })

    // Second pass over the renditions a master playlist revealed.
    //
    // These used to inherit the master's "verified" without ever being
    // requested — which is exactly how Oracle came to hand out a URL that a
    // player could not open. A rendition behind a signing CDN needs its own
    // proof, so it gets its own request.
    if (!pending.length || this.aborted) return
    this.report({ type: "phase", phase: "verify-renditions", detail: `${pending.length}` })

    await mapLimit(pending.slice(0, 40), Math.max(2, Math.floor(this.options.concurrency / 2)), async (candidate) => {
      if (this.aborted) return
      const target = candidate.signedUrl ?? candidate.url
      this.report({ type: "probe", url: target })
      const outcome = await probeCandidate(
        this.http,
        { ...candidate, url: target },
        {
          timeout: this.options.timeout,
          // Renditions are leaves; expanding again would loop.
          expandVariants: false,
          tokenEndpoints: [...this.tokenEndpoints],
        },
      )
      const settled: Candidate = {
        ...outcome.candidate,
        url: candidate.url,
        // A media playlist names no resolution — only the master that pointed
        // here did. Keep it, or every rendition renders as an identical row.
        resolution: outcome.candidate.resolution ?? candidate.resolution,
        note: outcome.candidate.note ?? candidate.note,
        signedUrl: outcome.candidate.signedUrl ?? (candidate.signedUrl && outcome.candidate.verified ? candidate.signedUrl : undefined),
      }
      this.candidates.set(key(candidate.url), settled)
      this.report({ type: "probed", candidate: settled })
    })
  }

  /**
   * Candidates you could actually hand to a player.
   *
   * `unknown` is a guess, and a `websocket` is usually a control channel — this
   * player's `wss://manager…` is a peer-coordination socket, not the video. If
   * either counted as success, the synthesis gate below would consider the page
   * solved and never look for the manifest that is genuinely still missing.
   */
  private mediaCandidateCount(): number {
    let total = 0
    for (const candidate of this.candidates.values()) {
      if (candidate.kind !== "unknown" && candidate.kind !== "websocket") total++
    }
    return total
  }

  private enoughFound(): boolean {
    if (this.options.stopAfter <= 0) return false
    let verified = 0
    for (const candidate of this.candidates.values()) if (candidate.verified) verified++
    return verified >= this.options.stopAfter
  }

  /**
   * Everything is returned, verified or not.
   *
   * A failed probe is not proof a URL is wrong — geo-blocked streams answer
   * 403 to a server in the wrong country while being exactly the URL the user
   * wants. Dropping those would hide the right answer, so they are ranked last
   * instead and the caller decides how loudly to show them.
   */
  private rank(): Candidate[] {
    return this.dropShadows([...this.candidates.values()])
      .map(demoteUnplayableMaster)
      .sort((a, b) => {
        // Verified beats unverified, then confidence, then shallower depth.
        const verifiedDelta = Number(b.verified ?? false) - Number(a.verified ?? false)
        if (verifiedDelta) return verifiedDelta
        if (b.confidence !== a.confidence) return b.confidence - a.confidence
        return a.depth - b.depth
      })
  }

  /**
   * Removes candidates that are the same stream path resolved against the
   * wrong base.
   *
   * A script that builds its URL as `atob(host) + atob(path)` leaks the path
   * fragment on its own, and resolving that fragment against the player's
   * directory produces a plausible-looking URL on the *player's* host that
   * 404s. If a candidate failed and another candidate ends with the same
   * path+query, the failed one is that artefact, not a stream.
   */
  private dropShadows(candidates: Candidate[]): Candidate[] {
    const suffixes = new Map<string, Candidate>()
    for (const candidate of candidates) {
      if (candidate.status === 404 || candidate.status === 410) continue
      const suffix = pathSuffix(candidate.url)
      if (suffix) suffixes.set(suffix, candidate)
    }
    return candidates.filter((candidate) => {
      if (candidate.status !== 404 && candidate.status !== 410) return true
      const suffix = pathSuffix(candidate.url)
      if (!suffix) return true
      const other = suffixes.get(suffix)
      return !other || other.url === candidate.url
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit)
  let cursor = 0
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index]!).catch(() => {})
    }
  })
  await Promise.all(runners)
}

/** Accepts `example.com/x`, `//example.com/x` and full URLs alike. */
export function normalizeInput(input: string): string {
  const trimmed = input.trim().replace(/^['"<]|['">]$/g, "")
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith("//")) return "https:" + trimmed
  return "https://" + trimmed.replace(/^\/+/, "")
}

function collectInlineScripts(html: string): string {
  const parts: string[] = []
  for (const script of findScripts(html, "https://localhost/")) {
    if (script.code) parts.push(script.code)
  }
  // Semicolons between blocks: a truncated expression must not swallow the
  // next script's first statement.
  return parts.join("\n;\n")
}

/**
 * Pushes a signed master playlist below its own renditions.
 *
 * HLS resolves the URIs inside a playlist against the path, discarding the
 * query — so a signed master hands a player rendition URLs with no signature,
 * and every one of them 403s. The master is still worth reporting (it names the
 * renditions), but it must not be the first URL a pipeline picks up, because it
 * is the one thing here that cannot be played.
 */
function demoteUnplayableMaster(candidate: Candidate): Candidate {
  if (!candidate.signedUrl || !candidate.variants?.length) return candidate
  return {
    ...candidate,
    confidence: Math.max(0, candidate.confidence - 8),
    note: candidate.note
      ? `${candidate.note} · renditions need the token too`
      : "renditions need the token too",
  }
}

/** Same registrable domain — keeps API chasing from wandering off-site. */
function sameSite(a: string, b: string): boolean {
  const domain = (url: string) => {
    try {
      const parts = new URL(url).hostname.split(".")
      return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".")
    } catch {
      return ""
    }
  }
  const left = domain(a)
  return Boolean(left) && left === domain(b)
}

function containsPlayerHints(code: string): boolean {
  return /jwplayer|clappr|videojs|hls\.js|new Hls|dashjs|flvjs|playerjs|\.m3u8|setup\s*\(|sources?\s*[:=]/i.test(code)
}

function dedupeTechniques(techniques: Technique[]): Technique[] {
  return [...new Set(techniques)]
}

function dedupeTasks(tasks: Task[]): Task[] {
  const seen = new Set<string>()
  const out: Task[] = []
  for (const task of tasks) {
    const identity = `${task.kind}:${key(task.url)}`
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(task)
  }
  return out
}

/** Identity used for de-duplication: host + path + sorted query. */
function key(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    parsed.searchParams.sort()
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`
  } catch {
    return url
  }
}

/**
 * Filters things that can be crawled but can never *be* the stream.
 *
 * Config-key harvesting pulls `src=` off `<script>` tags, so a player's own
 * bundle looks like a candidate. Those still need crawling — they're where the
 * manifest is hiding — but listing `albaplayer.js` as a result is noise. Same
 * for a platform embed URL: it's reported separately, not as a stream.
 */
function isPlausibleStream(url: string): boolean {
  if (detectPlatform(url)) return false
  const path = url.split(/[?#]/)[0] ?? ""
  return !/\.(?:js|mjs|cjs|css|html?|xml|txt|map)$/i.test(path)
}

/** Last two path segments plus the query — enough to spot the same manifest. */
function pathSuffix(url: string): string | null {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments.length < 2) return null
    return segments.slice(-2).join("/") + parsed.search
  } catch {
    return null
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin + "/"
  } catch {
    return undefined
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

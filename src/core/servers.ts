/**
 * Sibling-server discovery.
 *
 * One embed URL is rarely one stream. The same player usually answers on
 * `?serv=2`, `?server=3`, `?id=b`, `/embed-2/`, and a dozen other shapes that
 * differ per site. Hardcoding `?serv=` would fit exactly one site, so instead
 * this does three things in order:
 *
 *   1. Mine the documents we already have for URLs that are siblings of the
 *      player — that finds the real parameter name for free, whatever it is.
 *   2. Infer parameter names from the player URL itself and a curated list.
 *   3. Prove each guess by *novelty*, not by status code.
 *
 * Step 3 is the part that makes this reliable. Most sites return 200 for
 * `?madeUpParam=7` and serve the default stream, so a status check finds
 * hundreds of phantom servers. Oracle first asks for a deliberately nonsense
 * parameter to learn what "you gave me something I ignore" looks like, then
 * only accepts a variant whose body diverges from *both* the baseline and that
 * ignored response. A variant that resolves to different stream URLs is
 * accepted outright.
 */

import type { HttpClient } from "./http.js"
import { absolutize } from "./http.js"
import { attrs, cleanUrl, isMediaUrl, stripTags } from "./extract.js"
import type { ServerVariant } from "./types.js"

/** Query parameters that commonly select a server, most likely first. */
const CANDIDATE_PARAMS = [
  "serv", "server", "s", "sv", "srv", "ser", "id", "stream", "ch", "channel",
  "p", "player", "q", "src", "source", "link", "e", "n", "no", "num", "nb",
  "v", "mirror", "host", "cdn", "embed",
]

/** Values worth trying for a numeric-looking parameter. */
const NUMERIC_VALUES = ["2", "3", "4", "5", "6", "7", "8", "9", "10"]
const ALPHA_VALUES = ["b", "c", "d"]

export interface ServerDigOptions {
  /** How many values to try per parameter. */
  depth: number
  /** Hard ceiling on probe requests, so a wide list can't stall the dig. */
  maxProbes: number
  timeout: number
  referer?: string
}

export interface ServerDigInput {
  /** The player/iframe URL we are finding siblings of. */
  playerUrl: string
  /** Body of that player URL, already fetched. */
  playerBody: string
  /** Other documents worth mining, e.g. the page that embedded the player. */
  context?: Array<{ url: string; body: string }>
}

export async function discoverServers(
  http: HttpClient,
  input: ServerDigInput,
  options: ServerDigOptions,
  onFound?: (variant: ServerVariant) => void,
): Promise<ServerVariant[]> {
  const base = safeUrl(input.playerUrl)
  if (!base) return []

  const accepted: ServerVariant[] = []
  const seen = new Set<string>([normalize(input.playerUrl)])
  const emit = (variant: ServerVariant) => {
    accepted.push(variant)
    onFound?.(variant)
  }

  // --- 1. Mined siblings. Highest confidence: the site linked to these. ---
  const mined = mineSiblings(input, base)
  for (const variant of mined) {
    if (seen.has(normalize(variant.url))) continue
    seen.add(normalize(variant.url))
    emit(variant)
  }

  // --- 2. Learn what "ignored parameter" looks like on this host. ---
  const baseline = fingerprint(input.playerBody)
  const nonsenseUrl = withParam(base, "orcl" + Math.random().toString(36).slice(2, 7), "7").toString()
  let ignored = baseline
  try {
    const response = await http.get(nonsenseUrl, { referer: options.referer, timeout: options.timeout })
    if (response.ok && response.body.length > 0) ignored = fingerprint(response.body)
  } catch {
    /* no control response — fall back to comparing against the baseline alone */
  }

  const isNovel = (body: string): number => {
    if (body.trim().length < 64) return 0
    const candidate = fingerprint(body)
    const vsBase = similarity(candidate, baseline)
    const vsIgnored = similarity(candidate, ignored)
    // Different stream URLs is decisive on its own — some players differ by a
    // single token, which token-set similarity would round away.
    if (!sameStreams(candidate, baseline)) return Math.max(0.5, 1 - vsBase)
    const novelty = 1 - Math.max(vsBase, vsIgnored)
    return novelty > 0.02 ? novelty : 0
  }

  // --- 3. Parameter names worth trying, most promising first. ---
  const params = rankParams(base, mined)
  let probes = 0

  for (const param of params) {
    if (probes >= options.maxProbes) break
    const values = valuesFor(param, base, options.depth)
    let paramProductive = false

    for (let index = 0; index < values.length; index++) {
      if (probes >= options.maxProbes) break
      const value = values[index]!
      const url = withParam(base, param, value).toString()
      if (seen.has(normalize(url))) continue
      seen.add(normalize(url))

      probes++
      let novelty = 0
      let body = ""
      try {
        const response = await http.get(url, { referer: options.referer, timeout: options.timeout })
        if (response.ok) {
          body = response.body
          novelty = isNovel(body)
        }
      } catch {
        continue
      }

      if (novelty > 0) {
        paramProductive = true
        emit({ url, label: `${param}=${value}`, how: "param-probe", novelty })
      } else if (!paramProductive && index >= 1) {
        // Two duds in a row and nothing to show: this parameter is inert on
        // this host. Move on rather than burning the budget on values 4..10.
        break
      }
    }
  }

  // --- 4. Path-shaped variants: /embed/5 -> /embed/5-2, /embed/5/2 ---
  for (const url of pathVariants(base)) {
    if (probes >= options.maxProbes) break
    if (seen.has(normalize(url))) continue
    seen.add(normalize(url))
    probes++
    try {
      const response = await http.get(url, { referer: options.referer, timeout: options.timeout })
      if (!response.ok || response.status >= 400) continue
      const novelty = isNovel(response.body)
      if (novelty > 0) emit({ url, label: shortLabel(url, base), how: "path-probe", novelty })
    } catch {
      /* a 404 here is the expected case */
    }
  }

  return accepted
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/** Anchor/button/JS references that look like the same player, different server. */
function mineSiblings(input: ServerDigInput, base: URL): ServerVariant[] {
  const documents = [{ url: input.playerUrl, body: input.playerBody }, ...(input.context ?? [])]
  const found = new Map<string, ServerVariant>()

  for (const doc of documents) {
    // Anchors carry a human label, which beats "serv=2" in the UI.
    for (const match of doc.body.matchAll(/<a\b([^>]*)>([\s\S]{0,120}?)<\/a\s*>/gi)) {
      const href = attrs(match[1] ?? "").href
      if (!href) continue
      const resolved = resolveSibling(href, doc.url, base)
      if (!resolved) continue
      const label = stripTags(match[2] ?? "").trim().slice(0, 32)
      found.set(normalize(resolved), {
        url: resolved,
        label: label || shortLabel(resolved, base),
        how: "page-link",
      })
    }

    // Server switchers are often buttons with the URL in a data-* attribute or
    // an onclick, not an href.
    for (const match of doc.body.matchAll(
      /(?:data-(?:src|url|link|server|serv|href)|onclick)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
    )) {
      const raw = match[1] ?? match[2] ?? ""
      for (const piece of raw.matchAll(/['"]?((?:https?:)?\/\/[^'"\s)]+|\/[^'"\s)]+|\?[^'"\s)]+)['"]?/g)) {
        const resolved = resolveSibling(piece[1]!, doc.url, base)
        if (resolved && !found.has(normalize(resolved))) {
          found.set(normalize(resolved), { url: resolved, label: shortLabel(resolved, base), how: "page-attribute" })
        }
      }
    }

    // Bare URL literals in scripts, e.g. servers: ["/p/max-5/?serv=2", ...]
    for (const match of doc.body.matchAll(/["'`]([^"'`\s]*\?[\w%+.-]+=[^"'`\s]*)["'`]/g)) {
      const resolved = resolveSibling(match[1]!, doc.url, base)
      if (resolved && !found.has(normalize(resolved))) {
        found.set(normalize(resolved), { url: resolved, label: shortLabel(resolved, base), how: "script-literal" })
      }
    }
  }

  return [...found.values()].slice(0, 40)
}

/**
 * Accepts `href` only if it points at what is plausibly the same player: same
 * host, and a path that either matches exactly or is one small mutation away.
 */
function resolveSibling(href: string, docUrl: string, base: URL): string | null {
  const cleaned = cleanUrl(href)
  if (!cleaned) return null
  const resolved = absolutize(cleaned, docUrl)
  if (!resolved) return null
  if (isMediaUrl(resolved)) return null

  const candidate = safeUrl(resolved)
  if (!candidate) return null
  if (candidate.hostname !== base.hostname) return null
  if (normalize(resolved) === normalize(base.toString())) return null

  const basePath = trimSlashes(base.pathname)
  const candidatePath = trimSlashes(candidate.pathname)

  // Same path, different query — the classic ?serv=2.
  if (candidatePath === basePath) return candidate.search ? resolved : null

  // One segment appended or the last segment lightly mutated.
  const baseSegments = basePath.split("/")
  const candidateSegments = candidatePath.split("/")
  if (Math.abs(baseSegments.length - candidateSegments.length) > 1) return null
  const shared = baseSegments.slice(0, -1).join("/")
  if (!candidatePath.startsWith(shared)) return null
  const tail = candidateSegments[candidateSegments.length - 1] ?? ""
  const baseTail = baseSegments[baseSegments.length - 1] ?? ""
  if (tail.startsWith(baseTail) || baseTail.startsWith(tail) || /^\d{1,2}$/.test(tail)) return resolved
  return null
}

// ---------------------------------------------------------------------------
// Parameter and path guessing
// ---------------------------------------------------------------------------

/** Parameters already in play beat mined ones, which beat the curated list. */
function rankParams(base: URL, mined: ServerVariant[]): string[] {
  const ranked: string[] = []
  const push = (name: string) => {
    if (name && !ranked.includes(name) && name.length <= 12) ranked.push(name)
  }

  // The URL the user handed us already names the parameter, most of the time.
  for (const [name] of base.searchParams) push(name)
  // Anything a mined sibling used.
  for (const variant of mined) {
    const url = safeUrl(variant.url)
    if (!url) continue
    for (const [name] of url.searchParams) push(name)
  }
  for (const name of CANDIDATE_PARAMS) push(name)
  return ranked
}

function valuesFor(param: string, base: URL, depth: number): string[] {
  const current = base.searchParams.get(param)
  const values = NUMERIC_VALUES.slice(0, Math.max(1, depth))
  // If the URL is already on server 2, "2" is the page we started from.
  const filtered = current ? values.filter((value) => value !== current) : values
  const withOne = current && current !== "1" ? ["1", ...filtered] : filtered
  return [...withOne, ...ALPHA_VALUES].slice(0, Math.max(2, depth))
}

function withParam(base: URL, param: string, value: string): URL {
  const url = new URL(base.toString())
  url.searchParams.set(param, value)
  return url
}

/**
 * Path mutations that add a server marker.
 *
 * Deliberately never increments a number already in the last segment:
 * `/albaplayer/max-5/` -> `/albaplayer/max-6/` is a *different channel*, not a
 * different server for the same one, and returning someone else's match is
 * worse than returning nothing.
 */
function pathVariants(base: URL): string[] {
  const path = trimSlashes(base.pathname)
  if (!path) return []
  const segments = path.split("/")
  const tail = segments[segments.length - 1]!
  const prefix = segments.slice(0, -1).join("/")
  const trailingSlash = base.pathname.endsWith("/") ? "/" : ""
  const out: string[] = []

  for (const marker of ["2", "3"]) {
    const shapes = [
      `${prefix ? "/" + prefix : ""}/${tail}-${marker}${trailingSlash}`,
      `${prefix ? "/" + prefix : ""}/${tail}/${marker}${trailingSlash}`,
      `${prefix ? "/" + prefix : ""}/${tail}/serv${marker}${trailingSlash}`,
    ]
    for (const shape of shapes) {
      const url = new URL(base.toString())
      url.pathname = shape
      out.push(url.toString())
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

interface Fingerprint {
  tokens: Set<string>
  streams: Set<string>
}

/**
 * A body reduced to the tokens that would actually differ between servers:
 * long-ish identifiers plus any media URL. Short words and markup are dropped
 * because every page on a site shares them.
 */
export function fingerprint(body: string): Fingerprint {
  const tokens = new Set<string>()
  const streams = new Set<string>()

  for (const match of body.matchAll(/[A-Za-z0-9_-]{5,}/g)) {
    tokens.add(match[0]!)
    if (tokens.size >= 4000) break
  }
  for (const match of body.matchAll(/(?:https?:)?\/\/[^\s"'`<>\\]{6,}/g)) {
    const url = match[0]!
    if (isMediaUrl(url)) streams.add(url.replace(/^https?:/, ""))
    if (streams.size >= 200) break
  }
  return { tokens, streams }
}

/** Jaccard index over the token sets: 1.0 means indistinguishable. */
export function similarity(a: Fingerprint, b: Fingerprint): number {
  if (a.tokens.size === 0 && b.tokens.size === 0) return 1
  let intersection = 0
  const [small, large] = a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens]
  for (const token of small) if (large.has(token)) intersection++
  const union = a.tokens.size + b.tokens.size - intersection
  return union === 0 ? 1 : intersection / union
}

function sameStreams(a: Fingerprint, b: Fingerprint): boolean {
  if (a.streams.size === 0 && b.streams.size === 0) return true
  if (a.streams.size !== b.streams.size) return false
  for (const stream of a.streams) if (!b.streams.has(stream)) return false
  return true
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "")
}

/** Ignores ordering and trailing-slash noise when de-duplicating. */
function normalize(input: string): string {
  const url = safeUrl(input)
  if (!url) return input
  url.hash = ""
  url.searchParams.sort()
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.host}${path}${url.search}`
}

/** A compact human label: the bit that differs from the base URL. */
function shortLabel(url: string, base: URL): string {
  const parsed = safeUrl(url)
  if (!parsed) return url
  const query = parsed.search.replace(/^\?/, "")
  if (query && parsed.pathname === base.pathname) return query.slice(0, 24)
  const tail = trimSlashes(parsed.pathname).split("/").pop() ?? ""
  return (query ? `${tail}?${query}` : tail).slice(0, 24) || parsed.host
}

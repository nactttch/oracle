/**
 * API endpoint synthesis — the "open the Network tab" move.
 *
 * Modern players are single-page apps. The page ships no stream URL at all; the
 * bundle boots, reads an id out of its own route, calls its backend, and the
 * manifest arrives in a JSON response. Static analysis finds nothing there
 * because there is nothing to find, and even executing the bundle often fails
 * because the app wants a router, a real DOM and a mounted component tree.
 *
 * A human debugging this doesn't do any of that. They open DevTools, watch one
 * XHR go past, and read the manifest out of the response. This module does the
 * same thing deductively: take the API origins the bundle mentions, take the
 * identifiers out of the page's own URL, and reconstruct the request the app
 * would have made.
 *
 * The winning shape is usually the dullest one — an SPA route of `/events/{id}`
 * is served by `/api/events/{id}` on the API host — because the same team wrote
 * both and mirrored the paths.
 */

import { isJunk } from "./extract.js"
import { detectPlatform } from "./platforms.js"

export interface SynthesisInput {
  /** The document whose route holds the identifiers. */
  pageUrl: string
  /** Origins (or base URLs) the bundle referenced. */
  bases: string[]
  /** Extra identifiers seen elsewhere, e.g. in a config object. */
  extraIds?: string[]
}

/** Words that are route structure, never the identifier itself. */
const STRUCTURAL = new Set([
  "api", "v1", "v2", "v3", "www", "embed", "embeds", "player", "players", "watch",
  "live", "stream", "streams", "video", "videos", "event", "events", "channel",
  "channels", "match", "matches", "play", "index", "home", "page", "view", "en",
  "ar", "fr", "es", "de", "it", "pt", "ru", "tr", "id", "web", "app", "public",
])

/** Collection segments worth pairing an id with, in template form. */
const COLLECTION_FALLBACKS = ["events", "event", "channels", "streams", "videos", "matches", "live"]

/**
 * Identifiers in a URL: the segments that name a *thing* rather than a place.
 * `/events/73_arryadia_k2tgcj0` yields id `73_arryadia_k2tgcj0`, collection
 * `events`.
 */
export function extractIdentifiers(pageUrl: string): { ids: string[]; collections: string[]; pathname: string } {
  const ids: string[] = []
  const collections: string[] = []
  let pathname = "/"

  try {
    const parsed = new URL(pageUrl)
    pathname = parsed.pathname
    const segments = parsed.pathname.split("/").filter(Boolean)

    segments.forEach((segment, index) => {
      const decoded = safeDecode(segment)
      if (!isIdentifier(decoded)) return
      ids.push(decoded)
      const previous = segments[index - 1]
      if (previous && STRUCTURAL.has(previous.toLowerCase())) collections.push(previous.toLowerCase())
    })

    // Query values are identifiers too: `?id=abc123`, `?v=xyz`.
    for (const [key, value] of parsed.searchParams) {
      if (/^(?:id|v|vid|video|event|channel|stream|slug|key|ref)$/i.test(key) && isIdentifier(value)) {
        ids.push(value)
      }
    }
  } catch {
    /* not a URL — nothing to take from it */
  }

  return { ids: unique(ids), collections: unique(collections), pathname }
}

/**
 * A segment is an identifier if it is long enough to be unique and looks
 * machine-generated: a digit, an underscore, a hyphen, or a long opaque token.
 * `events` fails all of those; `73_arryadia_k2tgcj0` passes the first.
 */
function isIdentifier(segment: string): boolean {
  if (segment.length < 4 || segment.length > 128) return false
  if (STRUCTURAL.has(segment.toLowerCase())) return false
  if (/\.(?:html?|php|aspx?|jsp|js|css)$/i.test(segment)) return false
  if (/\d/.test(segment)) return true
  if (/[_-]/.test(segment) && segment.length >= 6) return true
  return segment.length >= 12 && /^[a-z0-9]+$/i.test(segment)
}

/**
 * Every request the app plausibly makes, most likely first.
 *
 * Ordering is the whole game: the budget is small, so the shapes that pay off
 * on real players come first — the page's own path re-hosted on the API origin,
 * with and without an `/api` prefix.
 */
export function synthesizeEndpoints(input: SynthesisInput, limit = 28): string[] {
  const { ids, collections, pathname } = extractIdentifiers(input.pageUrl)
  const allIds = unique([...ids, ...(input.extraIds ?? [])])
  if (!allIds.length) return []

  const origins = unique(input.bases.map(toOrigin).filter((value): value is string => Boolean(value)))
  if (!origins.length) return []

  const paths: string[] = []
  const addPath = (path: string) => {
    const normalized = path.replace(/\/{2,}/g, "/")
    if (normalized.length > 1 && !paths.includes(normalized)) paths.push(normalized)
  }

  // 1. The SPA route mirrored onto the API host. This is the common case.
  const cleanPath = pathname.replace(/\/+$/, "")
  if (cleanPath) {
    addPath(`/api${cleanPath}`)
    addPath(cleanPath)
    addPath(`/api/v1${cleanPath}`)
  }

  // 2. Explicit collection/id pairs seen in the route.
  for (const id of allIds) {
    for (const collection of [...collections, ...COLLECTION_FALLBACKS]) {
      addPath(`/api/${collection}/${id}`)
      addPath(`/${collection}/${id}`)
    }
    addPath(`/api/${id}`)
  }

  // 3. Config-shaped suffixes on the best guesses.
  for (const id of allIds.slice(0, 2)) {
    for (const collection of [...collections, ...COLLECTION_FALLBACKS].slice(0, 2)) {
      addPath(`/api/${collection}/${id}/config`)
      addPath(`/api/${collection}/${id}/stream`)
    }
  }

  const endpoints: string[] = []
  for (const path of paths) {
    for (const origin of origins) {
      const url = origin + path
      if (!isJunk(url) && !endpoints.includes(url)) endpoints.push(url)
      if (endpoints.length >= limit) return endpoints
    }
  }
  return endpoints
}

/**
 * API origins worth trying, ranked.
 *
 * A bundle references dozens of hosts; only a few are its backend. Hosts whose
 * name says `api` win, then anything sharing the page's registrable domain,
 * then the page's own origin.
 */
export function rankApiBases(urls: string[], pageUrl: string, limit = 5): string[] {
  const pageOrigin = toOrigin(pageUrl)
  const pageDomain = registrableDomain(pageUrl)
  const scores = new Map<string, number>()

  for (const url of urls) {
    const origin = toOrigin(url)
    if (!origin || isJunk(origin)) continue
    // A page that embeds YouTube mentions youtube.com constantly. Synthesising
    // `/api/events/{id}` against it produces nothing but consent redirects, and
    // burns the crawl budget doing it.
    if (detectPlatform(origin)) continue
    let score = scores.get(origin) ?? 0
    if (score === 0) {
      const host = hostOf(origin)
      if (/(?:^|\.)api[.-]|[.-]api(?:$|\.)|\/api/.test(host)) score += 10
      if (registrableDomain(origin) === pageDomain) score += 4
      if (origin === pageOrigin) score += 2
      if (/cdn|static|assets|fonts|analytics|ads?/.test(host)) score -= 6
    }
    // Repeated mentions are weak evidence of importance.
    scores.set(origin, score + 1)
  }

  if (pageOrigin && !scores.has(pageOrigin)) scores.set(pageOrigin, 3)

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([origin]) => origin)
}

/** True when a body is worth harvesting as a structured API response. */
export function looksLikeApiResponse(body: string, contentType: string): boolean {
  if (/json|javascript|text\/plain/i.test(contentType)) return true
  const head = body.trimStart()[0]
  return head === "{" || head === "["
}

// ---------------------------------------------------------------------------

function toOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

function registrableDomain(url: string): string {
  const host = hostOf(url)
  const parts = host.split(".")
  return parts.length <= 2 ? host : parts.slice(-2).join(".")
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

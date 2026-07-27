/**
 * Turning arbitrary text into stream URLs.
 *
 * Two jobs live here: classifying a URL by what it points at, and raking every
 * URL-shaped thing out of a blob of HTML/JS — including the ones that are only
 * a path fragment sitting in a JS object literal, which is how most players
 * actually store their manifest.
 */

import { absolutize } from "./http.js"
import type { StreamKind } from "./types.js"

/** Extensions we treat as playable media, longest first so `.m3u8` beats `.m3`. */
const KIND_BY_EXTENSION: Array<[RegExp, StreamKind]> = [
  [/\.m3u8(\?|#|$)/i, "hls"],
  [/\.m3u(\?|#|$)/i, "hls"],
  [/\.mpd(\?|#|$)/i, "dash"],
  [/\.mp4(\?|#|$)/i, "mp4"],
  [/\.webm(\?|#|$)/i, "webm"],
  [/\.flv(\?|#|$)/i, "flv"],
  [/\.ts(\?|#|$)/i, "ts"],
]

export function classify(url: string): StreamKind {
  if (/^rtmps?:/i.test(url)) return "rtmp"
  if (/^wss?:/i.test(url)) return "webrtc"
  const withoutHash = url.split("#")[0]!
  for (const [pattern, kind] of KIND_BY_EXTENSION) {
    if (pattern.test(withoutHash)) return kind
  }
  // Manifests hidden behind a query string or a path segment.
  if (/[?&](?:type|format|ext)=m3u8/i.test(url) || /\/(?:master|index|playlist|chunks|live)\.m3u8/i.test(url)) return "hls"
  if (/\/manifest(\.mpd)?(\?|$)/i.test(url)) return "dash"
  if (/\/hls\//i.test(url) || /playlist\.m3u8/i.test(url)) return "hls"
  return "unknown"
}

export function isMediaUrl(url: string): boolean {
  return classify(url) !== "unknown"
}

/** Static assets that are never the stream. Cheap way to keep the queue small. */
const JUNK = new RegExp(
  [
    "\\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)(?:\\?|#|$)",
    "\\.(?:css|scss|woff2?|ttf|eot|otf)(?:\\?|#|$)",
    "\\.(?:zip|rar|7z|exe|dmg|apk|pdf)(?:\\?|#|$)",
    "google-?analytics|googletagmanager|doubleclick|adservice|adsystem|adnxs",
    "facebook\\.(?:com|net)/|connect\\.facebook|twitter\\.com/|/gtag/",
    "gravatar\\.com|w3\\.org/|schema\\.org|fonts\\.(?:googleapis|gstatic)",
    "cloudflareinsights|hotjar|sentry\\.io|/favicon",
    // Source-comment URLs from bundled libraries, never a stream.
    "github\\.com/|stackoverflow\\.com|npmjs\\.(?:com|org)|w3schools",
  ].join("|"),
  "i",
)

export function isJunk(url: string): boolean {
  return JUNK.test(url)
}

// ---------------------------------------------------------------------------
// Raw harvesting
// ---------------------------------------------------------------------------

/** Absolute or protocol-relative URLs. Stops at quotes, whitespace, and `\`. */
const ABSOLUTE_URL = /(?:https?:\/\/|\/\/)[^\s"'`<>\\)\]}]{4,}/gi
const RTMP_URL = /rtmps?:\/\/[^\s"'`<>\\)\]}]{4,}/gi

/**
 * Media paths that never appear as a full URL: `file: "/live/ch1/index.m3u8"`
 * or `source:'hls/stream.m3u8'`. Resolved against the document later.
 */
const RELATIVE_MEDIA = /["'`]((?:\.{0,2}\/)?[\w\-./~%]+\.(?:m3u8|mpd|mp4|webm|flv)(?:\?[^"'`\s]*)?)["'`]/gi

/**
 * Player config keys. Catches values that carry no extension at all, which is
 * common for token-signed manifests behind a rewriting CDN.
 */
const CONFIG_VALUE =
  /\b(?:file|src|source|sources|url|link|stream|streamUrl|hls|hlsUrl|m3u8|manifest|playlist|videoUrl|mediaUrl|play_url|playUrl|content_url)\b\s*[:=]\s*["'`]([^"'`\s]{6,})["'`]/gi

/** `<iframe src>`, `<source src>`, `data-src`, and friends. */
const ATTRIBUTE_URL =
  /\b(?:src|href|data-src|data-url|data-file|data-link|data-stream|data-hls|data-lazy-src|data-litespeed-src|content)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi

export interface HarvestOptions {
  /** Document URL used to resolve relative references. */
  base: string
  /** Keep non-media URLs too (used when crawling for more documents). */
  includeAll?: boolean
}

/**
 * Every distinct absolute URL in `text`, resolved against `base`.
 * Insertion-ordered, so earlier (usually more relevant) finds stay first.
 */
export function harvestUrls(text: string, options: HarvestOptions): string[] {
  const found = new Set<string>()

  const push = (raw: string | undefined) => {
    if (!raw) return
    const cleaned = cleanUrl(raw)
    if (!cleaned) return
    const resolved = absolutize(cleaned, options.base)
    if (!resolved) return
    if (!options.includeAll && !isMediaUrl(resolved)) return
    if (isJunk(resolved)) return
    found.add(resolved)
  }

  for (const match of text.matchAll(ABSOLUTE_URL)) push(match[0])
  for (const match of text.matchAll(RTMP_URL)) found.add(cleanUrl(match[0]) ?? match[0])
  for (const match of text.matchAll(RELATIVE_MEDIA)) push(match[1])
  for (const match of text.matchAll(CONFIG_VALUE)) push(match[1])
  for (const match of text.matchAll(ATTRIBUTE_URL)) push(match[1] ?? match[2] ?? match[3])

  return [...found]
}

/** Media URLs only — the fast path when we just want candidates. */
export function harvestMediaUrls(text: string, base: string): string[] {
  return harvestUrls(text, { base }).filter(isMediaUrl)
}

/**
 * URLs sitting in a player config key (`file:`, `source:`, `hls:` ...),
 * *whatever* they end in.
 *
 * Signed manifests routinely carry no extension at all — `file: "/v/8f21a?t=..."`
 * is a perfectly ordinary HLS URL behind a rewriting CDN. Extension matching
 * would throw those away, so they come back here and the prober decides: fetch
 * it, and if `#EXTM3U` comes back, it was a stream after all.
 */
export function harvestConfigUrls(text: string, base: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(CONFIG_VALUE)) {
    const raw = match[1]
    if (!raw) continue
    const cleaned = cleanUrl(raw)
    if (!cleaned) continue
    // Skip bare words: `type: "hls"` matches the pattern but is not a URL.
    if (!/[/.]/.test(cleaned)) continue
    const resolved = absolutize(cleaned, base)
    if (!resolved || isJunk(resolved)) continue
    found.add(resolved)
  }
  return [...found]
}

/** Player config keys, for deciding whether a sandbox hit is a stream URL. */
export const CONFIG_KEYS = new Set([
  "file", "src", "source", "sources", "url", "link", "stream", "streamurl",
  "hls", "hlsurl", "m3u8", "manifest", "playlist", "videourl", "mediaurl",
  "play_url", "playurl", "content_url", "href",
])

/** True when a honeypot path like `jwplayer().setup()[0].file` names a stream. */
export function isStreamBearingPath(path: string): boolean {
  const leaf = path.split(/[.[\]()]/).filter(Boolean).pop()
  return leaf ? CONFIG_KEYS.has(leaf.toLowerCase()) : false
}

/**
 * Trims the junk that regex boundaries leave behind: escaped slashes from JSON,
 * HTML entities, and trailing punctuation that belonged to the surrounding code.
 */
export function cleanUrl(raw: string): string | null {
  let url = raw.trim()
  if (!url) return null

  url = url.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/").replace(/\\&/g, "&")
  url = url
    .replace(/&amp;/gi, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&#x2[fF];/g, "/")
    .replace(/&quot;/gi, "")

  // Balance-aware trim: a `)` only gets dropped if it has no partner.
  for (;;) {
    const last = url[url.length - 1]
    if (!last) return null
    if (/[.,;:!?'"`]/.test(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ")" && count(url, "(") < count(url, ")")) {
      url = url.slice(0, -1)
      continue
    }
    if ((last === "]" && !url.includes("[")) || (last === "}" && !url.includes("{"))) {
      url = url.slice(0, -1)
      continue
    }
    break
  }

  if (url.startsWith("//")) url = "https:" + url
  // Length floors are per-shape: `https://a` is too short to be real, but
  // `/hop/` is a perfectly good relative target and must survive.
  if (url.includes("://")) {
    if (url.length < 12) return null
  } else if (url.length < 2) {
    return null
  }
  // Reject the mangled leftovers of a minified expression. The operator
  // patterns matter as much as the illegal characters: `!`, `&` and `(` are all
  // legal in a URL, so `/_nuxt/!==r.protocol&&!p(I)?(o=I` passes a character
  // check while being obvious JavaScript.
  if (/[<>{}|^\s"'`\\]/.test(url)) return null
  if (/!==|===|&&|\|\||=>|\?\(|\)\s*[;,{]|\+\+|--\s/.test(url)) return null
  return url
}

function count(text: string, char: string): number {
  let total = 0
  for (const c of text) if (c === char) total++
  return total
}

// ---------------------------------------------------------------------------
// Document-level extraction
// ---------------------------------------------------------------------------

export interface EmbeddedDocument {
  url: string
  /** Why we think this is worth following. */
  reason: "iframe" | "embed" | "source" | "meta" | "script" | "redirect" | "link"
}

const IFRAME_TAG = /<iframe\b[^>]*>/gi
const EMBED_TAG = /<(?:embed|object)\b[^>]*>/gi
const SOURCE_TAG = /<(?:source|video|audio)\b[^>]*>/gi
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const META_REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi
const OG_VIDEO = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:video(?::url|:secure_url)?|twitter:player)["'][^>]*>/gi

/** iframes, embeds, `<source>`s, meta-refresh hops and og:video targets. */
export function findEmbeddedDocuments(html: string, base: string): EmbeddedDocument[] {
  const results: EmbeddedDocument[] = []
  const seen = new Set<string>()

  const add = (raw: string | undefined | null, reason: EmbeddedDocument["reason"]) => {
    if (!raw) return
    const cleaned = cleanUrl(raw)
    if (!cleaned) return
    const url = absolutize(cleaned, base)
    if (!url || seen.has(url) || isJunk(url)) return
    seen.add(url)
    results.push({ url, reason })
  }

  for (const tag of html.matchAll(IFRAME_TAG)) {
    // data-src wins: lazy-loaded players put a placeholder in src.
    const attrs = tag[0]
    add(attr(attrs, "data-src") ?? attr(attrs, "data-lazy-src") ?? attr(attrs, "src"), "iframe")
  }
  for (const tag of html.matchAll(EMBED_TAG)) {
    add(attr(tag[0], "src") ?? attr(tag[0], "data"), "embed")
  }
  for (const tag of html.matchAll(SOURCE_TAG)) {
    add(attr(tag[0], "src") ?? attr(tag[0], "data-src"), "source")
  }
  for (const tag of html.matchAll(META_REFRESH)) {
    const content = attr(tag[0], "content")
    const target = content?.match(/url\s*=\s*['"]?([^'";]+)/i)?.[1]
    add(target, "meta")
  }
  for (const tag of html.matchAll(OG_VIDEO)) {
    add(attr(tag[0], "content"), "meta")
  }

  // Scripts that assign a document location, which is a redirect in disguise.
  for (const match of html.matchAll(
    /(?:location\s*(?:\.\s*(?:href|assign|replace))?\s*(?:=|\(\s*))\s*["']([^"']{6,})["']/gi,
  )) {
    add(match[1], "redirect")
  }

  return results
}

export interface ScriptRef {
  /** Absolute URL for external scripts. */
  url?: string
  /** Inline body for inline scripts. */
  code?: string
}

export function findScripts(html: string, base: string): ScriptRef[] {
  const scripts: ScriptRef[] = []
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? ""
    const body = match[2] ?? ""
    const src = attr(attrs, "src") ?? attr(attrs, "data-src")
    if (src) {
      const url = absolutize(cleanUrl(src) ?? src, base)
      if (url && !isJunk(url)) scripts.push({ url })
    }
    if (body.trim().length > 16) scripts.push({ code: body })
  }
  return scripts
}

/** Reads one attribute out of a raw tag string. */
export function attr(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
  const match = pattern.exec(tag)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3]
}

/** Every attribute of a tag, lower-cased keys. */
export function attrs(tag: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ""
  }
  return result
}

/** Strips tags so text-only heuristics (server labels) aren't fooled by markup. */
export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
}

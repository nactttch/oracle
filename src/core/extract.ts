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
  [/\.f4m(\?|#|$)/i, "hds"],
  [/\.ism(?:[/\\]manifest)?(\?|#|$)/i, "smooth"],
  [/\.mp4(\?|#|$)/i, "mp4"],
  [/\.m4v(\?|#|$)/i, "mp4"],
  [/\.mov(\?|#|$)/i, "mp4"],
  [/\.webm(\?|#|$)/i, "webm"],
  [/\.mkv(\?|#|$)/i, "mkv"],
  [/\.flv(\?|#|$)/i, "flv"],
  [/\.ts(\?|#|$)/i, "ts"],
  [/\.m2ts(\?|#|$)/i, "ts"],
  [/\.(?:aac|mp3|m4a|ogg|opus|flac|wav)(\?|#|$)/i, "audio"],
]

export function classify(url: string): StreamKind {
  // Protocol decides before anything else — an rtmp URL may carry no extension.
  if (/^rtmps?:/i.test(url)) return "rtmp"
  if (/^rtsps?:/i.test(url)) return "rtsp"
  if (/^srt:/i.test(url)) return "srt"
  if (/^wss?:/i.test(url)) return "websocket"

  const withoutHash = url.split("#")[0]!
  for (const [pattern, kind] of KIND_BY_EXTENSION) {
    if (pattern.test(withoutHash)) return kind
  }

  // Manifests that carry no extension: signed CDN paths, API-shaped routes and
  // packager conventions. These are the ones extension matching throws away.
  if (/[?&](?:type|format|ext|mime)=(?:m3u8|hls|application%2F|application\/)/i.test(url)) return "hls"
  if (/[?&](?:type|format|ext)=(?:mpd|dash)/i.test(url)) return "dash"
  if (/\/manifest\.mpd(\?|$)/i.test(url) || /\/dash\//i.test(url)) return "dash"
  if (/\/manifest(?:\(format=[^)]*\))?(\?|$)/i.test(url)) return "smooth"
  if (/\/(?:master|index|playlist|chunklist|chunks|live|stream)(?:_[\w-]+)?\.m3u8?/i.test(url)) return "hls"
  if (/\/hls\/|\/hls$|playlist\.m3u8/i.test(url)) return "hls"
  if (/\/(?:whep|whip)(?:\/|$|\?)/i.test(url)) return "webrtc"
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
    // Share and "about this player" link-outs. A player config routinely
    // carries aboutlink, a logo link and a Telegram invite next to the file
    // it actually plays; following them turns one page into a crawl of
    // telegram.org. None of these hosts has ever been the stream.
    "(?:^|//|\\.)t\\.me/|telegram\\.(?:org|me)|wa\\.me/|whatsapp\\.com",
    "instagram\\.com|linkedin\\.com|pinterest\\.|reddit\\.com|tumblr\\.com",
    "apis\\.google\\.com|plus\\.google\\.com|/intent/tweet",
    // Search and Google's own asset plumbing. A page that links to a Google
    // search, or loads a widget that does, otherwise drags the whole of
    // /xjs/_/js/ into the crawl — hundreds of requests, never a stream.
    "gstatic\\.com|/xjs/_/|google\\.com/(?:async|search|url|recaptcha)",
    "bing\\.com/|duckduckgo\\.com/|yandex\\.(?:ru|com)/",
    // Code that ships with the site rather than content it serves. A CMS
    // plugin bundles its own media — a quiz's sound-start.mp3, a player skin's
    // preview clip — and those are real audio files, so nothing downstream
    // rejects them. Uploads are excluded from this: that is where a WordPress
    // site keeps the video it actually published.
    "/wp-content/(?:plugins|themes|mu-plugins)/|/wp-includes/",
    "/(?:sites/all|sites/default)/(?:modules|themes)/|/typo3conf/ext/",
    "/node_modules/|/vendor/|/bower_components/",
  ].join("|"),
  "i",
)

/**
 * Interface sound effects. These are genuine audio files sitting in an assets
 * directory, so format alone never rules them out — a click, a countdown beep,
 * a correct-answer chime. No stream is named this.
 */
const UI_SOUND = new RegExp(
  [
    "/(?:sounds?|sfx|audio|assets|static|media)/[^?#]*",
    "(?:sound|click|beep|blip|pop|tick|tock|chime|ding|alert|notify|error|",
    "success|correct|wrong|win|lose|start|end|finish|intro|outro|hover|",
    "swipe|whoosh|applause|buzzer|countdown|timer|coin|level-?up)",
    "[\\w-]*\\.(?:mp3|wav|ogg|m4a|aac|opus|flac)(?:\\?|#|$)",
  ].join(""),
  "i",
)

/** The same names, wherever they sit — `/audio/sound-start.mp3` or `/x/beep.mp3`. */
const UI_SOUND_BARE = new RegExp(
  [
    "/(?:sound|click|beep|blip|pop|tick|chime|ding|alert|notify|buzzer|",
    "countdown|whoosh|applause)[\\w-]*\\.(?:mp3|wav|ogg|m4a|aac|opus)(?:\\?|#|$)",
  ].join(""),
  "i",
)

export function isJunk(url: string): boolean {
  return JUNK.test(url) || UI_SOUND.test(url) || UI_SOUND_BARE.test(url)
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
const RELATIVE_MEDIA =
  /["'`]((?:\.{0,2}\/)?[\w\-./~%]+\.(?:m3u8|m3u|mpd|f4m|ism|mp4|m4v|mov|webm|mkv|flv|ts|aac|mp3|m4a)(?:\?[^"'`\s]*)?)["'`]/gi

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

/**
 * Player-chrome containers. Their `link`, `url` and `file` keys are real config
 * keys pointing at real URLs — the station's homepage, the watermark PNG, the
 * "about this player" page — and none of them is ever the stream. Without this
 * every branded player donates its own website as a candidate.
 */
const CHROME_PARENTS = new Set([
  "logo", "about", "abouttext", "sharing", "share", "related", "advertising",
  "ads", "ga", "analytics", "skin", "branding", "watermark", "cast", "plugins",
  "provider", "author", "publisher", "menu", "button", "buttons",
])

/** True when a honeypot path like `jwplayer().setup()[0].file` names a stream. */
export function isStreamBearingPath(path: string): boolean {
  const segments = path.split(/[.[\]()]/).filter(Boolean)
  const leaf = segments.pop()
  if (!leaf || !CONFIG_KEYS.has(leaf.toLowerCase())) return false
  const parent = segments.pop()
  if (parent && CHROME_PARENTS.has(parent.toLowerCase())) return false
  return true
}

/**
 * Trims the junk that regex boundaries leave behind: escaped slashes from JSON,
 * HTML entities, and trailing punctuation that belonged to the surrounding code.
 */
/**
 * MIME types masquerading as relative paths.
 *
 * `type: "application/vnd.apple.mpegurl"` sits next to a `file:` key in every
 * HLS config on earth, and resolving it against the script's directory yields a
 * confident-looking `https://cdn/player/v/8.21.1/application/vnd.apple.mpegurl`
 * that has never existed.
 */
const MIME_TYPE = /^(?:application|audio|video|text|image|font|model|multipart|message)\/[\w.+-]+$/i

export function cleanUrl(raw: string): string | null {
  let url = raw.trim()
  if (!url) return null
  if (MIME_TYPE.test(url)) return null

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
/** Undoes one layer of JSON string escaping, leaving the markup intact. */
function unescapeJsonMarkup(text: string): string {
  return text
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u002f/gi, "/")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, "/")
}

export function findEmbeddedDocuments(rawHtml: string, base: string): EmbeddedDocument[] {
  const results: EmbeddedDocument[] = []
  const seen = new Set<string>()

  // Markup that arrived as a JSON string is still markup. A CMS that renders
  // the player through an AJAX payload or an inline config blob ships the
  // embed as   <iframe src=\"https:\/\/host\/player\">   — every quote
  // escaped, so a matcher looking for src=" walks straight past the one
  // iframe on the page that matters. Scanning an unescaped copy alongside the
  // original costs one pass and finds it.
  const html = /\\["'/]/.test(rawHtml) ? rawHtml + "\n" + unescapeJsonMarkup(rawHtml) : rawHtml

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

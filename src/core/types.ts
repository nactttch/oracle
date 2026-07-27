/**
 * Shared vocabulary for the dig engine.
 *
 * Everything the engine finds is a `Candidate`. Everything the engine *does* is
 * a `DigEvent`, so the TUI (or the JSON reporter) can narrate a dig without the
 * engine knowing either exists.
 */

export type StreamKind =
  | "hls" // .m3u8 / .m3u
  | "dash" // .mpd
  | "smooth" // IIS Smooth Streaming, /Manifest or .ism
  | "hds" // Adobe HDS, .f4m
  | "mp4"
  | "webm"
  | "mkv"
  | "flv"
  | "ts" // raw MPEG-TS
  | "audio" // aac, mp3, m4a, ogg, opus
  | "rtmp" // rtmp/rtmps
  | "rtsp"
  | "srt" // Secure Reliable Transport
  | "webrtc" // whep/whip
  | "websocket" // ws/wss media transport
  | "unknown"

/** How a candidate came to light. Ranked roughly by how much we trust it. */
export type Technique =
  | "plain-text" // sat in the HTML/JS as a literal
  | "attribute" // an element attribute (src, data-src, ...)
  | "json" // decoded out of a JSON payload
  | "escape-decode" // \x, \u, %, octal
  | "base64"
  | "hex"
  | "charcode" // String.fromCharCode(...)
  | "packer" // Dean Edwards p,a,c,k,e,d
  | "jsfuck"
  | "aaencode"
  | "string-array" // _0x rotated string table
  | "concat" // "ht"+"tps://..."
  | "sandbox" // ran the script against the honeypot DOM
  | "api" // returned by an XHR/fetch endpoint we replayed
  | "hls-variant" // pulled out of a master playlist
  | "redirect" // a Location header pointed at it
  | "token-signed" // a signing service unlocked it

export interface Candidate {
  /** Absolute, fully resolved. */
  url: string
  kind: StreamKind
  /** Document this was found in. */
  origin: string
  /** Every technique that had to fire to surface it, oldest first. */
  via: Technique[]
  /** Hops from the input URL. */
  depth: number
  /** 0..100. Raised by probing, lowered by looking like a decoy. */
  confidence: number
  /** Headers a player needs to replay it (Referer is usually mandatory). */
  headers: Record<string, string>
  /** Which server variant this came from, e.g. "serv=2". */
  server?: string

  // --- filled in by the prober ---
  verified?: boolean
  status?: number
  contentType?: string
  bytes?: number
  /** Master-playlist renditions, best first. */
  variants?: HlsVariant[]
  /** Separate audio/subtitle renditions from a master playlist. */
  media?: HlsMedia[]
  /** AES-128 / SAMPLE-AES protected. */
  encrypted?: boolean
  keyUri?: string
  keyMethod?: string
  /** No #EXT-X-ENDLIST => live edge. */
  live?: boolean
  /** Playable URL after a signing service signed it, when one was needed. */
  signedUrl?: string
  /** The service that signed it, so the user can re-sign when it expires. */
  tokenEndpoint?: string
  durationSec?: number
  segmentCount?: number
  resolution?: string
  note?: string
}

export interface HlsVariant {
  url: string
  bandwidth?: number
  averageBandwidth?: number
  resolution?: string
  codecs?: string
  frameRate?: number
  audioGroup?: string
}

export interface HlsMedia {
  type: string // AUDIO | SUBTITLES | CLOSED-CAPTIONS
  name?: string
  language?: string
  groupId?: string
  url?: string
  isDefault?: boolean
}

/** A sibling of the input player URL that serves a different stream. */
export interface ServerVariant {
  url: string
  label: string
  /** Which enumeration strategy produced it. */
  how: string
  /** Non-null once fetched: how different its body was from the base player. */
  novelty?: number
}

export type DigEvent =
  | { type: "phase"; phase: string; detail?: string }
  | { type: "fetch"; url: string; depth: number }
  | { type: "fetched"; url: string; status: number; bytes: number; ms: number }
  | { type: "fetch-failed"; url: string; error: string }
  | { type: "layer"; url: string; technique: Technique; detail?: string }
  | { type: "server"; variant: ServerVariant }
  | { type: "candidate"; candidate: Candidate }
  | { type: "probe"; url: string }
  | { type: "probed"; candidate: Candidate }
  | { type: "stat"; docs: number; scripts: number; bytes: number; candidates: number }
  | { type: "warn"; message: string }
  | { type: "done"; candidates: Candidate[]; servers: ServerVariant[] }

export type Reporter = (event: DigEvent) => void

export interface DigOptions {
  /** How many document hops to follow (iframes, redirects, nested players). */
  maxDepth: number
  /** Hard ceiling on documents fetched. */
  maxDocuments: number
  /** Parallel in-flight requests. */
  concurrency: number
  /** Per-request timeout, ms. */
  timeout: number
  /** Look for sibling servers (?serv=2 and friends). */
  digServers: boolean
  /** How many values to try per candidate server parameter. */
  serverDepth: number
  /** Run scripts against the honeypot DOM. */
  sandbox: boolean
  /** Confirm each candidate with a real request. */
  probe: boolean
  /** Expand master playlists into their renditions. */
  expandVariants: boolean
  /** Override the Referer sent to the first URL. */
  referer?: string
  userAgent: string
  /** Extra headers merged into every request. */
  headers: Record<string, string>
  /** Stop as soon as this many verified streams are in hand (0 = no limit). */
  stopAfter: number
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export const DEFAULT_OPTIONS: DigOptions = {
  maxDepth: 4,
  maxDocuments: 120,
  concurrency: 8,
  timeout: 15_000,
  digServers: true,
  serverDepth: 8,
  sandbox: true,
  probe: true,
  expandVariants: true,
  userAgent: DEFAULT_USER_AGENT,
  headers: {},
  stopAfter: 0,
}

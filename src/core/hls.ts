/**
 * HLS and DASH manifest parsing.
 *
 * A raw `.m3u8` hit is only half an answer. A master playlist points at the
 * renditions that actually carry video, tells us whether the stream is live or
 * VOD, and names the AES key URI when the segments are encrypted — all of which
 * is the difference between "found a URL" and "here is what you can play".
 */

import { absolutize } from "./http.js"
import type { HlsMedia, HlsVariant } from "./types.js"

export interface ParsedPlaylist {
  kind: "master" | "media" | "unknown"
  variants: HlsVariant[]
  media: HlsMedia[]
  /** Absent #EXT-X-ENDLIST on a media playlist means we're at the live edge. */
  live: boolean
  segmentCount: number
  durationSec: number
  encrypted: boolean
  keyUri?: string
  keyMethod?: string
  targetDuration?: number
}

export function isPlaylist(body: string): boolean {
  return body.trimStart().startsWith("#EXTM3U")
}

export function parsePlaylist(body: string, base: string): ParsedPlaylist {
  const lines = body.split(/\r?\n/)
  const variants: HlsVariant[] = []
  const media: HlsMedia[] = []
  let live = true
  let segmentCount = 0
  let durationSec = 0
  let encrypted = false
  let keyUri: string | undefined
  let keyMethod: string | undefined
  let targetDuration: number | undefined
  let sawStreamInf = false
  let sawSegment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      sawStreamInf = true
      const tags = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length))
      // The URI is the next non-comment line.
      let uri: string | undefined
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!.trim()
        if (!next || next.startsWith("#")) continue
        uri = next
        i = j
        break
      }
      const resolved = uri ? absolutize(uri, base) : null
      if (resolved) {
        variants.push({
          url: resolved,
          bandwidth: numeric(tags.BANDWIDTH),
          averageBandwidth: numeric(tags["AVERAGE-BANDWIDTH"]),
          resolution: tags.RESOLUTION,
          codecs: tags.CODECS,
          frameRate: numeric(tags["FRAME-RATE"]),
          audioGroup: tags.AUDIO,
        })
      }
      continue
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const tags = parseAttributes(line.slice("#EXT-X-MEDIA:".length))
      const uri = tags.URI ? absolutize(tags.URI, base) : null
      media.push({
        type: tags.TYPE ?? "UNKNOWN",
        name: tags.NAME,
        language: tags.LANGUAGE,
        groupId: tags["GROUP-ID"],
        url: uri ?? undefined,
        isDefault: tags.DEFAULT === "YES",
      })
      continue
    }

    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      const tags = parseAttributes(line.slice(line.indexOf(":") + 1))
      if (tags.METHOD && tags.METHOD !== "NONE") {
        encrypted = true
        keyMethod = tags.METHOD
        if (tags.URI) keyUri = absolutize(tags.URI, base) ?? tags.URI
      }
      continue
    }

    if (line.startsWith("#EXTINF:")) {
      sawSegment = true
      segmentCount++
      durationSec += numeric(line.slice("#EXTINF:".length).split(",")[0]) ?? 0
      continue
    }

    if (line.startsWith("#EXT-X-ENDLIST")) {
      live = false
      continue
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = numeric(line.slice("#EXT-X-TARGETDURATION:".length))
      continue
    }

    if (line.startsWith("#EXT-X-PLAYLIST-TYPE:") && /VOD/i.test(line)) {
      live = false
    }
  }

  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))

  return {
    kind: sawStreamInf ? "master" : sawSegment ? "media" : "unknown",
    variants,
    media,
    live: sawStreamInf ? false : live,
    segmentCount,
    durationSec: Math.round(durationSec),
    encrypted,
    keyUri,
    keyMethod,
    targetDuration,
  }
}

/** `BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f"` -> object. */
export function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  const pattern = /([A-Za-z0-9-]+)=("([^"]*)"|[^,]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) {
    result[match[1]!] = match[3] ?? match[2] ?? ""
  }
  return result
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Best human label for a rendition: `1920x1080 @ 5.0 Mbps`. */
export function describeVariant(variant: HlsVariant): string {
  const parts: string[] = []
  if (variant.resolution) parts.push(variant.resolution)
  if (variant.bandwidth) parts.push(`${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps`)
  if (!parts.length && variant.codecs) parts.push(variant.codecs)
  return parts.join(" @ ") || "stream"
}

// ---------------------------------------------------------------------------
// DASH
// ---------------------------------------------------------------------------

export function isDashManifest(body: string): boolean {
  return /<MPD[\s>]/i.test(body.slice(0, 2000))
}

export interface ParsedDash {
  live: boolean
  durationSec?: number
  representations: Array<{ id?: string; bandwidth?: number; resolution?: string; codecs?: string }>
  encrypted: boolean
}

export function parseDash(body: string): ParsedDash {
  const live = /type\s*=\s*"dynamic"/i.test(body)
  const durationMatch = /mediaPresentationDuration\s*=\s*"([^"]+)"/i.exec(body)
  const representations: ParsedDash["representations"] = []

  for (const tag of body.matchAll(/<Representation\b([^>]*)>/gi)) {
    const raw = tag[1] ?? ""
    const read = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(raw)?.[1]
    const width = read("width")
    const height = read("height")
    representations.push({
      id: read("id"),
      bandwidth: Number(read("bandwidth")) || undefined,
      resolution: width && height ? `${width}x${height}` : undefined,
      codecs: read("codecs"),
    })
  }
  representations.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))

  return {
    live,
    durationSec: durationMatch ? parseIsoDuration(durationMatch[1]!) : undefined,
    representations,
    encrypted: /<ContentProtection\b/i.test(body),
  }
}

/** `PT1H2M3.5S` -> seconds. */
export function parseIsoDuration(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(value.trim())
  if (!match) return undefined
  const [, days, hours, minutes, seconds] = match
  const total =
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  return Number.isFinite(total) ? Math.round(total) : undefined
}

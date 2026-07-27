/**
 * Candidate verification.
 *
 * Finding a `.m3u8` in a page proves nothing — half of them are stale demo
 * URLs, decoys, or geo-locked stubs that 403 the moment you ask. Probing turns
 * a guess into a fact: it replays the request with the Referer the player would
 * have sent, reads the manifest, and reports what is actually on the other end.
 */

import type { HttpClient } from "./http.js"
import { signUrl } from "./token.js"
import { isDashManifest, isPlaylist, parseDash, parsePlaylist } from "./hls.js"
import type { Candidate } from "./types.js"

export interface ProbeOptions {
  timeout: number
  /** Follow master playlists down to their renditions. */
  expandVariants: boolean
  /** Signing services discovered during the dig, tried on a 401/403. */
  tokenEndpoints?: string[]
}

export interface ProbeOutcome {
  candidate: Candidate
  /** Renditions worth surfacing as candidates in their own right. */
  discovered: Candidate[]
}

export async function probeCandidate(
  http: HttpClient,
  candidate: Candidate,
  options: ProbeOptions,
): Promise<ProbeOutcome> {
  const discovered: Candidate[] = []
  const result: Candidate = { ...candidate }

  if (/^rtmps?:/i.test(candidate.url) || /^wss?:/i.test(candidate.url)) {
    // Not reachable over HTTP; report it honestly rather than marking it dead.
    result.note = "not verifiable over http"
    result.confidence = Math.min(result.confidence, 55)
    return { candidate: result, discovered }
  }

  try {
    const isManifest = candidate.kind === "hls" || candidate.kind === "dash" || candidate.kind === "unknown"
    const response = await http.get(candidate.url, {
      referer: candidate.headers.referer,
      timeout: options.timeout,
      // Manifests are text and small; media files only need their first block.
      maxBytes: isManifest ? 2 * 1024 * 1024 : 2048,
      headers: isManifest ? {} : { range: "bytes=0-2047" },
    })

    result.status = response.status
    result.contentType = response.contentType
    result.bytes = Number(response.headers["content-length"]) || response.bytes

    if (!response.ok || response.status >= 400) {
      // A 401/403 on a manifest usually means "unsigned", not "wrong URL".
      // Ask a signing service and try once more before writing it off.
      if ((response.status === 403 || response.status === 401) && options.tokenEndpoints?.length) {
        const signed = await trySigning(http, candidate, options)
        if (signed) return signed
      }
      result.verified = false
      result.confidence = clamp(result.confidence - (response.status === 403 ? 25 : 40))
      result.note = `http ${response.status}`
      return { candidate: result, discovered }
    }

    if (isPlaylist(response.body)) {
      const playlist = parsePlaylist(response.body, response.finalUrl)
      result.verified = true
      result.kind = "hls"
      result.live = playlist.live
      result.encrypted = playlist.encrypted
      result.keyUri = playlist.keyUri
      result.keyMethod = playlist.keyMethod
      result.variants = playlist.variants
      result.media = playlist.media
      result.segmentCount = playlist.segmentCount
      result.durationSec = playlist.durationSec || undefined
      result.resolution = playlist.variants[0]?.resolution
      result.confidence = clamp(result.confidence + (playlist.kind === "master" ? 40 : 35))
      result.note =
        playlist.kind === "master"
          ? `master · ${playlist.variants.length} rendition${playlist.variants.length === 1 ? "" : "s"}`
          : playlist.live
            ? `live · ${playlist.segmentCount} segments`
            : `vod · ${formatDuration(playlist.durationSec)}`

      if (options.expandVariants && playlist.kind === "master") {
        // A signature lives in the query string, and HLS resolves its relative
        // URIs against the *path* only — so every rendition inside a signed
        // master comes out unsigned and 403s the moment a player follows it.
        // Carry the master's query down to each rendition.
        const inherited = queryOf(response.finalUrl)
        for (const variant of playlist.variants) {
          const signed = inherited && !queryOf(variant.url) ? withQuery(variant.url, inherited) : undefined
          discovered.push({
            ...candidate,
            url: variant.url,
            signedUrl: signed,
            tokenEndpoint: signed ? candidate.tokenEndpoint : undefined,
            kind: "hls",
            via: signed ? [...candidate.via, "hls-variant", "token-signed"] : [...candidate.via, "hls-variant"],
            origin: response.finalUrl,
            depth: candidate.depth + 1,
            resolution: variant.resolution,
            confidence: clamp(result.confidence - 2),
            note: describeBandwidth(variant.bandwidth, variant.resolution),
            // Cleared so the caller probes these rather than trusting the
            // master's word for them.
            verified: undefined,
          })
        }
      }
      return { candidate: result, discovered }
    }

    if (isDashManifest(response.body)) {
      const dash = parseDash(response.body)
      result.verified = true
      result.kind = "dash"
      result.live = dash.live
      result.encrypted = dash.encrypted
      result.durationSec = dash.durationSec
      result.resolution = dash.representations[0]?.resolution
      result.confidence = clamp(result.confidence + 38)
      result.note = `mpd · ${dash.representations.length} representations`
      return { candidate: result, discovered }
    }

    // Binary media: trust the content type and the fact that bytes came back.
    if (/^(?:video|audio|application\/octet-stream)/.test(response.contentType) || response.status === 206) {
      result.verified = true
      result.confidence = clamp(result.confidence + 30)
      result.note = response.contentType.split(";")[0] || "media"
      return { candidate: result, discovered }
    }

    // A 200 that is neither a manifest nor media is usually an error page.
    result.verified = false
    result.confidence = clamp(result.confidence - 20)
    result.note = response.contentType.includes("html") ? "html, not a stream" : "unrecognised body"
    return { candidate: result, discovered }
  } catch (error) {
    result.verified = false
    result.confidence = clamp(result.confidence - 30)
    result.note = error instanceof Error ? shortError(error.message) : "request failed"
    return { candidate: result, discovered }
  }
}

/**
 * Signs a rejected manifest and re-probes it.
 *
 * On success the *signed* URL is what gets verified and reported, since that is
 * what actually plays — but the original stays as `url`, because a signature is
 * short-lived and the bare URL plus the endpoint is the reusable pair.
 */
async function trySigning(
  http: HttpClient,
  candidate: Candidate,
  options: ProbeOptions,
): Promise<ProbeOutcome | null> {
  const signed = await signUrl(http, candidate.url, options.tokenEndpoints ?? [], {
    referer: candidate.headers.referer,
    timeout: options.timeout,
    verify: async (url) => {
      try {
        const check = await http.get(url, {
          referer: candidate.headers.referer,
          timeout: options.timeout,
          maxBytes: 512 * 1024,
        })
        return check.ok && (isPlaylist(check.body) || isDashManifest(check.body))
      } catch {
        return false
      }
    },
  })
  if (!signed) return null

  // Re-probe the signed URL so the report carries real manifest facts.
  const outcome = await probeCandidate(
    http,
    { ...candidate, url: signed.url, via: [...candidate.via, "token-signed"] },
    { ...options, tokenEndpoints: [] },
  )

  return {
    candidate: {
      ...outcome.candidate,
      url: candidate.url,
      signedUrl: signed.url,
      tokenEndpoint: signed.endpoint,
      note: outcome.candidate.note ? `${outcome.candidate.note} · token-signed` : "token-signed",
    },
    discovered: outcome.discovered,
  }
}

/** Starting confidence, before anything is verified. */
export function initialConfidence(candidate: Pick<Candidate, "kind" | "via" | "url">): number {
  let score = 40
  if (candidate.kind === "hls") score += 22
  else if (candidate.kind === "dash") score += 18
  else if (candidate.kind === "mp4" || candidate.kind === "webm") score += 12
  else if (candidate.kind === "unknown") score -= 12

  // Something that had to be decoded was hidden on purpose, which is a good
  // sign it is the real one rather than a decoy sitting in plain sight.
  const decoded = candidate.via.some((technique) =>
    ["packer", "base64", "hex", "charcode", "jsfuck", "aaencode", "string-array", "escape-decode"].includes(technique),
  )
  if (decoded) score += 10
  if (candidate.via.includes("sandbox")) score += 8
  if (candidate.via.includes("hls-variant")) score += 6

  if (/master\.m3u8|playlist\.m3u8|index\.m3u8/i.test(candidate.url)) score += 6
  if (/\/(?:sample|demo|test|preview|trailer|intro|ads?)\b/i.test(candidate.url)) score -= 18
  if (/\b(?:bigbuckbunny|sintel|tears-of-steel|mux\.dev|test-streams)\b/i.test(candidate.url)) score -= 30

  return clamp(score)
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** The query string of a URL, without the `?`. Empty when there is none. */
function queryOf(url: string): string {
  try {
    return new URL(url).search.replace(/^\?/, "")
  } catch {
    return ""
  }
}

function withQuery(url: string, query: string): string | undefined {
  try {
    const parsed = new URL(url)
    parsed.search = `?${query}`
    return parsed.toString()
  } catch {
    return undefined
  }
}

function describeBandwidth(bandwidth: number | undefined, resolution: string | undefined): string {
  const parts: string[] = []
  if (resolution) parts.push(resolution)
  if (bandwidth) parts.push(`${(bandwidth / 1_000_000).toFixed(1)} Mbps`)
  return parts.join(" · ") || "rendition"
}

function formatDuration(seconds: number): string {
  if (!seconds) return "unknown length"
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function shortError(message: string): string {
  if (/abort/i.test(message)) return "timed out"
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) return "host not found"
  if (/certificate|SSL|TLS/i.test(message)) return "tls error"
  if (/ECONNREFUSED/i.test(message)) return "connection refused"
  return message.slice(0, 60)
}

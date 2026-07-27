/**
 * Export formats.
 *
 * A stream URL on its own is often not playable — most of these hosts reject a
 * request without the Referer the player would have sent. So every export
 * carries the headers alongside the URL, and the generated player commands have
 * them baked in. Copy a line, paste it in a shell, and it plays.
 */

import type { Candidate } from "../core/types.js"
import type { DigResult } from "../core/engine.js"
import { platformAdvice } from "../core/platforms.js"
import { describeCandidate, describeTechniques } from "./format.js"

export function toJson(result: DigResult): string {
  return JSON.stringify(
    {
      input: result.input,
      generatedAt: new Date().toISOString(),
      stats: result.stats,
      servers: result.servers.map((server) => ({
        url: server.url,
        label: server.label,
        discoveredBy: server.how,
      })),
      platformEmbeds: result.platforms,
      streams: result.candidates.map((candidate) => ({
        url: candidate.url,
        kind: candidate.kind,
        verified: candidate.verified ?? null,
        confidence: candidate.confidence,
        server: candidate.server ?? null,
        live: candidate.live ?? null,
        durationSec: candidate.durationSec ?? null,
        resolution: candidate.resolution ?? null,
        encrypted: candidate.encrypted ?? false,
        keyUri: candidate.keyUri ?? null,
        keyMethod: candidate.keyMethod ?? null,
        signedUrl: candidate.signedUrl ?? null,
        tokenEndpoint: candidate.tokenEndpoint ?? null,
        status: candidate.status ?? null,
        contentType: candidate.contentType ?? null,
        note: candidate.note ?? null,
        headers: candidate.headers,
        foundVia: candidate.via,
        foundIn: candidate.origin,
        variants: candidate.variants ?? [],
        media: candidate.media ?? [],
      })),
    },
    null,
    2,
  )
}

/** An `.m3u` playlist most players will open directly. */
export function toM3u(result: DigResult): string {
  const lines = ["#EXTM3U", `# dug by oracle from ${result.input}`, ""]
  for (const candidate of result.candidates) {
    if (candidate.verified === false) continue
    const name = [candidate.server, describeCandidate(candidate)].filter(Boolean).join(" · ")
    lines.push(`#EXTINF:-1,${name}`)
    if (candidate.headers.referer) {
      // Recognised by VLC and mpv; ignored harmlessly elsewhere.
      lines.push(`#EXTVLCOPT:http-referrer=${candidate.headers.referer}`)
    }
    lines.push(candidate.signedUrl ?? candidate.url, "")
  }
  return lines.join("\n")
}

/** Ready-to-run commands, with the headers the host demands. */
export function toCommands(candidate: Candidate, userAgent: string): Array<{ tool: string; command: string }> {
  const referer = candidate.headers.referer
  // A signed URL is the one that actually plays; the bare one 403s.
  const playable = candidate.signedUrl ?? candidate.url
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

  const mpv = [
    "mpv",
    quote(playable),
    `--user-agent=${quote(userAgent)}`,
    referer ? `--http-header-fields=${quote(`Referer: ${referer}`)}` : "",
  ]
    .filter(Boolean)
    .join(" ")

  const ffmpeg = [
    "ffmpeg",
    `-user_agent ${quote(userAgent)}`,
    referer ? `-headers ${quote(`Referer: ${referer}\r\n`)}` : "",
    `-i ${quote(playable)}`,
    "-c copy",
    quote(suggestFilename(candidate)),
  ]
    .filter(Boolean)
    .join(" ")

  const vlc = ["vlc", quote(playable), referer ? `--http-referrer=${quote(referer)}` : ""]
    .filter(Boolean)
    .join(" ")

  const curl = [
    "curl",
    "-L",
    `-A ${quote(userAgent)}`,
    referer ? `-e ${quote(referer)}` : "",
    quote(playable),
    "-o",
    quote(suggestFilename(candidate)),
  ]
    .filter(Boolean)
    .join(" ")

  return [
    { tool: "mpv", command: mpv },
    { tool: "vlc", command: vlc },
    { tool: "ffmpeg", command: ffmpeg },
    { tool: "curl", command: curl },
  ]
}

export function suggestFilename(candidate: Candidate): string {
  const stem = (candidate.server ?? "stream").replace(/[^\w-]+/g, "_").slice(0, 40) || "stream"
  const extension = candidate.kind === "hls" || candidate.kind === "dash" ? "mp4" : candidate.kind
  return `${stem}.${extension}`
}

/** Plain-text report for `--print`, pipes, and CI logs. */
export function toText(result: DigResult): string {
  const lines: string[] = []
  lines.push(`oracle · ${result.input}`)
  lines.push(
    `${result.candidates.length} candidate(s) · ${result.servers.length} server(s) · ` +
      `${result.stats.documents} docs · ${result.stats.requests} requests · ${result.stats.ms}ms`,
  )
  lines.push("")

  if (result.servers.length) {
    lines.push("servers")
    for (const server of result.servers) lines.push(`  [${server.label}] ${server.url}  (${server.how})`)
    lines.push("")
  }

  if (result.platforms.length) {
    lines.push("platform embeds")
    for (const embed of result.platforms) {
      lines.push(`  ${embed.platform}  ${embed.watchUrl ?? embed.url}`)
    }
    lines.push(`  ${platformAdvice(result.platforms)}`)
    lines.push("")
  }

  if (!result.candidates.length) {
    lines.push("no raw streams found")
    return lines.join("\n")
  }

  lines.push("streams")
  for (const candidate of result.candidates) {
    const mark = candidate.verified === true ? "OK  " : candidate.verified === false ? "DEAD" : "??  "
    lines.push(`  ${mark} [${String(candidate.confidence).padStart(3)}] ${candidate.url}`)
    const details = [
      describeCandidate(candidate),
      candidate.server ? `server ${candidate.server}` : "",
      candidate.note ?? "",
    ]
      .filter(Boolean)
      .join(" · ")
    lines.push(`       ${details}`)
    lines.push(`       via ${describeTechniques(candidate)}`)
    if (candidate.signedUrl) lines.push(`       play  ${candidate.signedUrl}`)
    if (candidate.tokenEndpoint) lines.push(`       token ${candidate.tokenEndpoint}`)
    if (candidate.headers.referer) lines.push(`       referer ${candidate.headers.referer}`)
  }
  return lines.join("\n")
}

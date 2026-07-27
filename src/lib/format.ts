/** Formatting helpers for the terminal UI. Pure functions, easy to test. */

import type { Candidate } from "../core/types.js"

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—"
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.floor(seconds % 60)
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes) return `${minutes}m${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** `https://edge.cdn.net/live/ch5/index.m3u8?tk=x` -> `edge.cdn.net` */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 24)
  }
}

/**
 * Shortens a URL from the middle, keeping the host and the filename — the two
 * parts that tell you whether it is the stream you wanted.
 */
export function shortenUrl(url: string, width: number): string {
  if (url.length <= width) return url
  if (width < 12) return url.slice(0, Math.max(0, width - 1)) + "…"
  try {
    const parsed = new URL(url)
    const host = parsed.host
    const tail = parsed.pathname.split("/").filter(Boolean).pop() ?? ""
    const query = parsed.search ? "?…" : ""
    const compact = `${host}/…/${tail}${query}`
    if (compact.length <= width) return compact
    return compact.slice(0, width - 1) + "…"
  } catch {
    const head = Math.ceil((width - 1) / 2)
    return url.slice(0, head) + "…" + url.slice(url.length - (width - 1 - head))
  }
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…"
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? truncate(text, width) : text + " ".repeat(width - text.length)
}

/** One-line summary of what a candidate turned out to be. */
export function describeCandidate(candidate: Candidate): string {
  const parts: string[] = []
  parts.push(candidate.kind.toUpperCase())
  if (candidate.resolution) parts.push(candidate.resolution)
  if (candidate.live === true) parts.push("live")
  else if (candidate.live === false && candidate.durationSec) parts.push(formatDuration(candidate.durationSec))
  if (candidate.encrypted) parts.push(candidate.keyMethod ? `enc:${candidate.keyMethod}` : "encrypted")
  if (candidate.variants?.length) parts.push(`${candidate.variants.length} renditions`)
  return parts.join(" · ")
}

/** Status glyph: proven, unproven, or proven dead. */
export function statusGlyph(candidate: Candidate): { glyph: string; tone: "ok" | "warn" | "bad" } {
  if (candidate.verified === true) return { glyph: "●", tone: "ok" }
  if (candidate.verified === false) return { glyph: "○", tone: "bad" }
  return { glyph: "◐", tone: "warn" }
}

/** Human name for the chain of techniques that exposed a URL. */
export function describeTechniques(candidate: Candidate): string {
  const names: Record<string, string> = {
    "plain-text": "plain text",
    attribute: "attribute",
    json: "config key",
    "escape-decode": "escapes",
    base64: "base64",
    hex: "hex",
    charcode: "charcodes",
    packer: "packer",
    jsfuck: "jsfuck",
    aaencode: "aaencode",
    "string-array": "string array",
    concat: "concat",
    sandbox: "sandbox",
    api: "xhr replay",
    "hls-variant": "master playlist",
    redirect: "redirect",
  }
  const seen = candidate.via.map((technique) => names[technique] ?? technique)
  return [...new Set(seen)].join(" → ") || "direct"
}

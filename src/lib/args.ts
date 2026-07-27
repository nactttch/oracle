/**
 * Command-line parsing.
 *
 * Kept as a pure function over `argv` so the whole surface is unit-testable
 * without spawning a process.
 */

import { isThemeMode, type ThemeMode } from "../theme.js"

export type OutputFormat = "text" | "json" | "m3u" | "urls"

export interface ParsedArgs {
  url?: string
  help?: boolean
  version?: boolean
  themeMode?: ThemeMode
  /** Run without the TUI and print to stdout. */
  headless?: boolean
  format?: OutputFormat
  output?: string
  depth?: number
  serverDepth?: number
  timeout?: number
  concurrency?: number
  noServers?: boolean
  noSandbox?: boolean
  noProbe?: boolean
  referer?: string
  userAgent?: string
  headers?: Record<string, string>
  stopAfter?: number
  error?: string
}

const FORMATS = new Set<OutputFormat>(["text", "json", "m3u", "urls"])

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {}
  const headers: Record<string, string> = {}

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!

    // `--key=value` and `--key value` are both accepted.
    const equals = arg.indexOf("=")
    const flag = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg
    const inline = arg.startsWith("--") && equals > 0 ? arg.slice(equals + 1) : undefined
    const takeValue = (): string | undefined => inline ?? argv[++index]

    switch (flag) {
      case "-h":
      case "--help":
        parsed.help = true
        break
      case "-v":
      case "--version":
        parsed.version = true
        break
      case "--theme": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--theme needs a mode (auto, dark, light)" }
        if (!isThemeMode(value)) return { ...parsed, error: `unknown theme “${value}”` }
        parsed.themeMode = value
        break
      }
      case "-p":
      case "--print":
      case "--headless":
        parsed.headless = true
        break
      case "-f":
      case "--format": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--format needs a value (text, json, m3u, urls)" }
        if (!FORMATS.has(value as OutputFormat)) return { ...parsed, error: `unknown format “${value}”` }
        parsed.format = value as OutputFormat
        parsed.headless = true
        break
      }
      case "-o":
      case "--output": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--output needs a file path" }
        parsed.output = value
        break
      }
      case "-d":
      case "--depth": {
        const value = numeric(takeValue())
        if (value === undefined) return { ...parsed, error: "--depth needs a number" }
        parsed.depth = value
        break
      }
      case "--server-depth": {
        const value = numeric(takeValue())
        if (value === undefined) return { ...parsed, error: "--server-depth needs a number" }
        parsed.serverDepth = value
        break
      }
      case "-t":
      case "--timeout": {
        const value = numeric(takeValue())
        if (value === undefined) return { ...parsed, error: "--timeout needs milliseconds" }
        parsed.timeout = value
        break
      }
      case "-c":
      case "--concurrency": {
        const value = numeric(takeValue())
        if (value === undefined) return { ...parsed, error: "--concurrency needs a number" }
        parsed.concurrency = value
        break
      }
      case "--stop-after": {
        const value = numeric(takeValue())
        if (value === undefined) return { ...parsed, error: "--stop-after needs a number" }
        parsed.stopAfter = value
        break
      }
      case "--no-servers":
        parsed.noServers = true
        break
      case "--no-sandbox":
        parsed.noSandbox = true
        break
      case "--no-probe":
        parsed.noProbe = true
        break
      case "-r":
      case "--referer":
      case "--referrer": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--referer needs a URL" }
        parsed.referer = value
        break
      }
      case "-A":
      case "--user-agent": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--user-agent needs a value" }
        parsed.userAgent = value
        break
      }
      case "-H":
      case "--header": {
        const value = takeValue()
        if (!value) return { ...parsed, error: "--header needs “Name: value”" }
        const colon = value.indexOf(":")
        if (colon <= 0) return { ...parsed, error: `malformed header “${value}” (expected “Name: value”)` }
        headers[value.slice(0, colon).trim().toLowerCase()] = value.slice(colon + 1).trim()
        break
      }
      default: {
        if (flag.startsWith("-") && flag.length > 1) {
          return { ...parsed, error: `unknown option “${flag}”` }
        }
        if (parsed.url) return { ...parsed, error: "only one url can be dug at a time" }
        parsed.url = arg
      }
    }
  }

  if (Object.keys(headers).length) parsed.headers = headers
  return parsed
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** A cheap sanity check before spending a dig on it. */
export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  // Bare `host/path` is fine; a lone word is not.
  return /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(trimmed)
}

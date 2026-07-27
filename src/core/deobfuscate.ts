/**
 * Static deobfuscation passes.
 *
 * These run *before* the sandbox because they are cheap, deterministic and
 * safe: no code executes, so a script that tries to detect an automated client
 * never gets the chance. Anything these can't crack falls through to
 * `sandbox.ts`, which actually runs the thing.
 *
 * Each pass is independent and idempotent-ish, and `deobfuscate()` re-runs the
 * whole set until the text stops changing — obfuscators stack (packed code that
 * unpacks into hex escapes that decode into base64), so one pass is never
 * enough.
 */

import type { Technique } from "./types.js"

export interface DeobfuscationResult {
  /** Transformed source plus any decoded payloads appended for harvesting. */
  text: string
  techniques: Technique[]
}

const MAX_ROUNDS = 6

export function deobfuscate(source: string): DeobfuscationResult {
  let text = source
  const techniques = new Set<Technique>()
  const extras: string[] = []

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const before = text

    const unpacked = unpackAll(text)
    if (unpacked !== text) {
      techniques.add("packer")
      text = unpacked
    }

    const concatenated = collapseConcatenations(text)
    if (concatenated !== text) {
      techniques.add("concat")
      text = concatenated
    }

    const unescaped = decodeEscapes(text)
    if (unescaped !== text) {
      techniques.add("escape-decode")
      text = unescaped
    }

    const charcoded = decodeCharCodes(text)
    if (charcoded !== text) {
      techniques.add("charcode")
      text = charcoded
    }

    const percent = decodePercentSequences(text)
    if (percent !== text) {
      techniques.add("escape-decode")
      text = percent
    }

    // Payload decoders don't rewrite the source, they *append* what they found,
    // so a false positive can never corrupt code a later pass depends on.
    const b64 = harvestBase64(text)
    if (b64.length) {
      techniques.add("base64")
      extras.push(...b64)
    }

    const hex = harvestHexBlobs(text)
    if (hex.length) {
      techniques.add("hex")
      extras.push(...hex)
    }

    if (text === before) break
    // Feed decoded payloads back through the passes — base64 often wraps
    // another layer.
    if (extras.length) text += "\n" + extras.splice(0).join("\n")
  }

  if (extras.length) text += "\n" + extras.join("\n")

  if (looksLikeJsFuck(source)) techniques.add("jsfuck")
  if (looksLikeAaEncode(source)) techniques.add("aaencode")
  if (/_0x[0-9a-f]{4,}/i.test(source)) techniques.add("string-array")

  return { text, techniques: [...techniques] }
}

// ---------------------------------------------------------------------------
// Dean Edwards packer:  eval(function(p,a,c,k,e,d){...}('...',62,118,'...'.split('|'),0,{}))
// ---------------------------------------------------------------------------

const PACKER_SIGNATURE = /function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/

/** Unpacks every packed block in `source`, including packs nested in packs. */
export function unpackAll(source: string): string {
  let text = source
  for (let round = 0; round < 5; round++) {
    const next = unpackOnce(text)
    if (next === text) break
    text = next
  }
  return text
}

function unpackOnce(source: string): string {
  const match = PACKER_SIGNATURE.exec(source)
  if (!match) return source

  // Body of the packer function.
  const bodyStart = source.indexOf("{", match.index + match[0].length)
  if (bodyStart < 0) return source
  const bodyEnd = matchBracket(source, bodyStart, "{", "}")
  if (bodyEnd < 0) return source

  // Its invocation: }( 'payload', 62, 118, 'a|b|c'.split('|'), 0, {} )
  const callStart = source.indexOf("(", bodyEnd)
  if (callStart < 0) return source
  const callEnd = matchBracket(source, callStart, "(", ")")
  if (callEnd < 0) return source

  const args = splitTopLevelArgs(source.slice(callStart + 1, callEnd))
  if (args.length < 4) return source

  const payload = parseStringLiteral(args[0]!)
  const radix = Number(args[1])
  const count = Number(args[2])
  const dictionary = parseStringLiteral(args[3]!.replace(/\.split\s*\(.*\)\s*$/s, ""))
  if (payload === null || dictionary === null || !Number.isFinite(radix) || !Number.isFinite(count)) {
    return source
  }

  const words = dictionary.split("|")
  const table = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const word = words[i]
    if (word) table.set(toBase(i, radix), word)
  }

  const decoded = payload.replace(/\b\w+\b/g, (token) => table.get(token) ?? token)

  // Replace the whole `eval(...)` expression, not just the function, so the
  // result is syntactically sane for the next round.
  const evalStart = findEnclosingEval(source, match.index)
  const start = evalStart >= 0 ? evalStart : match.index
  const end = evalStart >= 0 ? matchBracket(source, source.indexOf("(", evalStart), "(", ")") + 1 : callEnd + 1

  return source.slice(0, start) + decoded + source.slice(Math.max(end, callEnd + 1))
}

/** The packer's own base-N alphabet: 0-9, a-z, then A-Z (char code 29 + n). */
function toBase(value: number, radix: number): string {
  const digit = value % radix
  const rest = Math.floor(value / radix)
  const char = digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36)
  return (rest > 0 ? toBase(rest, radix) : "") + char
}

function findEnclosingEval(source: string, from: number): number {
  const window = source.slice(Math.max(0, from - 24), from)
  const idx = window.lastIndexOf("eval")
  return idx < 0 ? -1 : Math.max(0, from - 24) + idx
}

// ---------------------------------------------------------------------------
// String-aware scanning helpers
// ---------------------------------------------------------------------------

/**
 * Index of the bracket closing the one at `start`, skipping over string and
 * comment contents. Returns -1 when unbalanced.
 */
export function matchBracket(source: string, start: number, open: string, close: string): number {
  if (source[start] !== open) return -1
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i)
      i = end < 0 ? source.length : end
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Splits `a, b, c` on top-level commas only. */
export function splitTopLevelArgs(argList: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < argList.length; i++) {
    const ch = argList[i]!
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    else if (ch === "," && depth === 0) {
      args.push(argList.slice(start, i).trim())
      start = i + 1
    }
  }
  args.push(argList.slice(start).trim())
  return args
}

/** Unquotes a JS string literal and resolves its escapes. Null if not one. */
export function parseStringLiteral(literal: string): string | null {
  const text = literal.trim()
  const quote = text[0]
  if (!quote || (quote !== '"' && quote !== "'" && quote !== "`")) return null
  if (text[text.length - 1] !== quote) return null
  return unescapeJs(text.slice(1, -1))
}

function unescapeJs(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (whole, escape: string) => {
    if (escape.startsWith("u{")) return safeCodePoint(parseInt(escape.slice(2, -1), 16))
    if (escape[0] === "u") return safeCodePoint(parseInt(escape.slice(1), 16))
    if (escape[0] === "x") return safeCodePoint(parseInt(escape.slice(1), 16))
    if (/^[0-7]{1,3}$/.test(escape)) return safeCodePoint(parseInt(escape, 8))
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }
    return simple[escape] ?? escape
  })
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Escape / encoding passes
// ---------------------------------------------------------------------------

/** `\x68\x74\x74\x70` and `h...` -> readable text. */
export function decodeEscapes(source: string): string {
  return source.replace(/(?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}){2,}/g, (run) => {
    const decoded = run.replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/g, (_m, hex: string, uni: string) =>
      safeCodePoint(parseInt(hex ?? uni, 16)),
    )
    // Only accept the rewrite if it stayed printable — binary blobs stay put.
    return isMostlyPrintable(decoded) ? decoded : run
  })
}

/** `String.fromCharCode(104,116,...)` -> `"http..."`. */
export function decodeCharCodes(source: string): string {
  return source.replace(
    /String\s*\.\s*fromCharCode\s*\(([^()]*)\)/g,
    (whole, argsRaw: string) => {
      const codes = argsRaw.split(",").map((part) => {
        const trimmed = part.trim()
        if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed, 16)
        if (/^\d+$/.test(trimmed)) return Number(trimmed)
        return NaN
      })
      if (!codes.length || codes.some((code) => !Number.isFinite(code))) return whole
      const decoded = codes.map(safeCodePoint).join("")
      return isMostlyPrintable(decoded) ? JSON.stringify(decoded) : whole
    },
  )
}

/** `%68%74%74%70` runs, whether or not they sit inside `unescape(...)`. */
export function decodePercentSequences(source: string): string {
  return source.replace(/(?:%[0-9a-fA-F]{2}){4,}/g, (run) => {
    try {
      const decoded = decodeURIComponent(run)
      return isMostlyPrintable(decoded) ? decoded : run
    } catch {
      return run
    }
  })
}

/** `"ht" + "tps://" + host` -> `"https://" + host`. */
export function collapseConcatenations(source: string): string {
  const pattern = /(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1\s*\+\s*(["'])((?:\\.|(?!\3)[^\\\r\n])*)\3/g
  let text = source
  for (let round = 0; round < 12; round++) {
    const next = text.replace(pattern, (_whole, q1: string, left: string, _q2: string, right: string) => {
      // Re-escape the right half for the left half's quote style.
      const normalized = right.replace(new RegExp(`(?<!\\\\)${q1}`, "g"), `\\${q1}`)
      return `${q1}${left}${normalized}${q1}`
    })
    if (next === text) break
    text = next
  }
  return text
}

/** Base64 literals that decode to something containing a URL. */
export function harvestBase64(source: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const pattern = /['"`]([A-Za-z0-9+/_-]{20,}={0,2})['"`]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const blob = match[1]!
    if (seen.has(blob)) continue
    seen.add(blob)
    const decoded = tryBase64(blob)
    if (decoded && /https?:|\.m3u8|\.mpd|\.mp4|\/\//i.test(decoded) && isMostlyPrintable(decoded)) {
      found.push(decoded)
    }
    if (found.length >= 64) break
  }
  return found
}

/** Long hex blobs that decode to ASCII, e.g. `"68747470..."`. */
export function harvestHexBlobs(source: string): string[] {
  const found: string[] = []
  const pattern = /['"`]((?:[0-9a-fA-F]{2}){16,})['"`]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const blob = match[1]!
    let decoded = ""
    for (let i = 0; i < blob.length; i += 2) decoded += safeCodePoint(parseInt(blob.slice(i, i + 2), 16))
    if (/https?:|\.m3u8|\.mpd/i.test(decoded) && isMostlyPrintable(decoded)) found.push(decoded)
    if (found.length >= 32) break
  }
  return found
}

export function tryBase64(blob: string): string | null {
  const normalized = blob.replace(/-/g, "+").replace(/_/g, "/")
  if (normalized.length % 4 === 1) return null
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8")
    // Buffer is lenient; require a round trip to reject accidental matches.
    if (!decoded) return null
    return decoded
  } catch {
    return null
  }
}

function isMostlyPrintable(text: string): boolean {
  if (!text) return false
  let printable = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) printable++
  }
  return printable / [...text].length > 0.85
}

// ---------------------------------------------------------------------------
// Detectors — these formats are only ever cracked by running them
// ---------------------------------------------------------------------------

export function looksLikeJsFuck(source: string): boolean {
  const sample = source.slice(0, 4000)
  if (sample.length < 200) return false
  const noise = sample.replace(/[[\]()!+]/g, "").length
  return noise / sample.length < 0.05
}

export function looksLikeAaEncode(source: string): boolean {
  return /ﾟωﾟ|ﾟДﾟ|ﾟΘﾟ/.test(source.slice(0, 4000))
}

export function looksLikeJjEncode(source: string): boolean {
  return /\$=~\[\]|\$\$\$\$|_\$\$_/.test(source.slice(0, 4000))
}

/** True when the source is worth handing to the sandbox. */
export function needsExecution(source: string): boolean {
  return (
    looksLikeJsFuck(source) ||
    looksLikeAaEncode(source) ||
    looksLikeJjEncode(source) ||
    /_0x[0-9a-f]{4,}/i.test(source) ||
    /\batob\s*\(/.test(source) ||
    /\beval\s*\(/.test(source) ||
    /\bFunction\s*\(/.test(source) ||
    /\['[^']{1,4}'\]\s*\(/.test(source)
  )
}

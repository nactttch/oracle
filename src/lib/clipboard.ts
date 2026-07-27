/**
 * Clipboard access with no dependencies and no assumptions.
 *
 * OSC 52 is tried first because it is the only mechanism that works when the
 * terminal is on the other end of an SSH session — the escape sequence asks the
 * *terminal emulator* to set the clipboard, so the copy lands on the machine
 * the user is actually sitting at. Native helpers are the fallback for
 * terminals that have OSC 52 disabled.
 */

import { spawnSync } from "node:child_process"

export type CopyMethod = "osc52" | "native" | "none"

export function copyToClipboard(text: string): CopyMethod {
  if (!text) return "none"
  if (writeOsc52(text)) return "osc52"
  if (writeNative(text)) return "native"
  return "none"
}

/**
 * Not every terminal honours OSC 52 and none of them acknowledge it, so this
 * reports whether the sequence was *sent*, not whether it landed. Native
 * helpers are still attempted underneath when one exists.
 */
function writeOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false
  const payload = Buffer.from(text, "utf8").toString("base64")
  // Terminals cap OSC 52 payloads; past ~74 KB it is silently dropped.
  if (payload.length > 70_000) return false
  try {
    process.stdout.write(`]52;c;${payload}`)
    return true
  } catch {
    return false
  }
}

function writeNative(text: string): boolean {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]

  for (const [command, args] of candidates) {
    try {
      const result = spawnSync(command, args, { input: text, timeout: 2000 })
      if (result.status === 0) return true
    } catch {
      /* helper missing — try the next one */
    }
  }
  return false
}

/** Reads the clipboard, for offering a pasted URL on startup. Empty on failure. */
export function readClipboard(): string {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbpaste", []]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]]
        : [
            ["wl-paste", ["--no-newline"]],
            ["xclip", ["-selection", "clipboard", "-o"]],
            ["xsel", ["--clipboard", "--output"]],
          ]

  for (const [command, args] of candidates) {
    try {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000 })
      if (result.status === 0 && result.stdout) return result.stdout.trim()
    } catch {
      /* helper missing — try the next one */
    }
  }
  return ""
}

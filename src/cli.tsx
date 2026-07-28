/**
 * Entry point.
 *
 * Two modes share one engine: an interactive TUI, and a headless mode that
 * prints to stdout so Oracle drops into a pipeline (`oracle -f urls <page> |
 * xargs -n1 mpv`). Headless is selected automatically when stdout is not a TTY,
 * because a redirected run should produce output, not escape sequences.
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { App } from "./app.js"
import { Oracle, type DigResult } from "./core/engine.js"
import { DEFAULT_USER_AGENT, type DigOptions } from "./core/types.js"
import { looksLikeUrl, parseArgs, type ParsedArgs } from "./lib/args.js"
import { readClipboard } from "./lib/clipboard.js"
import { toJson, toM3u, toText } from "./lib/output.js"

const require = createRequire(import.meta.url)
// Read at runtime so a version bump can never drift from a hardcoded constant.
const VERSION: string = (() => {
  try {
    return require("../package.json").version
  } catch {
    return "0.0.0"
  }
})()

const HELP = `
  oracle — dig any iframe. surface the raw stream.

  Usage
    $ oracle [url] [options]

  Examples
    $ oracle                                    prompts for a url
    $ oracle https://site.tld/match/live-5      a page that embeds a player
    $ oracle https://cdn.tld/embed/max-5/       the iframe itself
    $ oracle -f urls https://site.tld/x | xargs -n1 mpv
    $ oracle -f json -o streams.json https://site.tld/x

  Options
    -p, --print              run headless and print the report
    -f, --format <fmt>       text | json | m3u | urls   (implies --print)
    -o, --output <file>      write the report to a file
    -d, --depth <n>          how many document hops to follow      (default 4)
        --server-depth <n>   values to try per server parameter    (default 8)
    -t, --timeout <ms>       per-request timeout                   (default 15000)
    -c, --concurrency <n>    parallel requests                     (default 8)
        --stop-after <n>     stop once n streams are verified
        --no-servers         skip sibling-server discovery
        --no-sandbox         skip the honeypot (static analysis only)
        --no-probe           do not verify candidates
    -r, --referer <url>      Referer for the first request
    -A, --user-agent <ua>    override the user agent
    -H, --header <h>         extra header, repeatable ("Name: value")
        --theme <mode>       auto | dark | light
    -h, --help               show this help
    -v, --version            show version

  Oracle only reads what a browser would read. Respect the terms of the sites
  you point it at, and the rights of whoever owns the stream.
`

/**
 * Oracle runs untrusted code on purpose, so a rejected promise is not a bug
 * report — it is the site misbehaving.
 *
 * Player scripts routinely do `fetch(u).then(r => r.json())` and never attach a
 * `.catch`. Inside the honeypot that rejection escapes the VM and arrives here
 * as a process-level `unhandledRejection`; left fatal, one careless third-party
 * script kills a dig that had already found the stream. Note these cannot be
 * caught by `instanceof Error` — they cross a realm boundary, so their
 * prototype is the sandbox's, not ours.
 *
 * `uncaughtException` stays fatal: that is our own code failing.
 */
/**
 * Stops rejections thrown by page code from reaching *any* listener.
 *
 * Oracle runs untrusted scripts on purpose, and plenty of them reject a
 * promise nobody catches. Adding our own quiet listener is not enough: OpenTUI
 * registers its own `unhandledRejection` handler and paints whatever it gets
 * into the console pane, so a site's broken promise showed up mid-crawl as a
 * bare `TypeError {}` — empty because the error was built inside the VM and so
 * is not an instance of this realm's Error.
 *
 * That foreignness is the test. An error from the sandbox fails
 * `instanceof Error` here; anything Oracle itself throws passes, stays
 * reported, and still crashes the process by way of `uncaughtException`.
 */
function ignoreSandboxRejections() {
  process.on("unhandledRejection", (reason: unknown) => {
    if (process.env.ORACLE_DEBUG) {
      process.stderr.write(`oracle: ignored rejection from page code — ${String(reason)}\n`)
    }
  })
}

/**
 * Puts every `unhandledRejection` listener behind a filter.
 *
 * Adding a quiet listener of our own is not enough, because listeners do not
 * suppress one another: OpenTUI registers its own and paints whatever it gets
 * into the console pane, so a site's broken promise surfaced mid-crawl as a
 * bare `TypeError {}` — empty because the error was built inside the VM and so
 * is not an instance of this realm's Error.
 *
 * That foreignness is the test, and it is a reliable one: Oracle runs
 * untrusted scripts on purpose and every rejection they produce comes from the
 * VM realm. Anything Oracle itself throws is a real Error here, still reaches
 * every listener, and is still reported.
 *
 * Call this *after* the renderer exists, since that is when OpenTUI subscribes.
 */
function filterRejectionListeners() {
  const listeners = process.listeners("unhandledRejection")
  process.removeAllListeners("unhandledRejection")
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    if (isForeignError(reason)) {
      if (process.env.ORACLE_DEBUG) {
        process.stderr.write(`oracle: ignored rejection from page code — ${String(reason)}\n`)
      }
      return
    }
    for (const listener of listeners) listener(reason, promise)
  })
}

/** True for a value thrown inside the honeypot's realm rather than this one. */
function isForeignError(reason: unknown): boolean {
  if (reason instanceof Error) return false
  if (reason === null || typeof reason !== "object") return true
  // A cross-realm Error still stringifies as one and carries a stack.
  return true
}

async function main() {
  ignoreSandboxRejections()
  const args = parseArgs(process.argv.slice(2))

  if (args.error) {
    process.stderr.write(`oracle: ${args.error}\nTry “oracle --help”.\n`)
    process.exit(1)
  }
  if (args.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`)
    process.exit(0)
  }

  const digOptions = toDigOptions(args)
  const isTty = Boolean(process.stdout.isTTY)
  const headless = args.headless || !isTty

  if (headless) {
    if (!args.url) {
      process.stderr.write("oracle: a url is required when not running interactively.\n")
      process.exit(1)
    }
    await runHeadless(args, digOptions)
    return
  }

  await runInteractive(args, digOptions)
}

// ---------------------------------------------------------------------------

async function runHeadless(args: ParsedArgs, digOptions: Partial<DigOptions>) {
  const format = args.format ?? "text"
  const quiet = format !== "text" || Boolean(args.output)

  const engine = new Oracle(digOptions, (event) => {
    // Progress goes to stderr so stdout stays a clean, pipeable document.
    if (quiet) return
    if (event.type === "phase") process.stderr.write(`· ${event.phase}${event.detail ? ` ${event.detail}` : ""}\n`)
    if (event.type === "server") process.stderr.write(`⑂ server ${event.variant.label}\n`)
    if (event.type === "layer") process.stderr.write(`⚑ ${event.technique}\n`)
  })

  let result: DigResult
  try {
    result = await engine.dig(args.url!)
  } catch (error) {
    process.stderr.write(`oracle: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
    return
  }

  const rendered = render(result, format)
  if (args.output) {
    const path = resolve(process.cwd(), args.output)
    writeFileSync(path, rendered.endsWith("\n") ? rendered : rendered + "\n", "utf8")
    process.stderr.write(`saved ${path}\n`)
  } else {
    process.stdout.write(rendered.endsWith("\n") ? rendered : rendered + "\n")
  }

  // Exit non-zero when nothing was found, so scripts can branch on it.
  process.exit(result.candidates.length ? 0 : 2)
}

function render(result: DigResult, format: string): string {
  switch (format) {
    case "json":
      return toJson(result)
    case "m3u":
      return toM3u(result)
    case "urls":
      return result.candidates
        .filter((candidate) => candidate.verified !== false)
        .map((candidate) => candidate.signedUrl ?? candidate.url)
        .join("\n")
    default:
      return toText(result)
  }
}

// ---------------------------------------------------------------------------

async function runInteractive(args: ParsedArgs, digOptions: Partial<DigOptions>) {
  // Offer the clipboard only when it holds something url-shaped.
  let clipboardUrl: string | undefined
  if (!args.url) {
    const clipped = readClipboard()
    if (clipped && looksLikeUrl(clipped)) clipboardUrl = clipped
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
  // The renderer subscribes to unhandledRejection on construction, so its
  // listener only exists to be filtered from this point on.
  filterRejectionListeners()

  let result: DigResult | undefined
  let finished = false
  const finish = (value?: DigResult) => {
    if (finished) return
    finished = true
    result = value
    try {
      renderer.destroy()
    } catch {
      /* already torn down */
    }
  }

  // A crash must not leave the terminal in the alternate screen with the
  // cursor hidden — restore first, then let the error print. Rejections are
  // deliberately absent here; see ignoreSandboxRejections.
  process.on("uncaughtException", (error: unknown) => {
    finish()
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })

  createRoot(renderer).render(
    <App
      initialUrl={args.url}
      clipboardUrl={clipboardUrl}
      initialThemeMode={args.themeMode ?? "auto"}
      digOptions={digOptions}
      onExit={finish}
    />,
  )

  await new Promise<void>((resolveExit) => {
    const check = setInterval(() => {
      if (finished) {
        clearInterval(check)
        resolveExit()
      }
    }, 60)
  })

  // A parting summary, so the useful bit survives after the UI is gone. Print
  // the playable (signed) form of every verified stream, not just the first
  // one's bare URL — this is what someone pastes into mpv.
  const playable = (result?.candidates ?? []).filter((candidate) => candidate.verified === true)
  for (const candidate of playable.slice(0, 10)) {
    process.stdout.write(`${candidate.signedUrl ?? candidate.url}\n`)
  }
  if (!playable.length && result?.candidates.length) {
    process.stdout.write(`${result.candidates[0]!.signedUrl ?? result.candidates[0]!.url}\n`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------

function toDigOptions(args: ParsedArgs): Partial<DigOptions> {
  const options: Partial<DigOptions> = {
    userAgent: args.userAgent ?? DEFAULT_USER_AGENT,
    headers: args.headers ?? {},
  }
  if (args.depth !== undefined) options.maxDepth = args.depth
  if (args.serverDepth !== undefined) options.serverDepth = args.serverDepth
  if (args.timeout !== undefined) options.timeout = args.timeout
  if (args.concurrency !== undefined) options.concurrency = Math.max(1, args.concurrency)
  if (args.stopAfter !== undefined) options.stopAfter = args.stopAfter
  if (args.referer) options.referer = args.referer
  if (args.noServers) options.digServers = false
  if (args.noSandbox) options.sandbox = false
  if (args.noProbe) options.probe = false
  return options
}

await main()

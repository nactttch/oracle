/**
 * The Oracle TUI.
 *
 * Four screens — ask, dig, results, detail — sharing one column layout so the
 * wordmark never moves between them. The dig screen deliberately narrates what
 * the engine is doing: watching it peel a packer and then crack a base64 blob
 * is how you learn to trust the answer at the end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { Logo } from "./components/logo.js"
import { Badge, Gap, Meter, Panel, Shortcuts, Spinner } from "./components/chrome.js"
import { Oracle, type DigResult } from "./core/engine.js"
import type { Candidate, DigEvent, DigOptions } from "./core/types.js"
import { DEFAULT_USER_AGENT } from "./core/types.js"
import { platformAdvice } from "./core/platforms.js"
import { copyToClipboard } from "./lib/clipboard.js"
import {
  describeCandidate,
  describeTechniques,
  formatBytes,
  formatElapsed,
  hostOf,
  shortenUrl,
  statusGlyph,
  truncate,
} from "./lib/format.js"
import { toCommands, toJson, toM3u, suggestFilename } from "./lib/output.js"
import { nextThemeMode, themeFor, type ThemeMode } from "./theme.js"

const TAGLINE = "dig any iframe. surface the raw stream."
const MAX_LOG_LINES = 9
const FLUSH_MS = 90

type Screen =
  | { name: "ask"; warning?: string }
  | { name: "dig" }
  | { name: "results" }
  | { name: "detail" }
  | { name: "error"; message: string }

interface Progress {
  phase: string
  detail: string
  documents: number
  requests: number
  servers: number
  candidates: number
  bytes: number
  layers: string[]
  log: string[]
}

const EMPTY_PROGRESS: Progress = {
  phase: "idle",
  detail: "",
  documents: 0,
  requests: 0,
  servers: 0,
  candidates: 0,
  bytes: 0,
  layers: [],
  log: [],
}

export interface AppProps {
  initialUrl?: string
  clipboardUrl?: string
  initialThemeMode: ThemeMode
  digOptions: Partial<DigOptions>
  onExit: (result?: DigResult) => void
}

export function App({ initialUrl, clipboardUrl, initialThemeMode, digOptions, onExit }: AppProps) {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode)
  const theme = useMemo(() => themeFor(themeMode), [themeMode])

  const [screen, setScreen] = useState<Screen>(initialUrl ? { name: "dig" } : { name: "ask" })
  const [url, setUrl] = useState(initialUrl ?? "")
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS)
  const [result, setResult] = useState<DigResult | undefined>()
  const [selected, setSelected] = useState(0)
  const [flash, setFlash] = useState("")
  const [startedAt, setStartedAt] = useState(0)

  const engineRef = useRef<Oracle | undefined>(undefined)
  const pendingRef = useRef<Progress>(EMPTY_PROGRESS)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const panelWidth = Math.max(44, Math.min(width - 4, 92))
  const contentWidth = panelWidth - 4

  const notify = useCallback((message: string) => {
    setFlash(message)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(""), 2400)
  }, [])

  // --- the dig ------------------------------------------------------------

  const startDig = useCallback(
    (target: string) => {
      const trimmed = target.trim()
      if (!trimmed) {
        setScreen({ name: "ask", warning: "paste a page or iframe url first" })
        return
      }

      pendingRef.current = { ...EMPTY_PROGRESS, phase: "starting" }
      setProgress(pendingRef.current)
      setResult(undefined)
      setSelected(0)
      setStartedAt(Date.now())
      setScreen({ name: "dig" })

      // Events land in a ref and are flushed on a timer: a busy dig emits
      // thousands, and re-rendering per event would out-run the terminal.
      const engine = new Oracle(digOptions, (event) => {
        pendingRef.current = reduce(pendingRef.current, event)
      })
      engineRef.current = engine

      engine
        .dig(trimmed)
        .then((digResult) => {
          setProgress(pendingRef.current)
          setResult(digResult)
          setSelected(0)
          setScreen(
            digResult.candidates.length
              ? { name: "results" }
              : {
                  name: "error",
                  message: digResult.platforms.length ? platformAdvice(digResult.platforms) : "no raw streams found",
                },
          )
        })
        .catch((error: unknown) => {
          setScreen({ name: "error", message: error instanceof Error ? error.message : String(error) })
        })
    },
    [digOptions],
  )

  useEffect(() => {
    if (initialUrl) startDig(initialUrl)
    // Intentionally once: a url passed on the command line starts one dig.
  }, [])

  useEffect(() => {
    if (screen.name !== "dig") return
    const timer = setInterval(() => setProgress({ ...pendingRef.current }), FLUSH_MS)
    return () => clearInterval(timer)
  }, [screen.name])

  // --- actions ------------------------------------------------------------

  const candidates = result?.candidates ?? []
  const current = candidates[selected]

  const copyUrl = useCallback(() => {
    if (!current) return
    const method = copyToClipboard(current.url)
    notify(method === "none" ? "could not reach a clipboard" : "url copied")
  }, [current, notify])

  const copyCommand = useCallback(() => {
    if (!current) return
    const [first] = toCommands(current, digOptions.userAgent ?? DEFAULT_USER_AGENT)
    if (!first) return
    const method = copyToClipboard(first.command)
    notify(method === "none" ? "could not reach a clipboard" : `${first.tool} command copied`)
  }, [current, digOptions.userAgent, notify])

  const save = useCallback(
    (kind: "json" | "m3u") => {
      if (!result) return
      const name = kind === "json" ? "oracle-streams.json" : "oracle-streams.m3u"
      const path = resolve(process.cwd(), name)
      try {
        writeFileSync(path, kind === "json" ? toJson(result) : toM3u(result), "utf8")
        notify(`saved ${name}`)
      } catch (error) {
        notify(`save failed: ${error instanceof Error ? error.message : "unknown"}`)
      }
    },
    [result, notify],
  )

  // --- keys ---------------------------------------------------------------

  useKeyboard((key) => {
    const name = key.name ?? ""

    if (name === "c" && key.ctrl) {
      engineRef.current?.abort()
      renderer.destroy()
      onExit(result)
      return
    }

    if (screen.name === "ask") {
      // Everything else belongs to the focused input.
      if (name === "tab" && clipboardUrl) {
        setUrl(clipboardUrl)
        return
      }
      if (name === "t" && key.ctrl) setThemeMode(nextThemeMode(themeMode))
      return
    }

    if (name === "t" && key.ctrl) {
      setThemeMode(nextThemeMode(themeMode))
      return
    }

    if (screen.name === "dig") {
      if (name === "escape") {
        engineRef.current?.abort()
        notify("stopping…")
      }
      return
    }

    if (screen.name === "error") {
      if (name === "return" || name === "enter") setScreen({ name: "ask" })
      if (name === "escape") setScreen({ name: "ask" })
      return
    }

    if (screen.name === "detail") {
      if (name === "escape" || name === "d") setScreen({ name: "results" })
      if (name === "return" || name === "enter") copyUrl()
      if (name === "c") copyCommand()
      return
    }

    // results
    if (name === "up" || name === "k") setSelected((index) => Math.max(0, index - 1))
    else if (name === "down" || name === "j") setSelected((index) => Math.min(candidates.length - 1, index + 1))
    else if (name === "return" || name === "enter") copyUrl()
    else if (name === "c") copyCommand()
    else if (name === "d") setScreen({ name: "detail" })
    else if (name === "s") save("json")
    else if (name === "m") save("m3u")
    else if (name === "r") startDig(url)
    else if (name === "escape") setScreen({ name: "ask" })
  })

  // --- render -------------------------------------------------------------

  const hints = useMemo((): Array<[string, string]> => {
    switch (screen.name) {
      case "ask":
        return clipboardUrl
          ? [["↵", "dig"], ["⇥", "paste"], ["^t", "theme"], ["^c", "quit"]]
          : [["↵", "dig"], ["^t", "theme"], ["^c", "quit"]]
      case "dig":
        return [["esc", "stop"], ["^c", "quit"]]
      case "results":
        return [
          ["↑↓", "select"],
          ["↵", "copy"],
          ["c", "command"],
          ["d", "detail"],
          ["s", "json"],
          ["m", "m3u"],
          ["r", "again"],
        ]
      case "detail":
        return [["esc", "back"], ["↵", "copy url"], ["c", "copy cmd"], ["^c", "quit"]]
      default:
        return [["↵", "try again"], ["^c", "quit"]]
    }
  }, [screen.name, clipboardUrl])

  return (
    <box
      style={{
        flexDirection: "column",
        padding: 1,
        width: "100%",
        height: "100%",
        backgroundColor: theme.bg,
      }}
    >
      <Logo theme={theme} animated={Boolean(process.stdout.isTTY)} />
      <text>
        <span fg={theme.dim}>{TAGLINE}</span>
      </text>
      <Gap />

      {screen.name === "ask" ? (
        <AskScreen
          theme={theme}
          width={panelWidth}
          url={url}
          onChange={setUrl}
          onSubmit={startDig}
          warning={screen.warning}
          clipboardUrl={clipboardUrl}
        />
      ) : null}

      {screen.name === "dig" ? (
        <DigScreen theme={theme} width={panelWidth} progress={progress} target={url} startedAt={startedAt} />
      ) : null}

      {screen.name === "results" && result ? (
        <ResultsScreen
          theme={theme}
          width={panelWidth}
          contentWidth={contentWidth}
          result={result}
          selected={selected}
        />
      ) : null}

      {screen.name === "detail" && current ? (
        <DetailScreen
          theme={theme}
          width={panelWidth}
          contentWidth={contentWidth}
          candidate={current}
          userAgent={digOptions.userAgent ?? DEFAULT_USER_AGENT}
        />
      ) : null}

      {screen.name === "error" ? (
        <Panel title={result?.platforms.length ? "platform embed" : "nothing found"} theme={theme} width={panelWidth}>
          {wrapWords(screen.message, contentWidth).map((line, index) => (
            <text key={index}>
              <span fg={result?.platforms.length ? theme.warn : theme.bad}>{line}</span>
            </text>
          ))}
          {result?.platforms.map((embed) => (
            <text key={embed.url}>
              <span fg={theme.accent}>{`${embed.platform}  `}</span>
              <span fg={theme.fg}>{truncate(embed.watchUrl ?? embed.url, contentWidth - embed.platform.length - 2)}</span>
            </text>
          ))}
          {!result?.platforms.length ? (
            <text>
              <span fg={theme.dim}>
                {truncate("try a deeper dig: oracle --depth 6 --server-depth 12 <url>", contentWidth)}
              </span>
            </text>
          ) : null}
        </Panel>
      ) : null}

      <Gap />
      <box style={{ flexDirection: "row" }}>
        <Shortcuts items={hints} theme={theme} />
      </box>
      {flash ? (
        <text>
          <span fg={theme.accent}>{`✦ ${flash}`}</span>
        </text>
      ) : null}
    </box>
  )
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function AskScreen({
  theme,
  width,
  url,
  onChange,
  onSubmit,
  warning,
  clipboardUrl,
}: {
  theme: Theme_
  width: number
  url: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  warning?: string
  clipboardUrl?: string
}) {
  // `onSubmit` is typed as an intersection of two handler shapes (it is called
  // with the value in some paths and an event in others), so accept `unknown`
  // and fall back to the value we are already holding in state.
  const submit = (value: unknown) => onSubmit(typeof value === "string" ? value : url)

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Panel title="page or iframe url" theme={theme} width={width} accent>
        <input
          value={url}
          placeholder="https://example.com/embed/player/"
          focused
          onInput={onChange}
          onSubmit={submit}
          textColor={theme.fg}
          cursorColor={theme.accent}
          backgroundColor={theme.bg}
          focusedBackgroundColor={theme.bg}
        />
      </Panel>
      {warning ? (
        <text>
          <span fg={theme.warn}>{warning}</span>
        </text>
      ) : null}
      {clipboardUrl && !url ? (
        <text>
          <span fg={theme.dim}>{`⇥ paste  ${truncate(clipboardUrl, Math.max(10, width - 12))}`}</span>
        </text>
      ) : null}
    </box>
  )
}

function DigScreen({
  theme,
  width,
  progress,
  target,
  startedAt,
}: {
  theme: Theme_
  width: number
  progress: Progress
  target: string
  startedAt: number
}) {
  const [, force] = useState(0)
  // The elapsed clock needs its own tick; progress only updates on engine events.
  useEffect(() => {
    const timer = setInterval(() => force((value) => value + 1), 250)
    return () => clearInterval(timer)
  }, [])

  const inner = width - 4
  const elapsed = startedAt ? formatElapsed(Date.now() - startedAt) : "0ms"

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Panel title="digging" theme={theme} width={width} accent>
        <text>
          <Spinner theme={theme} />
          <span fg={theme.fg}>{` ${progress.phase}`}</span>
          <span fg={theme.dim}>{progress.detail ? ` · ${progress.detail}` : ""}</span>
          <span fg={theme.dim}>{`  ${elapsed}`}</span>
        </text>
        <text>
          <span fg={theme.dim}>{"docs "}</span>
          <span fg={theme.fg}>{String(progress.documents)}</span>
          <span fg={theme.dim}>{"  requests "}</span>
          <span fg={theme.fg}>{String(progress.requests)}</span>
          <span fg={theme.dim}>{"  read "}</span>
          <span fg={theme.fg}>{formatBytes(progress.bytes)}</span>
          <span fg={theme.dim}>{"  servers "}</span>
          <span fg={theme.accent}>{String(progress.servers)}</span>
          <span fg={theme.dim}>{"  streams "}</span>
          <span fg={theme.ok}>{String(progress.candidates)}</span>
        </text>
        {progress.layers.length ? (
          <text>
            <span fg={theme.dim}>{"cracked "}</span>
            <span fg={theme.accent}>{truncate(progress.layers.join(" · "), inner - 8)}</span>
          </text>
        ) : null}
      </Panel>

      <Panel title={truncate(hostOf(target) || "activity", 30)} theme={theme} width={width}>
        {progress.log.length ? (
          progress.log.map((line, index) => (
            <text key={index}>
              <span fg={index === progress.log.length - 1 ? theme.fg : theme.dim}>{truncate(line, inner)}</span>
            </text>
          ))
        ) : (
          <text>
            <span fg={theme.dim}>waiting for the first response…</span>
          </text>
        )}
      </Panel>
    </box>
  )
}

function ResultsScreen({
  theme,
  width,
  contentWidth,
  result,
  selected,
}: {
  theme: Theme_
  width: number
  contentWidth: number
  result: DigResult
  selected: number
}) {
  const candidates = result.candidates
  const verified = candidates.filter((candidate) => candidate.verified === true).length

  // Keep the cursor in view without redrawing the whole list every frame.
  const visible = 8
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), candidates.length - visible))
  const window = candidates.slice(Math.max(0, start), Math.max(0, start) + visible)
  const offset = Math.max(0, start)

  const current = candidates[selected]

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Panel
        title={`${candidates.length} stream${candidates.length === 1 ? "" : "s"} · ${verified} verified`}
        theme={theme}
        width={width}
        accent
      >
        {window.map((candidate, index) => {
          const absolute = offset + index
          const isSelected = absolute === selected
          const status = statusGlyph(candidate)
          const tone = status.tone === "ok" ? theme.ok : status.tone === "bad" ? theme.bad : theme.warn
          const label = candidate.server ? `${candidate.server}` : ""
          const room = contentWidth - 6 - (label ? label.length + 3 : 0) - 10
          return (
            <text key={candidate.url}>
              <span fg={isSelected ? theme.accent : theme.dim}>{isSelected ? "❯ " : "  "}</span>
              <span fg={tone}>{`${status.glyph} `}</span>
              <span fg={isSelected ? theme.fg : theme.dim}>{shortenUrl(candidate.url, Math.max(16, room))}</span>
              {label ? <span fg={theme.accent}>{`  [${label}]`}</span> : null}
            </text>
          )
        })}
        {candidates.length > visible ? (
          <text>
            <span fg={theme.dim}>{`  … ${selected + 1}/${candidates.length}`}</span>
          </text>
        ) : null}
      </Panel>

      {current ? (
        <Panel title="selected" theme={theme} width={width}>
          <text>
            <span fg={theme.dim}>{"what  "}</span>
            <span fg={theme.fg}>{truncate(describeCandidate(current), contentWidth - 6)}</span>
          </text>
          <text>
            <span fg={theme.dim}>{"via   "}</span>
            <span fg={theme.fg}>{truncate(describeTechniques(current), contentWidth - 6)}</span>
          </text>
          <text>
            <span fg={theme.dim}>{"state "}</span>
            <span fg={current.verified ? theme.ok : theme.warn}>
              {truncate(current.note ?? (current.verified ? "reachable" : "unverified"), contentWidth - 20)}
            </span>
            <span fg={theme.dim}>{"  "}</span>
            <Meter value={current.confidence} width={10} theme={theme} />
          </text>
        </Panel>
      ) : null}

      {result.servers.length ? (
        <Panel title={`${result.servers.length} sibling server${result.servers.length === 1 ? "" : "s"}`} theme={theme} width={width}>
          <text>
            <span fg={theme.dim}>
              {truncate(result.servers.map((server) => server.label).join("  ·  "), contentWidth)}
            </span>
          </text>
        </Panel>
      ) : null}
    </box>
  )
}

function DetailScreen({
  theme,
  width,
  contentWidth,
  candidate,
  userAgent,
}: {
  theme: Theme_
  width: number
  contentWidth: number
  candidate: Candidate
  userAgent: string
}) {
  const commands = toCommands(candidate, userAgent)
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Panel title="stream" theme={theme} width={width} accent>
        {wrap(candidate.url, contentWidth).map((line, index) => (
          <text key={index}>
            <span fg={theme.fg}>{line}</span>
          </text>
        ))}
      </Panel>

      <Panel title="facts" theme={theme} width={width}>
        <Fact theme={theme} label="type" value={describeCandidate(candidate)} width={contentWidth} />
        <Fact theme={theme} label="found" value={describeTechniques(candidate)} width={contentWidth} />
        <Fact theme={theme} label="in" value={candidate.origin} width={contentWidth} />
        {candidate.server ? <Fact theme={theme} label="server" value={candidate.server} width={contentWidth} /> : null}
        {candidate.headers.referer ? (
          <Fact theme={theme} label="referer" value={candidate.headers.referer} width={contentWidth} />
        ) : null}
        {candidate.keyUri ? (
          <Fact theme={theme} label="aes key" value={candidate.keyUri} width={contentWidth} />
        ) : null}
        {candidate.status ? (
          <Fact theme={theme} label="http" value={`${candidate.status} · ${candidate.contentType ?? "?"}`} width={contentWidth} />
        ) : null}
      </Panel>

      {candidate.variants?.length ? (
        <Panel title="renditions" theme={theme} width={width}>
          {candidate.variants.slice(0, 5).map((variant) => (
            <text key={variant.url}>
              <span fg={theme.fg}>{(variant.resolution ?? "?").padEnd(11)}</span>
              <span fg={theme.dim}>
                {truncate(
                  `${variant.bandwidth ? (variant.bandwidth / 1_000_000).toFixed(1) + " Mbps  " : ""}${shortenUrl(variant.url, Math.max(16, contentWidth - 24))}`,
                  contentWidth - 11,
                )}
              </span>
            </text>
          ))}
        </Panel>
      ) : null}

      <Panel title="play it" theme={theme} width={width}>
        {commands.slice(0, 2).map((entry) => (
          <text key={entry.tool}>
            <span fg={theme.accent}>{entry.tool.padEnd(7)}</span>
            <span fg={theme.dim}>{truncate(entry.command, contentWidth - 7)}</span>
          </text>
        ))}
      </Panel>
    </box>
  )
}

function Fact({ theme, label, value, width }: { theme: Theme_; label: string; value: string; width: number }) {
  return (
    <text>
      <span fg={theme.dim}>{label.padEnd(8)}</span>
      <span fg={theme.fg}>{truncate(value, Math.max(8, width - 8))}</span>
    </text>
  )
}

// ---------------------------------------------------------------------------
// Event reduction
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  crawl: "crawling",
  servers: "hunting sibling servers",
  "crawl-servers": "digging each server",
  verify: "verifying streams",
}

function reduce(state: Progress, event: DigEvent): Progress {
  switch (event.type) {
    case "phase":
      return {
        ...state,
        phase: PHASE_LABELS[event.phase] ?? event.phase,
        detail: event.detail ?? "",
        log: push(state.log, `— ${PHASE_LABELS[event.phase] ?? event.phase}`),
      }
    case "fetch":
      return { ...state, requests: state.requests + 1, log: push(state.log, `→ ${short(event.url)}`) }
    case "fetched":
      return {
        ...state,
        documents: state.documents + 1,
        bytes: state.bytes + event.bytes,
        log: push(state.log, `  ${event.status} · ${formatBytes(event.bytes)} · ${event.ms}ms`),
      }
    case "fetch-failed":
      return { ...state, log: push(state.log, `✗ ${short(event.url)} — ${event.error.slice(0, 30)}`) }
    case "layer":
      return {
        ...state,
        layers: state.layers.includes(event.technique) ? state.layers : [...state.layers, event.technique],
        log: push(state.log, `⚑ ${event.technique}${event.detail ? ` · ${event.detail}` : ""}`),
      }
    case "server":
      return {
        ...state,
        servers: state.servers + 1,
        log: push(state.log, `⑂ server ${event.variant.label} (${event.variant.how})`),
      }
    case "candidate":
      return {
        ...state,
        candidates: state.candidates + 1,
        log: push(state.log, `★ ${short(event.candidate.url)}`),
      }
    case "probed":
      return {
        ...state,
        log: push(
          state.log,
          `${event.candidate.verified ? "✓" : "✗"} ${short(event.candidate.url)} — ${event.candidate.note ?? ""}`,
        ),
      }
    case "stat":
      return { ...state, candidates: Math.max(state.candidates, event.candidates) }
    default:
      return state
  }
}

function push(log: string[], line: string): string[] {
  const next = [...log, line]
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
}

function short(url: string): string {
  return shortenUrl(url, 58)
}

/** Word-aware wrapping, for prose rather than URLs. */
function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    if (!line.length) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 5)
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width))
  return lines.slice(0, 4)
}

// Local alias so the screens don't each import the theme type.
type Theme_ = ReturnType<typeof themeFor>

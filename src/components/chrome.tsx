/** Small shared pieces: panels, the shortcut bar, spinners, meters, badges. */

import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import type { Theme } from "../theme.js"

/** A rounded panel with its title sitting on the top border. */
export function Panel({
  title,
  theme,
  width,
  children,
  accent = false,
}: {
  title: string
  theme: Theme
  width?: number
  accent?: boolean
  children: ReactNode
}) {
  return (
    <box
      title={` ${title} `}
      titleColor={accent ? theme.accent : theme.dim}
      borderStyle="rounded"
      borderColor={accent ? theme.accent : theme.border}
      backgroundColor={theme.bg}
      style={{ width, flexDirection: "column", paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}
    >
      {children}
    </box>
  )
}

/** `↵ dig  ·  ^c quit` — keys in foreground, labels dimmed. */
export function Shortcuts({ items, theme }: { items: Array<[key: string, label: string]>; theme: Theme }) {
  return (
    <text>
      {items.map(([key, label], index) => (
        <span key={`${key}-${label}`}>
          {index > 0 ? <span fg={theme.dim}>{"  ·  "}</span> : null}
          <span fg={theme.fg}>{key}</span>
          <span fg={theme.dim}>{` ${label}`}</span>
        </span>
      ))}
    </text>
  )
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner({ theme, active = true }: { theme: Theme; active?: boolean }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [active])
  return <span fg={theme.accent}>{active ? SPINNER_FRAMES[frame] : "·"}</span>
}

/**
 * Blank lines that yoga can't collapse when content overflows.
 *
 * The height is stated rather than measured. A box whose only content is a
 * space still gets measured short often enough that the neighbouring element
 * draws straight over it — the same way the tagline once ran through the
 * bottom row of the wordmark.
 */
export function Gap({ lines = 1 }: { lines?: number }) {
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, height: lines }}>
      {Array.from({ length: lines }, (_, index) => (
        <text key={index}> </text>
      ))}
    </box>
  )
}

/** A confidence meter drawn in eighth-blocks. */
export function Meter({ value, width, theme }: { value: number; width: number; theme: Theme }) {
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)))
  const tone = value >= 75 ? theme.ok : value >= 45 ? theme.warn : theme.bad
  return (
    <span>
      <span fg={tone}>{"█".repeat(filled)}</span>
      <span fg={theme.border}>{"░".repeat(Math.max(0, width - filled))}</span>
    </span>
  )
}

/** A small inline tag, e.g. the server label on a result row. */
export function Badge({ text, theme, tone }: { text: string; theme: Theme; tone?: string }) {
  return <span fg={tone ?? theme.accent}>{`[${text}]`}</span>
}

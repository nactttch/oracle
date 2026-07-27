/**
 * The wordmark.
 *
 * Two animations, both cheap: an intro where each glyph resolves out of noise,
 * and a slanted beam that periodically sweeps across and thins the blocks by
 * one density step. Full-cell blocks can swap to a lighter shade character;
 * half-blocks can't, because a `▀` replaced by a `▒` spills outside the
 * letterform, so those dim instead.
 */

import { useEffect, useMemo, useState } from "react"
import type { Theme } from "../theme.js"

const ART = [
  "█▀█ █▀▄ █▀█ █▀▀ █   █▀▀",
  "█ █ █▀▄ █▀█ █   █   █▀▀",
  "▀▀▀ ▀ ▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀",
]

const GRID = ART.map((row) => [...row])
const ROWS = GRID.length
const COLS = GRID[0]!.length

const INTRO_MS = 780
const INTRO_SPREAD_MS = 420
const SWEEP_MS = 900
const SWEEP_EVERY_MS = 6500
const FRAME_MS = 40

/** Columns of lean per row, so the beam travels as `/` rather than `|`. */
const TILT = 2
const HALF_WIDTH = 2.6

const LIGHTER: Record<string, string> = { "█": "▒", "▓": "░" }
const HALF_BLOCKS = new Set(["▀", "▄"])

type Phase = "intro" | "idle" | "sweep"

interface Cell {
  char: string
  color?: string
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

function cellAt(char: string, row: number, col: number, phase: Phase, elapsed: number, delay: number, theme: Theme): Cell {
  if (char === " " || phase === "idle") return { char, color: theme.fg }

  if (phase === "intro") {
    const local = elapsed - delay
    if (local < 0) return { char: " ", color: theme.fg }
    if (local < 100) return { char: HALF_BLOCKS.has(char) ? char : "░", color: theme.dim }
    if (local < 200) return { char: HALF_BLOCKS.has(char) ? char : "▒", color: theme.accent }
    return { char, color: theme.fg }
  }

  const from = -TILT * ROWS - HALF_WIDTH
  const to = COLS + HALF_WIDTH
  const beam = from + easeOutCubic(elapsed / SWEEP_MS) * (to - from)
  const distance = Math.abs(col - (ROWS - 1 - row) * TILT - beam)

  if (distance <= HALF_WIDTH && 1 - distance / HALF_WIDTH > 0.35) {
    if (HALF_BLOCKS.has(char)) return { char, color: theme.accent }
    return { char: LIGHTER[char] ?? char, color: theme.accent }
  }
  return { char, color: theme.fg }
}

export function Logo({ theme, animated = true }: { theme: Theme; animated?: boolean }) {
  // One random offset per glyph, fixed for the life of the component so the
  // intro looks like the same wordmark resolving rather than a new scramble.
  const delays = useMemo(() => GRID.map((row) => row.map(() => Math.random() * INTRO_SPREAD_MS)), [])
  const [phase, setPhase] = useState<Phase>(animated ? "intro" : "idle")
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!animated) return

    if (phase === "idle") {
      const timer = setTimeout(() => {
        setElapsed(0)
        setPhase("sweep")
      }, SWEEP_EVERY_MS)
      return () => clearTimeout(timer)
    }

    const duration = phase === "intro" ? INTRO_MS : SWEEP_MS
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const delta = Date.now() - startedAt
      if (delta >= duration) {
        setElapsed(0)
        setPhase("idle")
      } else {
        setElapsed(delta)
      }
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [phase, animated])

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {GRID.map((row, rowIndex) => (
        <text key={rowIndex}>
          {/* Runs of same-coloured cells are merged so a row is a handful of
              spans rather than one per column. */}
          {segments(row, rowIndex, phase, elapsed, delays[rowIndex]!, theme).map((segment, index) => (
            <span key={index} fg={segment.color}>
              {segment.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}

function segments(
  row: string[],
  rowIndex: number,
  phase: Phase,
  elapsed: number,
  delays: number[],
  theme: Theme,
): Array<{ text: string; color?: string }> {
  const out: Array<{ text: string; color?: string }> = []
  row.forEach((char, col) => {
    const cell = cellAt(char, rowIndex, col, phase, elapsed, delays[col]!, theme)
    const last = out[out.length - 1]
    if (last && (last.color === cell.color || cell.char === " ")) last.text += cell.char
    else out.push({ text: cell.char, color: cell.color })
  })
  return out
}

export const LOGO_WIDTH = COLS

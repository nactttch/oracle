/**
 * Colour scheme.
 *
 * `auto` leaves foreground and background unset so the terminal's own palette
 * shows through — far more reliable than guessing whether a terminal is light
 * or dark, and it means Oracle looks native in someone else's colour scheme.
 * The accent is the one colour that is always spent, because a dig needs a
 * single thing the eye can lock onto.
 */

export const THEME_MODES = ["auto", "dark", "light"] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export interface Theme {
  mode: ThemeMode
  /** Primary text. `undefined` means "whatever the terminal uses". */
  fg?: string
  /** Secondary text: labels, hints, chrome. */
  dim: string
  /** Oracle's one accent. */
  accent: string
  border: string
  bg?: string
  ok: string
  warn: string
  bad: string
}

const THEMES: Record<ThemeMode, Theme> = {
  auto: {
    mode: "auto",
    fg: undefined,
    dim: "#8a8a8a",
    accent: "#a78bfa",
    border: "#5c5c5c",
    bg: undefined,
    ok: "#4ade80",
    warn: "#fbbf24",
    bad: "#f87171",
  },
  dark: {
    mode: "dark",
    fg: "#f4f4f5",
    dim: "#8b8b93",
    accent: "#a78bfa",
    border: "#3f3f46",
    bg: "#0b0b0f",
    ok: "#4ade80",
    warn: "#fbbf24",
    bad: "#f87171",
  },
  light: {
    mode: "light",
    fg: "#18181b",
    dim: "#6b7280",
    accent: "#6d28d9",
    border: "#c4c4cc",
    bg: "#ffffff",
    ok: "#15803d",
    warn: "#a16207",
    bad: "#b91c1c",
  },
}

export function themeFor(mode: ThemeMode): Theme {
  return THEMES[mode]
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value)
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]!
}

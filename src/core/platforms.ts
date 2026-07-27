/**
 * Third-party platform embeds.
 *
 * Plenty of players are just a shell around a YouTube or Dailymotion iframe.
 * There is no manifest to dig for on those pages — the video lives behind a
 * platform whose extraction is a completely different problem (signature
 * ciphers, rolling player JS, an arms race Oracle is not in).
 *
 * Recognising them turns a confusing empty result into an answer: *this page
 * has no raw stream, it delegates to YouTube, here is the watch URL*. Saying so
 * is more useful than silently finding nothing, and it stops the crawler
 * wasting its budget on a single-page app that will never yield a URL.
 */

export interface PlatformEmbed {
  platform: string
  /** The embed URL as found on the page. */
  url: string
  /** Video id, when the URL shape makes it obvious. */
  id?: string
  /** A URL a human (or yt-dlp) can use directly. */
  watchUrl?: string
}

interface Matcher {
  platform: string
  host: RegExp
  id?: RegExp
  watch?: (id: string) => string
}

const MATCHERS: Matcher[] = [
  {
    platform: "YouTube",
    host: /(?:^|\.)(?:youtube(?:-nocookie)?\.com|youtu\.be)$/i,
    id: /(?:\/embed\/|\/v\/|\/live\/|[?&]v=|youtu\.be\/)([\w-]{11})/,
    watch: (id) => `https://www.youtube.com/watch?v=${id}`,
  },
  {
    platform: "Dailymotion",
    host: /(?:^|\.)(?:dailymotion\.com|dai\.ly)$/i,
    id: /(?:\/embed\/video\/|\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/,
    watch: (id) => `https://www.dailymotion.com/video/${id}`,
  },
  {
    platform: "Vimeo",
    host: /(?:^|\.)(?:vimeo\.com|player\.vimeo\.com)$/i,
    id: /\/video\/(\d+)/,
    watch: (id) => `https://vimeo.com/${id}`,
  },
  {
    platform: "Twitch",
    host: /(?:^|\.)(?:twitch\.tv|player\.twitch\.tv)$/i,
    id: /[?&]channel=([\w-]+)/,
    watch: (id) => `https://www.twitch.tv/${id}`,
  },
  {
    platform: "Facebook",
    host: /(?:^|\.)(?:facebook\.com|fb\.watch)$/i,
  },
  {
    platform: "Rumble",
    host: /(?:^|\.)rumble\.com$/i,
  },
  {
    platform: "Odysee",
    host: /(?:^|\.)odysee\.com$/i,
  },
  {
    platform: "VK",
    host: /(?:^|\.)(?:vk\.com|vkvideo\.ru)$/i,
  },
  {
    platform: "Bitchute",
    host: /(?:^|\.)bitchute\.com$/i,
  },
]

/** Identifies a platform embed, or null for an ordinary URL worth digging. */
export function detectPlatform(url: string): PlatformEmbed | null {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }

  for (const matcher of MATCHERS) {
    if (!matcher.host.test(host)) continue
    const id = matcher.id?.exec(url)?.[1]
    return {
      platform: matcher.platform,
      url,
      id,
      watchUrl: id && matcher.watch ? matcher.watch(id) : undefined,
    }
  }
  return null
}

/** What to tell the user when a dig ends in a platform embed. */
export function platformAdvice(embeds: PlatformEmbed[]): string {
  if (!embeds.length) return ""
  const names = [...new Set(embeds.map((embed) => embed.platform))]
  const list = names.length === 1 ? names[0]! : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]!
  return (
    `this page has no raw manifest — it embeds ${list}. ` +
    `platform video is a different extraction problem; yt-dlp handles those.`
  )
}

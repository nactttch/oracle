/**
 * Token signing — the last gate between a found URL and a playable one.
 *
 * A large share of "I found the m3u8 but it 403s" is not geo-blocking and not a
 * missing Referer. The CDN wants a short-lived signature, and the player gets
 * one by asking a token service that hands them to anybody: no login, no
 * credential, no DRM. The player does it in the open on every page load, and a
 * dig that stops at the 403 has stopped one request too early.
 *
 * So when a manifest comes back 401/403, Oracle looks for a token endpoint
 * among the URLs it already saw, asks it to sign the manifest, and retries.
 * Everything here is shape-driven — parameter names and response formats are
 * tried in turn — so it is not tied to any one provider.
 *
 * This deliberately does *not* touch encryption. An AES-128 or Widevine stream
 * is reported as encrypted and left alone; signing a request is authorisation
 * plumbing, not decryption.
 */

import type { HttpClient } from "./http.js"

export interface SignedResult {
  /** The manifest URL with the signature applied. */
  url: string
  /** Which endpoint produced it. */
  endpoint: string
}

/** Hosts/paths that look like a signing service. */
const TOKEN_HINT = /(?:^|[/._-])(?:token|auth|sign|signer|signature|ticket|entitle|entitlement|licence|license|access)(?:[/._-]|$)/i

/** Config keys that name one outright. */
const TOKEN_KEY = /\b(?:TOKEN_SERVER_URL|tokenServer|tokenUrl|token_url|authUrl|auth_url|signUrl|sign_url|ticketUrl)\b\s*[:=]\s*["'`]([^"'`\s]+)["'`]/gi

/** Query parameters a signing service might expect the media URL under. */
const URL_PARAMS = ["url", "stream", "resource", "path", "file", "uri", "src", "target"]

/**
 * Token endpoints among URLs already seen, plus any named outright in config.
 * Ranked so an explicit config value beats a name that merely looks right.
 */
export function findTokenEndpoints(urls: string[], text = "", limit = 4): string[] {
  const ranked = new Map<string, number>()

  for (const match of text.matchAll(TOKEN_KEY)) {
    const value = match[1]
    if (value && /^https?:\/\//i.test(value)) ranked.set(value, 100)
  }

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue
    if (!TOKEN_HINT.test(url)) continue
    // A manifest is never the signer.
    if (/\.(?:m3u8|mpd|mp4|ts|js|css|png|jpe?g|svg)(?:\?|$)/i.test(url)) continue
    ranked.set(url, Math.max(ranked.get(url) ?? 0, 10))
  }

  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url)
}

/**
 * Asks each endpoint to sign `mediaUrl`, returning the first URL that works.
 *
 * `verify` is injected rather than done here so the caller decides what
 * "works" means — for a manifest that is `#EXTM3U` coming back, which the
 * prober already knows how to check.
 */
export async function signUrl(
  http: HttpClient,
  mediaUrl: string,
  endpoints: string[],
  options: {
    referer?: string
    timeout: number
    verify: (candidateUrl: string) => Promise<boolean>
  },
): Promise<SignedResult | null> {
  for (const endpoint of endpoints) {
    for (const param of URL_PARAMS) {
      let response
      try {
        const request = new URL(endpoint)
        request.searchParams.set(param, mediaUrl)
        response = await http.get(request.toString(), {
          referer: options.referer,
          timeout: options.timeout,
        })
      } catch {
        continue
      }
      if (!response.ok || !response.body.trim()) continue

      for (const candidateUrl of applySignature(mediaUrl, response.body)) {
        if (await options.verify(candidateUrl)) {
          return { url: candidateUrl, endpoint }
        }
      }

      // A signer that answered at all is using this parameter name; no point
      // trying the other seven against the same endpoint.
      if (response.body.length > 8) break
    }
  }
  return null
}

/**
 * Turns a signing response into candidate URLs, most likely first.
 *
 * Three shapes cover nearly everything: a ready-made query string, a JSON
 * object holding a token (or a whole replacement URL), or a bare token.
 */
export function applySignature(mediaUrl: string, body: string): string[] {
  const trimmed = body.trim()
  const out: string[] = []
  const push = (url: string | null) => {
    if (url && !out.includes(url)) out.push(url)
  }

  // 1. `token=abc&token_path=%2Fx` — append wholesale.
  if (/^[\w.-]+=[^&\s]*(?:&[\w.-]+=[^&\s]*)*$/.test(trimmed) && trimmed.includes("=")) {
    push(join(mediaUrl, trimmed))
    return out
  }

  // 2. JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const flat = flatten(parsed)
      // A complete URL in the response wins outright.
      for (const [, value] of flat) {
        if (typeof value === "string" && /^https?:\/\/.+\.(?:m3u8|mpd)/i.test(value)) push(value)
      }
      for (const [key, value] of flat) {
        if (typeof value !== "string" || !value || value.length > 512) continue
        if (/token|sig|signature|hdnts|auth|key|hash/i.test(key)) {
          push(join(mediaUrl, `${encodeURIComponent(key)}=${encodeURIComponent(value)}`))
          // Akamai-style tokens are conventionally named.
          push(join(mediaUrl, `hdnts=${encodeURIComponent(value)}`))
        }
      }
    } catch {
      /* not JSON after all */
    }
    return out
  }

  // 3. A bare token.
  if (/^[\w.~%-]{8,512}$/.test(trimmed)) {
    push(join(mediaUrl, `token=${encodeURIComponent(trimmed)}`))
    push(join(mediaUrl, `hdnts=${encodeURIComponent(trimmed)}`))
  }
  return out
}

function join(mediaUrl: string, query: string): string | null {
  try {
    const url = new URL(mediaUrl)
    url.search = url.search ? `${url.search}&${query}` : `?${query}`
    return url.toString()
  } catch {
    return null
  }
}

/** Depth-limited flatten of a JSON value into `[key, value]` pairs. */
function flatten(value: unknown, depth = 0): Array<[string, unknown]> {
  if (depth > 4 || value === null || typeof value !== "object") return []
  const pairs: Array<[string, unknown]> = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    pairs.push([key, child])
    if (child && typeof child === "object") pairs.push(...flatten(child, depth + 1))
  }
  return pairs
}

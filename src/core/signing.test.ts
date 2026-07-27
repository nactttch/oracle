import { describe, expect, test } from "bun:test"
import { Oracle } from "./engine.js"

/**
 * Reproduces the CDN shape that broke a real playback attempt: the master
 * playlist is signed, but HLS resolves its relative URIs against the path and
 * drops the query — so every rendition inside arrives unsigned and 403s.
 */
function startSigningCdn() {
  const TOKEN = "tok123"
  return Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const signed = url.searchParams.get("token") === TOKEN

      if (url.pathname === "/token") {
        return new Response(`token=${TOKEN}`, { headers: { "content-type": "text/plain" } })
      }
      if (url.pathname === "/embed") {
        // Shaped like the real thing: the signer is named in a config key as an
        // absolute URL, the way a bundle ships its environment.
        return new Response(
          `<html><body><script>
             var env={TOKEN_SERVER_URL:"http://${url.host}/token"};
             var cfg={file:"http://${url.host}/live/master.m3u8"};
           </script></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      }
      // Everything under /live requires the signature.
      if (url.pathname.startsWith("/live")) {
        if (!signed) return new Response("denied", { status: 403 })
        if (url.pathname === "/live/master.m3u8") {
          return new Response(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/chunks.m3u8\n`,
            { headers: { "content-type": "application/vnd.apple.mpegurl" } },
          )
        }
        return new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n`, {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        })
      }
      return new Response("nope", { status: 404 })
    },
  })
}

describe("token signing end to end", () => {
  test("renditions inherit the master's signature and are proven individually", async () => {
    const server = startSigningCdn()
    try {
      const result = await new Oracle({
        timeout: 5000,
        digServers: false,
        maxDepth: 3,
      }).dig(`http://localhost:${server.port}/embed`)

      const master = result.candidates.find((candidate) => candidate.url.includes("master.m3u8"))
      expect(master?.verified).toBe(true)
      expect(master?.signedUrl).toContain("token=tok123")

      // The regression: a rendition with no signature of its own is exactly
      // what a player follows out of the master, and exactly what 403s.
      const rendition = result.candidates.find((candidate) => candidate.url.includes("chunks.m3u8"))
      expect(rendition).toBeDefined()
      expect(rendition!.signedUrl).toContain("token=tok123")
      expect(rendition!.verified).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("a signed master ranks below its own renditions, since it cannot be played", async () => {
    const server = startSigningCdn()
    try {
      const result = await new Oracle({ timeout: 5000, digServers: false, maxDepth: 3 }).dig(
        `http://localhost:${server.port}/embed`,
      )
      const verified = result.candidates.filter((candidate) => candidate.verified)
      expect(verified.length).toBeGreaterThan(1)
      // Whatever a pipeline picks up first must be something that plays.
      expect(verified[0]!.url).toContain("chunks.m3u8")
      const master = result.candidates.find((candidate) => candidate.url.includes("master.m3u8"))
      expect(master?.note).toContain("renditions need the token")
    } finally {
      server.stop(true)
    }
  })
})

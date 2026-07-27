import { describe, expect, test } from "bun:test"
import { HttpClient } from "./http.js"
import { discoverServers, fingerprint, similarity } from "./servers.js"

describe("fingerprinting", () => {
  test("identical bodies are indistinguishable", () => {
    const body = "some page with identifiers alpha bravo charlie delta"
    expect(similarity(fingerprint(body), fingerprint(body))).toBe(1)
  })

  test("a page differing only in noise stays similar", () => {
    const a = fingerprint("alpha bravo charlie delta echo foxtrot golf hotel india")
    const b = fingerprint("alpha bravo charlie delta echo foxtrot golf hotel juliet")
    expect(similarity(a, b)).toBeGreaterThan(0.7)
  })

  test("different pages diverge", () => {
    const a = fingerprint("alpha bravo charlie delta echo")
    const b = fingerprint("victor whiskey xray yankee zulus")
    expect(similarity(a, b)).toBeLessThan(0.2)
  })

  test("media urls are tracked separately from words", () => {
    const parsed = fingerprint(`a page <a href="https://cdn.tld/live/a.m3u8">x</a>`)
    expect([...parsed.streams]).toContain("//cdn.tld/live/a.m3u8")
  })
})

describe("discoverServers", () => {
  /** A site where `?serv=N` picks a stream and every other parameter is ignored. */
  function startFixture() {
    const streams: Record<string, string> = {
      "1": "https://edge1.tld/live/a.m3u8",
      "2": "https://edge2.tld/live/b.m3u8",
      "3": "https://edge3.tld/live/c.m3u8",
    }
    return Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (!url.pathname.startsWith("/p/max-5")) return new Response("nope", { status: 404 })
        const requested = url.searchParams.get("serv") ?? "1"
        const serv = streams[requested] ? requested : "1"
        return new Response(
          `<html><body><div id="vp"></div>
           <a href="?serv=2">server 2</a><a href="?serv=3">server 3</a>
           <script>var file="${streams[serv]}";</script></body></html>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
  }

  test("mines the sibling links and proves the parameter", async () => {
    const server = startFixture()
    try {
      const base = `http://localhost:${server.port}/p/max-5/`
      const http = new HttpClient({ timeout: 4000, concurrency: 4 })
      const playerBody = (await http.get(base)).body

      const found = await discoverServers(
        http,
        { playerUrl: base, playerBody },
        { depth: 4, maxProbes: 24, timeout: 4000 },
      )

      const labels = found.map((variant) => variant.url)
      expect(labels.some((url) => url.includes("serv=2"))).toBe(true)
      expect(labels.some((url) => url.includes("serv=3"))).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("does not invent servers for parameters the site ignores", async () => {
    const server = startFixture()
    try {
      const base = `http://localhost:${server.port}/p/max-5/`
      const http = new HttpClient({ timeout: 4000, concurrency: 4 })
      const playerBody = (await http.get(base)).body

      const found = await discoverServers(
        http,
        { playerUrl: base, playerBody },
        { depth: 4, maxProbes: 40, timeout: 4000 },
      )

      // `?id=2`, `?s=2` and friends all return the default page — accepting
      // them would report dozens of phantom servers.
      const probed = found.filter((variant) => variant.how === "param-probe")
      expect(probed.every((variant) => variant.url.includes("serv="))).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})

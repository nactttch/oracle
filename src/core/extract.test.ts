import { describe, expect, test } from "bun:test"
import {
  attr,
  attrs,
  classify,
  cleanUrl,
  findEmbeddedDocuments,
  findScripts,
  harvestConfigUrls,
  harvestMediaUrls,
  harvestUrls,
  isJunk,
  isMediaUrl,
  isStreamBearingPath,
  stripTags,
} from "./extract.js"

const BASE = "https://site.tld/embed/player/"

describe("classify", () => {
  test("recognises manifests by extension", () => {
    expect(classify("https://a.tld/x.m3u8")).toBe("hls")
    expect(classify("https://a.tld/x.mpd?t=1")).toBe("dash")
    expect(classify("https://a.tld/x.mp4#f")).toBe("mp4")
    expect(classify("rtmp://a.tld/live")).toBe("rtmp")
  })

  test("recognises manifests with no extension", () => {
    expect(classify("https://a.tld/hls/abc123")).toBe("hls")
    expect(classify("https://a.tld/manifest?id=9")).toBe("dash")
  })

  test("does not claim ordinary pages", () => {
    expect(classify("https://a.tld/index.html")).toBe("unknown")
    expect(isMediaUrl("https://a.tld/about")).toBe(false)
  })
})

describe("cleanUrl", () => {
  test("unescapes JSON slashes and entities", () => {
    expect(cleanUrl(String.raw`https:\/\/a.tld\/x.m3u8?a=1&amp;b=2`)).toBe("https://a.tld/x.m3u8?a=1&b=2")
  })

  test("trims trailing punctuation left by the surrounding code", () => {
    expect(cleanUrl(`https://a.tld/x.m3u8"),`)).toBe("https://a.tld/x.m3u8")
  })

  test("keeps a balanced parenthesis", () => {
    expect(cleanUrl("https://a.tld/x(1).mp4")).toBe("https://a.tld/x(1).mp4")
  })

  test("upgrades protocol-relative urls", () => {
    expect(cleanUrl("//a.tld/x.m3u8")).toBe("https://a.tld/x.m3u8")
  })
})

describe("harvesting", () => {
  test("finds absolute and relative manifests", () => {
    const text = `
      var a = "https://edge.tld/live/index.m3u8";
      var b = 'chunks/stream.m3u8';
      var c = "//cdn.tld/v.mpd";
    `
    const found = harvestMediaUrls(text, BASE)
    expect(found).toContain("https://edge.tld/live/index.m3u8")
    expect(found).toContain("https://site.tld/embed/player/chunks/stream.m3u8")
    expect(found).toContain("https://cdn.tld/v.mpd")
  })

  test("skips analytics and static assets", () => {
    const text = `<img src="https://site.tld/logo.png"><script src="https://www.googletagmanager.com/gtag/js"></script>`
    expect(harvestUrls(text, { base: BASE, includeAll: true })).toHaveLength(0)
    expect(isJunk("https://site.tld/style.css")).toBe(true)
  })

  test("keeps extensionless urls that sit in a player config key", () => {
    const text = `jwplayer("v").setup({file: "/v/8f21a?token=abc", type: "hls"});`
    expect(harvestConfigUrls(text, BASE)).toContain("https://site.tld/v/8f21a?token=abc")
  })

  test("does not mistake a config word for a url", () => {
    expect(harvestConfigUrls(`{type: "hls", file: "x"}`, BASE)).toHaveLength(0)
  })
})

describe("document graph", () => {
  test("prefers data-src over a lazy placeholder", () => {
    const html = `<iframe src="about:blank" data-src="/real/player/"></iframe>`
    const found = findEmbeddedDocuments(html, BASE)
    expect(found[0]?.url).toBe("https://site.tld/real/player/")
    expect(found[0]?.reason).toBe("iframe")
  })

  test("follows meta refresh and og:video", () => {
    const html = `
      <meta http-equiv="refresh" content="0; url=/hop/">
      <meta property="og:video" content="https://cdn.tld/v.mp4">
    `
    const urls = findEmbeddedDocuments(html, BASE).map((doc) => doc.url)
    expect(urls).toContain("https://site.tld/hop/")
    expect(urls).toContain("https://cdn.tld/v.mp4")
  })

  test("separates inline scripts from external ones", () => {
    const html = `<script src="/a.js"></script><script>var x = "a longer inline body";</script>`
    const scripts = findScripts(html, BASE)
    expect(scripts.some((script) => script.url === "https://site.tld/a.js")).toBe(true)
    expect(scripts.some((script) => script.code?.includes("longer inline body"))).toBe(true)
  })
})

describe("attributes", () => {
  test("reads a single attribute in any quote style", () => {
    expect(attr(`<a href='/x' data-n=7>`, "href")).toBe("/x")
    expect(attr(`<a href='/x' data-n=7>`, "data-n")).toBe("7")
  })

  test("reads them all, lower-cased", () => {
    expect(attrs(`<a HREF="/x" Data-Src="/y">`)).toEqual({ href: "/x", "data-src": "/y" })
  })

  test("strips tags for text heuristics", () => {
    expect(stripTags(`<div>سيرفر <b>2</b></div><script>var a=1</script>`).trim()).toBe("سيرفر 2")
  })
})

describe("sandbox paths", () => {
  test("recognises a stream-bearing property path", () => {
    expect(isStreamBearingPath("jwplayer().setup()[0].file")).toBe(true)
    expect(isStreamBearingPath("new Hls().loadSource().src")).toBe(true)
    expect(isStreamBearingPath("document.body.style")).toBe(false)
  })
})

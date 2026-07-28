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
    expect(classify("https://a.tld/manifest.mpd?id=9")).toBe("dash")
    // A bare `/manifest` is the IIS Smooth Streaming convention, not DASH.
    expect(classify("https://a.tld/x.ism/Manifest")).toBe("smooth")
    expect(classify("https://a.tld/v/8f21a?format=m3u8")).toBe("hls")
  })

  test("recognises the streaming protocols", () => {
    expect(classify("rtsp://a.tld/live")).toBe("rtsp")
    expect(classify("srt://a.tld:9000")).toBe("srt")
    expect(classify("wss://a.tld/ws")).toBe("websocket")
    expect(classify("https://a.tld/whep/room1")).toBe("webrtc")
  })

  test("recognises the container formats", () => {
    expect(classify("https://a.tld/v.mkv")).toBe("mkv")
    expect(classify("https://a.tld/v.f4m")).toBe("hds")
    expect(classify("https://a.tld/a.aac")).toBe("audio")
    expect(classify("https://a.tld/seg.m2ts")).toBe("ts")
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

describe("mime types are not urls", () => {
  test("a content type next to a file key is rejected", () => {
    expect(cleanUrl("application/vnd.apple.mpegurl")).toBeNull()
    expect(cleanUrl("video/mp4")).toBeNull()
  })

  test("a real path that merely looks similar survives", () => {
    expect(cleanUrl("/application/live.m3u8")).toBe("/application/live.m3u8")
  })

  test("harvesting skips the type key but keeps the file key", () => {
    const text = `jwplayer("v").setup({file: "/live/x.m3u8", type: "application/vnd.apple.mpegurl"});`
    const found = harvestConfigUrls(text, BASE)
    expect(found).toContain("https://site.tld/live/x.m3u8")
    expect(found.some((url) => url.includes("vnd.apple"))).toBe(false)
  })
})

describe("player chrome is not the stream", () => {
  test("a logo or about link is rejected even though the leaf is a config key", () => {
    // Branded players carry aboutlink, logo.link and a share URL next to the
    // file they actually play. Without this every one of them donates the
    // station's homepage as a candidate.
    expect(isStreamBearingPath("jwplayer().setup()[0].logo.link")).toBe(false)
    expect(isStreamBearingPath("jwplayer().setup()[0].sharing.link")).toBe(false)
    expect(isStreamBearingPath("player.setup()[0].logo.file")).toBe(false)
  })

  test("the real file key still passes", () => {
    expect(isStreamBearingPath("jwplayer().setup()[0].file")).toBe(true)
    expect(isStreamBearingPath("jwplayer().setup()[0].sources[0].src")).toBe(true)
  })

  test("share link-outs are junk", () => {
    expect(isJunk("https://t.me/somechannel")).toBe(true)
    expect(isJunk("https://telegram.org/api")).toBe(true)
    expect(isJunk("https://cdn.tld/live/index.m3u8")).toBe(false)
  })
})

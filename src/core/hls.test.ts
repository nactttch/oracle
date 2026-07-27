import { describe, expect, test } from "bun:test"
import { isDashManifest, isPlaylist, parseAttributes, parseDash, parseIsoDuration, parsePlaylist } from "./hls.js"

const BASE = "https://cdn.tld/hls/master.m3u8"

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Arabic",LANGUAGE="ar",DEFAULT=YES,URI="audio_ar.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e",AUDIO="a1"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="a1"
1080/index.m3u8
`

const LIVE_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="https://key.tld/k/5",IV=0x0
#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
seg2.ts
`

const VOD_MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
a.ts
#EXT-X-ENDLIST
`

describe("detection", () => {
  test("spots a playlist and an mpd", () => {
    expect(isPlaylist(MASTER)).toBe(true)
    expect(isPlaylist("<html>")).toBe(false)
    expect(isDashManifest(`<?xml version="1.0"?><MPD type="dynamic">`)).toBe(true)
  })
})

describe("master playlist", () => {
  const parsed = parsePlaylist(MASTER, BASE)

  test("is classified as a master", () => {
    expect(parsed.kind).toBe("master")
  })

  test("resolves rendition urls and sorts by bandwidth", () => {
    expect(parsed.variants).toHaveLength(2)
    expect(parsed.variants[0]?.resolution).toBe("1920x1080")
    expect(parsed.variants[0]?.url).toBe("https://cdn.tld/hls/1080/index.m3u8")
    expect(parsed.variants[1]?.url).toBe("https://cdn.tld/hls/360/index.m3u8")
  })

  test("captures alternate audio", () => {
    expect(parsed.media[0]).toMatchObject({ type: "AUDIO", language: "ar", isDefault: true })
    expect(parsed.media[0]?.url).toBe("https://cdn.tld/hls/audio_ar.m3u8")
  })

  test("a master is never itself live", () => {
    expect(parsed.live).toBe(false)
  })
})

describe("media playlist", () => {
  test("live: segments, no endlist, encrypted", () => {
    const parsed = parsePlaylist(LIVE_MEDIA, BASE)
    expect(parsed.kind).toBe("media")
    expect(parsed.live).toBe(true)
    expect(parsed.segmentCount).toBe(2)
    expect(parsed.encrypted).toBe(true)
    expect(parsed.keyMethod).toBe("AES-128")
    expect(parsed.keyUri).toBe("https://key.tld/k/5")
  })

  test("vod: endlist ends it", () => {
    const parsed = parsePlaylist(VOD_MEDIA, BASE)
    expect(parsed.live).toBe(false)
    expect(parsed.durationSec).toBe(10)
  })

  test("METHOD=NONE is not encryption", () => {
    const parsed = parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts\n`, BASE)
    expect(parsed.encrypted).toBe(false)
  })
})

describe("attributes", () => {
  test("parses quoted and bare values", () => {
    expect(parseAttributes(`BANDWIDTH=120,CODECS="avc1,mp4a",NAME="x"`)).toEqual({
      BANDWIDTH: "120",
      CODECS: "avc1,mp4a",
      NAME: "x",
    })
  })
})

describe("dash", () => {
  test("reads representations and liveness", () => {
    const mpd = `<MPD type="dynamic" mediaPresentationDuration="PT1H2M3S">
      <Representation id="1" bandwidth="800000" width="640" height="360" codecs="avc1"/>
      <Representation id="2" bandwidth="4000000" width="1920" height="1080" codecs="avc1"/>
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>
    </MPD>`
    const parsed = parseDash(mpd)
    expect(parsed.live).toBe(true)
    expect(parsed.encrypted).toBe(true)
    expect(parsed.representations[0]?.resolution).toBe("1920x1080")
  })

  test("parses iso durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723)
    expect(parseIsoDuration("PT30S")).toBe(30)
    expect(parseIsoDuration("nonsense")).toBeUndefined()
  })
})

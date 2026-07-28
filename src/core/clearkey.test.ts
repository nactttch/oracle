import { describe, expect, test } from "bun:test"
import { collectClearKeys } from "./engine.js"

const hit = (path: string, value: string) => ({ path, value })

describe("clearkey", () => {
  test("pairs the id and key a player was configured with", () => {
    const keys = collectClearKeys([
      hit("jwplayer().setup()[0].file", "https://cdn.tld/live.mpd"),
      hit("jwplayer().setup()[0].drm.clearkey.keyId", "18f735985ada8c2183621c4316150095"),
      hit("jwplayer().setup()[0].drm.clearkey.key", "5bbb37067a13fa42433314b9a89f889b"),
    ])
    expect(keys).toEqual([
      { keyId: "18f735985ada8c2183621c4316150095", key: "5bbb37067a13fa42433314b9a89f889b" },
    ])
  })

  test("an id with no key is not a pair", () => {
    expect(collectClearKeys([hit("drm.clearkey.keyId", "18f735985ada8c2183621c4316150095")])).toEqual([])
  })

  test("it ignores a licence-server key system", () => {
    // Widevine hands back a key only after a licence request. Nothing that
    // needs a licence server is collected here.
    const keys = collectClearKeys([
      hit("player.setup()[0].drm.widevine.url", "https://licence.tld/wv"),
      hit("player.setup()[0].drm.widevine.keyId", "18f735985ada8c2183621c4316150095"),
      hit("player.setup()[0].drm.widevine.key", "5bbb37067a13fa42433314b9a89f889b"),
    ])
    expect(keys).toEqual([])
  })

  test("a short value is not key material", () => {
    const keys = collectClearKeys([
      hit("drm.clearKey.keyId", "abc"),
      hit("drm.clearKey.key", "def"),
    ])
    expect(keys).toEqual([])
  })

  test("it keeps two declared pairs apart", () => {
    const keys = collectClearKeys([
      hit("cfg.clearkey[0].keyId", "11111111111111111111111111111111"),
      hit("cfg.clearkey[0].key", "22222222222222222222222222222222"),
      hit("cfg.clearkey[1].keyId", "33333333333333333333333333333333"),
      hit("cfg.clearkey[1].key", "44444444444444444444444444444444"),
    ])
    expect(keys).toHaveLength(2)
  })
})

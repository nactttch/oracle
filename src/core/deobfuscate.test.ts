import { describe, expect, test } from "bun:test"
import {
  collapseConcatenations,
  decodeCharCodes,
  decodeEscapes,
  decodePercentSequences,
  deobfuscate,
  harvestBase64,
  looksLikeAaEncode,
  looksLikeJsFuck,
  matchBracket,
  needsExecution,
  parseStringLiteral,
  splitTopLevelArgs,
  unpackAll,
} from "./deobfuscate.js"

describe("packer", () => {
  test("unpacks a Dean Edwards payload", () => {
    const packed =
      "eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};" +
      "if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}" +
      "k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};" +
      "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}" +
      "('0 1=\"2://3.4/5/6.7\";',8,8,'var|src|https|cdn|example|live|index|m3u8'.split('|'),0,{}))"

    expect(unpackAll(packed).trim()).toBe('var src="https://cdn.example/live/index.m3u8";')
  })

  test("leaves unpacked source untouched", () => {
    const source = "var a = 1; // nothing packed here"
    expect(unpackAll(source)).toBe(source)
  })
})

describe("escape decoding", () => {
  test("resolves runs of hex escapes", () => {
    expect(decodeEscapes(String.raw`"\x68\x74\x74\x70\x73"`)).toBe('"https"')
  })

  test("resolves unicode escapes", () => {
    expect(decodeEscapes(String.raw`"http"`)).toBe('"http"')
  })

  test("ignores a lone escape", () => {
    // A single escape is more likely part of a regex than an obfuscated string.
    const source = String.raw`/\x41/`
    expect(decodeEscapes(source)).toBe(source)
  })

  test("decodes percent-encoded runs", () => {
    expect(decodePercentSequences("%68%74%74%70%73%3a")).toBe("https:")
  })
})

describe("charcodes", () => {
  test("folds fromCharCode into a literal", () => {
    expect(decodeCharCodes("String.fromCharCode(104,116,116,112)")).toBe('"http"')
  })

  test("accepts hex arguments", () => {
    expect(decodeCharCodes("String.fromCharCode(0x68,0x74)")).toBe('"ht"')
  })

  test("leaves dynamic arguments alone", () => {
    const source = "String.fromCharCode(a,b)"
    expect(decodeCharCodes(source)).toBe(source)
  })
})

describe("concatenation", () => {
  test("merges adjacent string literals", () => {
    expect(collapseConcatenations(`"ht" + "tps://" + "host"`)).toBe(`"https://host"`)
  })

  test("handles mixed quote styles", () => {
    expect(collapseConcatenations(`"a" + 'b'`)).toBe(`"ab"`)
  })

  test("stops at a variable", () => {
    expect(collapseConcatenations(`"a" + b + "c"`)).toBe(`"a" + b + "c"`)
  })
})

describe("base64", () => {
  test("surfaces a payload that decodes to a url", () => {
    const blob = Buffer.from("https://cdn.tld/live/index.m3u8").toString("base64")
    expect(harvestBase64(`var x="${blob}";`)).toContain("https://cdn.tld/live/index.m3u8")
  })

  test("ignores base64 that decodes to noise", () => {
    const blob = Buffer.from("just some ordinary words here").toString("base64")
    expect(harvestBase64(`var x="${blob}";`)).toHaveLength(0)
  })
})

describe("scanning helpers", () => {
  test("matchBracket skips brackets inside strings", () => {
    const source = `( "a)b" )`
    expect(matchBracket(source, 0, "(", ")")).toBe(source.length - 1)
  })

  test("splitTopLevelArgs ignores nested commas", () => {
    expect(splitTopLevelArgs(`'a,b', 2, [3,4], {x:5}`)).toEqual(["'a,b'", "2", "[3,4]", "{x:5}"])
  })

  test("parseStringLiteral resolves escapes", () => {
    expect(parseStringLiteral(String.raw`"a\x2fb"`)).toBe("a/b")
    expect(parseStringLiteral("notAString")).toBeNull()
  })
})

describe("layered sources", () => {
  test("peels escapes, concatenation and charcodes together", () => {
    const source = String.raw`var a="\x68\x74\x74\x70\x73\x3a\x2f\x2f"+"edge.cdn"+String.fromCharCode(46,110,101,116)+"/hls/master.m3u8";`
    const result = deobfuscate(source)
    expect(result.text).toContain("https://edge.cdn.net/hls/master.m3u8")
    expect(result.techniques).toContain("escape-decode")
    expect(result.techniques).toContain("charcode")
    expect(result.techniques).toContain("concat")
  })
})

describe("detectors", () => {
  test("recognises jsfuck", () => {
    expect(looksLikeJsFuck("[]" + "[+!+[]]".repeat(60))).toBe(true)
    expect(looksLikeJsFuck("var a = 1;".repeat(40))).toBe(false)
  })

  test("recognises aaencode", () => {
    expect(looksLikeAaEncode("ﾟωﾟﾉ= /｀ｍ´）ﾉ ~┻━┻")).toBe(true)
  })

  test("flags sources worth executing", () => {
    expect(needsExecution("var a = atob('eA==')")).toBe(true)
    expect(needsExecution("var _0x4f2a = ['a'];")).toBe(true)
    expect(needsExecution("const x = 1 + 2")).toBe(false)
  })
})

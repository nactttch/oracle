/**
 * The honeypot DOM.
 *
 * Player bootstraps are written against a browser and nothing else. Run one in
 * a bare VM and it dies on line 1 at `document.getElementById` — long before it
 * reveals a stream URL. The usual answer is to drive a real headless browser,
 * which is 300 MB of Chromium and easily detected.
 *
 * Instead: contextify a *Proxy* as the VM's global object. Every identifier the
 * script reaches for resolves — `window`, `jwplayer`, `Clappr`, some minified
 * `_0x4f21` — to a recording ghost that accepts any property access, call, or
 * construction and returns another ghost. Scripts run to completion because
 * nothing is ever undefined, and every string that passes through a property
 * assignment or a function argument gets scanned for URLs on the way past.
 *
 * That means no per-player shims. A player Oracle has never seen still gives up
 * its stream, because `new WhateverPlayer({file: "..."}).play()` records `file`
 * exactly like `jwplayer().setup({file: "..."})` does.
 *
 * Everything runs inside `node:vm` with a wall-clock timeout, no network, no
 * filesystem, and no host objects reachable from inside.
 */

import vm from "node:vm"

export interface SandboxHit {
  value: string
  /** Where in the fake DOM it surfaced, e.g. `document.createElement().src`. */
  path: string
  /** Set when the script asked the network for this URL. */
  network?: "xhr" | "fetch" | "script" | "navigate"
}

export interface SandboxResult {
  hits: SandboxHit[]
  /** Source passed to eval()/Function() — often another obfuscation layer. */
  evaluated: string[]
  /** Anything written via document.write / innerHTML, to be parsed as HTML. */
  written: string[]
  error?: string
  timedOut: boolean
}

export interface SandboxOptions {
  /** The document URL the script believes it is running on. */
  pageUrl: string
  timeout?: number
  /** Cap on recorded strings, so a pathological loop can't exhaust memory. */
  maxHits?: number
}

/** Strings shorter than this are never URLs and just add noise. */
const MIN_INTERESTING = 4

/** Player libraries worth instrumenting if a page loads the genuine article. */
const PLAYER_GLOBALS = new Set([
  "jwplayer", "videojs", "Clappr", "Hls", "hls", "dashjs", "flvjs", "Playerjs",
  "playerjs", "fluidPlayer", "DPlayer", "Plyr", "shaka", "THEOplayer",
  "MediaSource", "jQuery", "$",
])

/** Runtime globals a browser does not have, and the sandbox must not invent. */
const HOST_GLOBALS = new Set([
  "process",
  "require",
  "module",
  "exports",
  "global",
  "Bun",
  "Deno",
  "__dirname",
  "__filename",
  "child_process",
  "vm",
])

/**
 * A browsing context that survives across scripts.
 *
 * Bundlers are the reason this exists. A webpack or Vite build is a runtime
 * chunk plus N payload chunks that hand each other modules through a shared
 * global (`webpackJsonp`, `__NUXT__`, an import map). Run each file in its own
 * context — as an earlier version of Oracle did — and every chunk registers
 * into a global nobody else can see, so the app never boots and never asks for
 * its stream. One session per document fixes that: scripts run in order, in one
 * global, exactly as the browser would have run them.
 */
export interface HoneypotSession {
  /** Executes one script in the shared context. Never throws. */
  run(code: string, filename?: string): { error?: string; timedOut: boolean }
  /** Runs queued timers and microtasks. Call after the last script. */
  drain(): void
  readonly hits: SandboxHit[]
  readonly evaluated: string[]
  readonly written: string[]
}

export function createHoneypot(options: SandboxOptions): HoneypotSession {
  const hits: SandboxHit[] = []
  const evaluated: string[] = []
  const written: string[] = []
  const maxHits = options.maxHits ?? 6000

  const bridge = {
    record(value: unknown, path: unknown, network: unknown) {
      if (hits.length >= maxHits) return
      if (typeof value !== "string" || value.length < MIN_INTERESTING) return
      hits.push({
        value,
        path: typeof path === "string" ? path : "?",
        network: (network as SandboxHit["network"]) || undefined,
      })
    },
    evaluated(source: unknown) {
      if (typeof source === "string" && source.length && evaluated.length < 64) evaluated.push(source)
    },
    written(html: unknown) {
      if (typeof html === "string" && html.length && written.length < 128) written.push(html)
    },
  }

  let location: URL
  try {
    location = new URL(options.pageUrl)
  } catch {
    location = new URL("https://localhost/")
  }

  // The sandbox's own storage. Real properties live here; anything missing is
  // synthesised as a ghost by the `get` trap below.
  const globals: Record<string, unknown> = {
    __oracle__: bridge,
    __oracle_href__: location.toString(),
    __oracle_origin__: location.origin,
    __oracle_host__: location.host,
    __oracle_hostname__: location.hostname,
    __oracle_protocol__: location.protocol,
    __oracle_pathname__: location.pathname,
    __oracle_search__: location.search,
    __oracle_referrer__: options.pageUrl,
  }

  /**
   * Trap layout matters more than it looks.
   *
   * A contextified sandbox only falls back to the VM's own intrinsics (Object,
   * JSON, Promise, ...) when the sandbox lookup comes back *empty* — and a
   * `get` trap can never return "empty", only `undefined`. So the handler ships
   * without `get`, the bootstrap runs while intrinsics are still reachable and
   * snapshots them, and only then is `get` installed. Proxy reads traps off the
   * handler on every operation, so a late assignment takes effect immediately.
   */
  const handler: ProxyHandler<Record<string, unknown>> = {
    has: () => true, // no ReferenceError, ever
    set(target, prop, value) {
      const name = String(prop)
      // A page that loads the genuine player library replaces our ghost with
      // the real thing, and the real thing keeps the config to itself. Catch
      // the assignment and instrument it on the way past.
      if (PLAYER_GLOBALS.has(name) && (typeof value === "function" || (value && typeof value === "object"))) {
        const wrap = target.__oracle_wrap_real__ as ((value: unknown, name: string) => unknown) | undefined
        if (wrap) {
          try {
            target[name] = wrap(value, name)
            return true
          } catch {
            /* fall through to a plain assignment */
          }
        }
      }
      target[name] = value
      return true
    },
    deleteProperty(target, prop) {
      delete target[prop as string]
      return true
    },
  }
  const globalProxy = new Proxy(globals, handler)

  const context = vm.createContext(globalProxy, {
    codeGeneration: { strings: true, wasm: false },
  })

  try {
    vm.runInContext(BOOTSTRAP, context, { timeout: 2000, filename: "oracle-honeypot.js" })
  } catch (error) {
    // The honeypot itself failed to install; the session is unusable but must
    // not take the dig down with it.
    const message = error instanceof Error ? error.message : String(error)
    return {
      hits,
      evaluated,
      written,
      run: () => ({ error: message, timedOut: false }),
      drain: () => {},
    }
  }

  // Phase two: unknown identifiers now resolve to ghosts instead of undefined,
  // so `SomePlayerLib.setup(...)` works for a library that was never loaded.
  const intrinsics = globals.__oracle_intrinsics__ as Record<string, unknown> | undefined
  const ghostFor = globals.__oracle_global_ghost__ as ((name: string) => unknown) | undefined
  handler.get = (target, prop) => {
    if (prop in target) return target[prop as string]
    if (typeof prop === "symbol") return undefined
    const name = String(prop)
    // `undefined` reaches the interceptor like any other global name, and
    // handing back a ghost would poison every `x === undefined` in the wild.
    if (name === "undefined") return undefined
    // Host-runtime names stay absent. A ghost here would be both a lie about
    // the environment (browsers have no `process`) and a standing invitation to
    // wonder whether the real one is reachable. It never is.
    if (HOST_GLOBALS.has(name)) return undefined
    // Plain snapshot object, so this lookup can't re-enter the traps.
    if (intrinsics && name in intrinsics) return intrinsics[name]
    return ghostFor ? ghostFor(name) : undefined
  }

  const timeout = options.timeout ?? 5000

  return {
    hits,
    evaluated,
    written,
    run(code: string, filename = "target.js") {
      try {
        vm.runInContext(code, context, { timeout, filename })
        return { timedOut: false }
      } catch (error) {
        // One bad chunk must not stop the rest: a bundle whose third file
        // throws can still have leaked the manifest in its second.
        const message = error instanceof Error ? error.message : String(error)
        return { error: message, timedOut: /timed out/i.test(message) }
      }
    },
    drain() {
      try {
        vm.runInContext("__oracle_drain__()", context, { timeout: 2000 })
      } catch {
        /* a timer that hangs has still had its chance */
      }
    },
  }
}

/** Single-shot convenience wrapper around a session. */
export function runInHoneypot(code: string, options: SandboxOptions): SandboxResult {
  const session = createHoneypot(options)
  const outcome = session.run(code)
  session.drain()
  return {
    hits: session.hits,
    evaluated: session.evaluated,
    written: session.written,
    error: outcome.error,
    timedOut: outcome.timedOut,
  }
}

/**
 * Installed inside the VM before the target script. Written as a string so the
 * Proxies it builds are native to the sandbox realm — a ghost created out here
 * would drag host intrinsics across the boundary.
 */
const BOOTSTRAP = String.raw`
(function () {
  var bridge = __oracle__;
  var MAX_DEPTH = 6;

  function scan(value, path, network, depth, seen) {
    if (value == null || depth > MAX_DEPTH) return;
    var kind = typeof value;
    if (kind === "string") { bridge.record(value, path, network); return; }
    if (kind !== "object" && kind !== "function") return;
    if (seen.indexOf(value) !== -1) return;
    seen.push(value);
    if (value.__ghost__) return;              // ghosts hold nothing real
    try {
      if (typeof value.length === "number" && kind === "object") {
        for (var i = 0; i < value.length && i < 200; i++) scan(value[i], path + "[" + i + "]", network, depth + 1, seen);
        return;
      }
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length && k < 200; k++) {
        scan(value[keys[k]], path + "." + keys[k], network, depth + 1, seen);
      }
    } catch (e) { /* exotic object — nothing to see */ }
  }

  function record(value, path, network) { scan(value, path, network, 0, []); }
  globalThis.__oracle_scan__ = record;

  // --- the ghost ------------------------------------------------------------
  function ghost(path) {
    var props = {};
    var shell = function () {};
    var handler = {
      get: function (target, prop) {
        if (prop === "__ghost__") return true;
        if (prop === Symbol.toPrimitive) return function () { return ""; };
        if (prop === Symbol.iterator) return function () { return { next: function () { return { done: true }; } }; };
        if (prop === Symbol.toStringTag) return "Object";
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return undefined;          // must not look thenable
        if (prop === "toString" || prop === "valueOf" || prop === "toJSON") return function () { return ""; };
        if (prop === "length") return 0;
        if (prop === "nodeType") return 1;
        if (prop === "prototype") return target.prototype;
        if (Object.prototype.hasOwnProperty.call(props, prop)) return props[prop];
        props[prop] = ghost(path + "." + String(prop));
        return props[prop];
      },
      set: function (target, prop, value) {
        var full = path + "." + String(prop);
        // src/href assignments are how scripts hand a URL to the browser.
        var net = (prop === "src" || prop === "href") ? "script" : undefined;
        record(value, full, net);
        props[prop] = value;
        return true;
      },
      has: function () { return true; },
      apply: function (target, self, args) {
        record(args, path + "()", undefined);
        return ghost(path + "()");
      },
      construct: function (target, args) {
        record(args, "new " + path + "()", undefined);
        return ghost("new " + path);
      },
    };
    return new Proxy(shell, handler);
  }
  globalThis.__oracle_ghost__ = ghost;

  /**
   * Wraps a *real* object so its calls are recorded and still forwarded.
   *
   * Ghosts only help for libraries that were never loaded. When a page pulls in
   * the genuine jwplayer.js and then calls jwplayer('p').setup({file: ...}),
   * the real library receives the config and does DOM work — swallowing the one
   * value we came for. This records the arguments on the way in, then forwards.
   * If the real implementation throws (it usually does, there being no DOM), we
   * hand back a ghost so the rest of the chain keeps running.
   */
  function wrapReal(target, path, depth) {
    if (target == null || depth > 3) return target;
    var kind = typeof target;
    if (kind !== "function" && kind !== "object") return target;
    if (target.__ghost__ || target.__wrapped__) return target;
    try {
      return new Proxy(target, {
        get: function (obj, prop) {
          if (prop === "__wrapped__") return true;
          var value;
          try { value = obj[prop]; } catch (e) { return undefined; }
          if (typeof value === "function") {
            return function () {
              var args = Array.prototype.slice.call(arguments);
              record(args, path + "." + String(prop) + "()");
              try {
                return wrapReal(value.apply(obj, args), path + "." + String(prop) + "()", depth + 1);
              } catch (e) {
                return ghost(path + "." + String(prop) + "()");
              }
            };
          }
          return value;
        },
        apply: function (obj, self, args) {
          record(args, path + "()");
          try { return wrapReal(obj.apply(self, args), path + "()", depth + 1); }
          catch (e) { return ghost(path + "()"); }
        },
        construct: function (obj, args) {
          record(args, "new " + path + "()");
          try { return wrapReal(Reflect.construct(obj, args), "new " + path, depth + 1); }
          catch (e) { return ghost("new " + path); }
        },
      });
    } catch (e) {
      return target;
    }
  }
  globalThis.__oracle_wrap_real__ = function (value, name) { return wrapReal(value, name, 0); };

  // One ghost per unknown global name, so identity comparisons hold across
  // reads: scripts do stash a global and compare it to itself later.
  var globalGhosts = {};
  globalThis.__oracle_global_ghost__ = function (name) {
    if (!Object.prototype.hasOwnProperty.call(globalGhosts, name)) globalGhosts[name] = ghost(name);
    return globalGhosts[name];
  };

  // Snapshot of the VM's own intrinsics, taken while they are still reachable.
  // Once the host installs its get trap this object is the only route to them.
  var INTRINSIC_NAMES = ["Object", "Function", "Array", "String", "Number", "Boolean", "Symbol",
    "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
    "ReferenceError", "EvalError", "URIError", "Promise", "Map", "Set", "WeakMap", "WeakSet",
    "Proxy", "Reflect", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
    "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float32Array", "Float64Array", "BigInt", "BigInt64Array", "BigUint64Array",
    "parseInt", "parseFloat", "isNaN", "isFinite", "NaN", "Infinity", "undefined",
    "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
    "escape", "unescape", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
    "AggregateError", "FinalizationRegistry", "WeakRef", "Intl", "structuredClone"];
  var intrinsics = {};
  for (var ii = 0; ii < INTRINSIC_NAMES.length; ii++) {
    var iname = INTRINSIC_NAMES[ii];
    try { if (typeof globalThis[iname] !== "undefined") intrinsics[iname] = globalThis[iname]; } catch (e) {}
  }
  globalThis.__oracle_intrinsics__ = intrinsics;

  // --- a DOM with just enough truth in it -----------------------------------
  var elements = [];
  function element(tag) {
    var node = ghost("<" + tag + ">");
    elements.push(node);
    return node;
  }

  var doc = ghost("document");
  doc.createElement = function (tag) { return element(String(tag)); };
  doc.createElementNS = function (_ns, tag) { return element(String(tag)); };
  doc.getElementById = function (id) { return element("#" + id); };
  doc.querySelector = function (sel) { return element(String(sel)); };
  doc.querySelectorAll = function (sel) { return [element(String(sel))]; };
  doc.getElementsByTagName = function (tag) { return [element(String(tag))]; };
  doc.getElementsByClassName = function (cls) { return [element("." + cls)]; };
  doc.addEventListener = function (_type, handler) { try { if (typeof handler === "function") handler({}); } catch (e) {} };
  doc.removeEventListener = function () {};
  doc.write = function (html) { bridge.written(String(html)); };
  doc.writeln = doc.write;
  doc.referrer = __oracle_referrer__;
  doc.cookie = "";
  doc.title = "";
  doc.readyState = "complete";
  doc.domain = __oracle_hostname__;
  globalThis.document = doc;

  var loc = {
    href: __oracle_href__, origin: __oracle_origin__, host: __oracle_host__,
    hostname: __oracle_hostname__, protocol: __oracle_protocol__,
    pathname: __oracle_pathname__, search: __oracle_search__, hash: "", port: "",
    toString: function () { return __oracle_href__; },
    assign: function (u) { record(u, "location.assign", "navigate"); },
    replace: function (u) { record(u, "location.replace", "navigate"); },
    reload: function () {},
  };
  globalThis.location = loc;
  doc.location = loc;

  globalThis.navigator = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    platform: "Win32", language: "en-US", languages: ["en-US", "en"],
    vendor: "Google Inc.", appName: "Netscape", cookieEnabled: true,
    webdriver: false, plugins: { length: 3 }, mimeTypes: { length: 2 },
    maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 8,
    javaEnabled: function () { return false; },
    sendBeacon: function (u) { record(u, "navigator.sendBeacon", "fetch"); return true; },
  };
  globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  globalThis.history = { length: 2, pushState: function () {}, replaceState: function () {}, back: function () {}, go: function () {} };
  globalThis.performance = { now: function () { return Date.now(); }, timing: {}, mark: function () {}, measure: function () {} };

  function storage() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); record(v, "localStorage." + k); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = {}; },
      key: function () { return null; },
      length: 0,
    };
  }
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();

  globalThis.atob = function (input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var str = String(input).replace(/[=]+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    var out = "", bits = 0, acc = 0;
    for (var i = 0; i < str.length; i++) {
      var idx = chars.indexOf(str.charAt(i));
      if (idx === -1) continue;
      acc = (acc << 6) | idx; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
    }
    record(out, "atob()");
    return out;
  };
  globalThis.btoa = function (input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var str = String(input), out = "";
    for (var i = 0; i < str.length; i += 3) {
      var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
      var n = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] +
             (isNaN(b) ? "=" : chars[(n >> 6) & 63]) + (isNaN(c) ? "=" : chars[n & 63]);
    }
    return out;
  };

  // --- network stubs: record the URL, hand back something inert -------------
  globalThis.fetch = function (input, init) {
    var url = (input && input.url) || input;
    record(url, "fetch()", "fetch");
    if (init) record(init, "fetch.init");
    // "{}" rather than "": page code routinely does
    // fetch(u).then(r => r.text()).then(JSON.parse), and an empty body makes
    // that throw inside a promise nobody catches. The rejection then escapes
    // the VM as a host-level unhandledRejection and takes the whole dig down.
    var body = { ok: true, status: 200, url: String(url || ""), redirected: false,
      statusText: "OK", type: "basic", bodyUsed: false,
      headers: { get: function () { return null; }, has: function () { return false; },
                 forEach: function () {} },
      text: function () { return Promise.resolve("{}"); },
      json: function () { return Promise.resolve({}); },
      blob: function () { return Promise.resolve({ size: 0 }); },
      arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
      clone: function () { return body; } };
    return Promise.resolve(body);
  };

  function FakeXhr() {
    this.readyState = 0; this.status = 200; this.responseText = "{}"; this.response = "{}";
    this.responseURL = ""; this.upload = {}; this.withCredentials = false;
  }
  FakeXhr.prototype.open = function (method, url) { record(url, "XMLHttpRequest.open", "xhr"); this._url = url; this.readyState = 1; };
  FakeXhr.prototype.setRequestHeader = function () {};
  FakeXhr.prototype.overrideMimeType = function () {};
  FakeXhr.prototype.getAllResponseHeaders = function () { return ""; };
  FakeXhr.prototype.getResponseHeader = function () { return null; };
  FakeXhr.prototype.abort = function () {};
  FakeXhr.prototype.addEventListener = function (type, fn) { if (type === "load" || type === "readystatechange") this["on" + type] = fn; };
  FakeXhr.prototype.send = function (body) {
    if (body) record(body, "XMLHttpRequest.send");
    this.readyState = 4; this.status = 200; this.responseURL = this._url || "";
    this.responseText = "{}"; this.response = "{}";
    try { if (this.onreadystatechange) this.onreadystatechange(); } catch (e) {}
    try { if (this.onload) this.onload(); } catch (e) {}
  };
  globalThis.XMLHttpRequest = FakeXhr;

  globalThis.WebSocket = function (url) { record(url, "WebSocket()", "fetch"); return ghost("WebSocket"); };
  globalThis.EventSource = function (url) { record(url, "EventSource()", "fetch"); return ghost("EventSource"); };
  globalThis.importScripts = function (u) { record(u, "importScripts()", "script"); };

  // --- timers: queue them, then drain once after the script settles ---------
  var queue = [];
  globalThis.setTimeout = function (fn, delay) { if (typeof fn === "function") queue.push({ fn: fn, at: delay || 0 }); return queue.length; };
  globalThis.setInterval = function (fn, delay) { if (typeof fn === "function") queue.push({ fn: fn, at: delay || 0 }); return queue.length; };
  globalThis.clearTimeout = function () {};
  globalThis.clearInterval = function () {};
  globalThis.requestAnimationFrame = function (fn) { if (typeof fn === "function") queue.push({ fn: fn, at: 16 }); return 1; };
  globalThis.cancelAnimationFrame = function () {};
  globalThis.queueMicrotask = function (fn) { if (typeof fn === "function") queue.push({ fn: fn, at: 0 }); };

  globalThis.__oracle_drain__ = function () {
    queue.sort(function (a, b) { return a.at - b.at; });
    for (var round = 0; round < 3 && queue.length; round++) {
      var batch = queue.splice(0, 200);
      for (var i = 0; i < batch.length; i++) { try { batch[i].fn(); } catch (e) {} }
    }
  };

  // --- JSON.parse never throws in here -------------------------------------
  //
  // The honeypot's whole premise is that nothing stops a script mid-flight.
  // JSON.parse was the one hole left: page code does
  //   fetch(u).then(function (r) { return r.text(); }).then(JSON.parse)
  // with no .catch, so a body this sandbox cannot supply becomes a rejected
  // promise that escapes the VM entirely and surfaces as a host-level
  // unhandledRejection. Returning an empty object keeps the script running,
  // which is the only thing we want from it.
  // (No backticks in this block: it lives inside a String.raw template.)
  var realParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    try {
      return realParse(text, reviver);
    } catch (e) {
      return {};
    }
  };

  // --- code-generation hooks: catch the next obfuscation layer --------------
  var realEval = globalThis.eval;
  globalThis.eval = function (source) {
    bridge.evaluated(String(source));
    record(source, "eval()");
    try { return realEval(source); } catch (e) { return undefined; }
  };
  var RealFunction = globalThis.Function;
  globalThis.Function = function () {
    var args = Array.prototype.slice.call(arguments);
    if (args.length) bridge.evaluated(String(args[args.length - 1]));
    try { return RealFunction.apply(null, args); } catch (e) { return function () {}; }
  };
  globalThis.Function.prototype = RealFunction.prototype;

  // --- window & friends -----------------------------------------------------
  var win = ghost("window");
  win.document = doc;
  win.location = loc;
  win.navigator = globalThis.navigator;
  win.screen = globalThis.screen;
  win.localStorage = globalThis.localStorage;
  win.sessionStorage = globalThis.sessionStorage;
  win.atob = globalThis.atob;
  win.btoa = globalThis.btoa;
  win.fetch = globalThis.fetch;
  win.XMLHttpRequest = FakeXhr;
  win.setTimeout = globalThis.setTimeout;
  win.setInterval = globalThis.setInterval;
  win.innerWidth = 1920; win.innerHeight = 1080;
  win.addEventListener = function (_t, h) { try { if (typeof h === "function") h({}); } catch (e) {} };
  win.removeEventListener = function () {};
  win.open = function (u) { record(u, "window.open", "navigate"); return ghost("window.open"); };
  win.postMessage = function (m) { record(m, "postMessage"); };
  win.parent = win; win.top = win; win.self = win; win.frames = [];
  globalThis.window = win;
  globalThis.self = win;
  globalThis.top = win;
  globalThis.parent = win;
  globalThis.frames = [];
  globalThis.globalThis = globalThis;

  // Player libraries and the usual helper globals. Ghosts, so any call shape
  // works; they exist by name only because scripts feature-detect them.
  var known = ["jQuery", "$", "jwplayer", "videojs", "Clappr", "Hls", "dashjs", "flvjs",
    "Playerjs", "playerjs", "fluidPlayer", "DPlayer", "Plyr", "shaka", "THEOplayer",
    "MediaSource", "WebKitMediaSource", "Image", "Audio", "Video", "Worker",
    "SharedWorker", "Notification", "IntersectionObserver", "MutationObserver",
    "ResizeObserver", "crypto", "CryptoJS", "moment", "axios", "io", "Swal",
    "adsbygoogle", "gtag", "ga", "fbq", "dataLayer", "_0x", "unsafeWindow"];
  for (var n = 0; n < known.length; n++) {
    if (!(known[n] in globalThis) || globalThis[known[n]] === undefined) {
      globalThis[known[n]] = ghost(known[n]);
    }
  }
  globalThis.alert = function () {}; globalThis.confirm = function () { return true; };
  globalThis.prompt = function () { return ""; }; globalThis.print = function () {};
  globalThis.escape = globalThis.escape || function (s) { return String(s); };
  globalThis.unescape = globalThis.unescape || function (s) { return String(s); };
})();
`

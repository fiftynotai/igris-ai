// github-stub-preload.cjs — BR-103 test seam for the bats tier.
//
// Loaded into the CLI UNDER TEST with `NODE_OPTIONS=--require <this file>`.
// It replaces `node:https` `request`/`get` in-process and re-syncs the ESM
// named exports, so `import { request } from "node:https"` (preflight.ts,
// http.ts, tarball.ts) sees the stub. The verbs are driven for real; ONLY the
// network is stubbed (L-1123). Two modes, selected by IGRIS_TEST_HTTPS_MODE:
//
//   stub   every request is answered locally with 200. `/releases/latest`
//          returns `{tag_name: IGRIS_TEST_GITHUB_STUB_TAG}` (default
//          `v0.0.0-fixture`); `/commits/<ref>` returns
//          `{sha: IGRIS_TEST_GITHUB_STUB_COMMIT_SHA}` (default a 40-hex
//          fixture) — TD-301, so the brain-core-stale detector can be driven
//          to a deterministic verdict with no network; everything else an
//          empty body. This is what
//          lets a RED run at HEAD reach `init --upgrade`'s core swap without
//          a live GitHub — the tarball body itself comes from
//          IGRIS_TARBALL_FILE (tarball.ts seam 1).
//   block  every request errors out (`IGRIS_TEST_NO_NETWORK`). The verb sees
//          an unreachable network, so a run that "succeeds" under this mode
//          provably made no network call.
//
// Every call is COUNTED and the count is written to
// IGRIS_TEST_HTTPS_COUNT_FILE at process exit, so a test asserts "zero
// network calls" from a number rather than inferring it from silence.
// TD-301 adds a second, commits-API-only counter written to
// IGRIS_TEST_HTTPS_COMMITS_COUNT_FILE, so "the release/tag install path makes
// no commit lookup" is a number too.
"use strict";
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { writeFileSync } = require("node:fs");

const mode = process.env.IGRIS_TEST_HTTPS_MODE || "block";
const tag = process.env.IGRIS_TEST_GITHUB_STUB_TAG || "v0.0.0-fixture";
// TD-301: a 40-hex git commit SHA, the shape the commits API really returns.
const commitSha =
  process.env.IGRIS_TEST_GITHUB_STUB_COMMIT_SHA || "0".repeat(39) + "1";
let calls = 0;
// TD-301: a SECOND counter, scoped to the commits API, so a test can assert
// "the release path made zero commit lookups" from a number instead of from
// the total (which the tarball / releases-latest calls also move).
let commitCalls = 0;

function stubRequest(url, opts, cb) {
  calls += 1;
  const u = typeof url === "string" ? url : String(url);
  const callback = typeof opts === "function" ? opts : cb;
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.write = () => true;
  req.end = () => {
    if (mode !== "stub") {
      process.nextTick(() =>
        req.emit("error", new Error(`IGRIS_TEST_NO_NETWORK: ${u}`)),
      );
      return req;
    }
    let body = "";
    if (u.includes("/releases/latest")) {
      body = JSON.stringify({ tag_name: tag });
    } else if (u.includes("/commits/")) {
      commitCalls += 1;
      body = JSON.stringify({ sha: commitSha });
    }
    const res = new Readable({
      read() {
        this.push(body);
        this.push(null);
      },
    });
    res.statusCode = 200;
    res.statusMessage = "OK";
    res.headers = {};
    process.nextTick(() => {
      if (typeof callback === "function") callback(res);
    });
    return req;
  };
  return req;
}

https.request = stubRequest;
https.get = (url, opts, cb) => {
  const req = stubRequest(url, opts, cb);
  req.end();
  return req;
};
require("node:module").syncBuiltinESMExports();

process.on("exit", () => {
  const file = process.env.IGRIS_TEST_HTTPS_COUNT_FILE;
  if (file) {
    try {
      writeFileSync(file, `${calls}\n`);
    } catch {
      /* the count file is best-effort; the test reads it and fails loud */
    }
  }
  // TD-301: IGRIS_TEST_HTTPS_COMMITS_COUNT_FILE gets the commits-API count.
  const cfile = process.env.IGRIS_TEST_HTTPS_COMMITS_COUNT_FILE;
  if (cfile) {
    try {
      writeFileSync(cfile, `${commitCalls}\n`);
    } catch {
      /* best-effort, as above */
    }
  }
});

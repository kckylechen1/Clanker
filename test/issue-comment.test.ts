/**
 * #27 — the dispatch keeps its own account on the ticket.
 *
 * Every judgment and attribution on this repo's issues has been typed in by
 * hand. Hand-typing does not merely cost time, it MISSES: PR #36's body carried
 * `Closes #17`, the automatic close never fired, and the ticket stayed open
 * until someone noticed at end of day. The server already holds every fact such
 * a note needs; the only missing input was which ticket a dispatch was for.
 *
 * These tests hold that feature to the three properties that decide whether it
 * is bookkeeping or noise:
 *
 *   1. The verdict is QUOTED, never restated (plugin/README.md's rule for every
 *      relay seat — a server that summarized would be breaking, in code, the
 *      rule it imposes on its seats).
 *   2. Failure is LOUD: stderr AND `telemetry.issue_comment_error`. #27 is
 *      itself a report of bookkeeping that died quietly.
 *   3. The server COMMENTS AND NOTHING ELSE. Closing a ticket is the act of a
 *      person who has read the diff.
 *
 * `gh` is never really invoked except in the two places that must prove the
 * production wiring itself (the default executor's binary name, and its
 * spawn-failure path); everywhere else the executor is injected, so the suite
 * can assert on the exact argv the server would have run.
 *
 * The last block is the discrimination check: each load-bearing rule is deleted
 * from a copy of `src/` and the corresponding assertion must go red there.
 */
import "./isolate.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ISSUE_COMMENT_VERDICT_BUDGET,
  assertCommentOnlyArgs,
  buildIssueCommentBody,
  execFileGhRunner,
  issueCommentArgs,
  parseIssueRef,
  postIssueComment,
  type GhResult,
  type GhRunner,
  type IssueCommentFacts,
} from "../src/issue-comment.js";
import { LaneManager } from "../src/manager.js";
import { LaneRun } from "../src/run.js";
import { fakeSpec, loadMutantManager, loadMutantModule, until } from "./helpers.js";

// ---------------------------------------------------------------------------
// recording executor
// ---------------------------------------------------------------------------

interface Recorder {
  runner: GhRunner;
  /**
   * `body` is read off disk at call time, not reconstructed: the body reaches
   * `gh` as `--body-file`, so what the file held while `gh` was running IS what
   * was posted. A recorder that re-rendered the body itself would be asserting
   * on its own arithmetic.
   */
  calls: { args: string[]; cwd?: string; timeoutMs: number; body: string; bodyFile: string }[];
}

/** A `gh` that never exists: records what it was asked to run and answers as told. */
function recorder(reply: GhResult | (() => Promise<GhResult>) = { code: 0, stdout: "", stderr: "" }): Recorder {
  const calls: Recorder["calls"] = [];
  return {
    calls,
    runner: async (args, opts) => {
      const bodyFile = args[args.indexOf("--body-file") + 1];
      calls.push({
        args,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        bodyFile,
        body: fs.readFileSync(bodyFile, "utf8"),
      });
      return typeof reply === "function" ? await reply() : reply;
    },
  };
}

function facts(over: Partial<IssueCommentFacts> = {}): IssueCommentFacts {
  return {
    runId: "codex-8b2b3",
    status: "done",
    turn: 1,
    lane: "codex",
    profileId: "codex-review",
    observedModel: "gpt-5.5",
    durationMs: 754_000,
    totalTokens: 24_500,
    retries: 0,
    corrections: 0,
    finalMessage: "VERDICT: BUG — src/run.ts:822 writes the tmp file before mkdir. Do not merge.",
    runDir: "/tmp/clanker/runs/codex-8b2b3",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. parameter validation — refused at dispatch, not discovered at terminal
// ---------------------------------------------------------------------------

test("#27: a valid issue reference parses in both accepted spellings", () => {
  assert.deepEqual(parseIssueRef("41"), { number: "41", raw: "41" });
  assert.deepEqual(parseIssueRef(" 41 "), { number: "41", raw: " 41 " });
  assert.deepEqual(parseIssueRef("kckylechen1/Clanker#41"), {
    number: "41",
    repo: "kckylechen1/Clanker",
    raw: "kckylechen1/Clanker#41",
  });
  assert.deepEqual(parseIssueRef("some.org/my-repo#7").repo, "some.org/my-repo");
});

test("#27: anything else is refused, and the refusal quotes what the caller wrote", () => {
  for (const bad of [
    "", "   ", "abc", "#41", "41abc", "41 42", "owner/repo41", "owner#41",
    "owner/repo#", "owner/repo#4a", "41\n--repo", "a/b/c#1", "4 1",
  ]) {
    assert.throws(() => parseIssueRef(bad), /not a valid issue reference/, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("#27: a flag-shaped reference is refused BEFORE it can reach gh as a flag", () => {
  // execFile passes an argv array and never opens a shell, so this is not
  // shell-injection defence. The hazard is one argv position over: `gh` re-reads
  // a leading `-` as a FLAG rather than as the issue it names — the same class
  // of bug cursor-acp.ts already carries `refuseFlagShapedToken` for.
  for (const flagShaped of ["-41", "--repo", "-R", "--json", "--repo=evil/repo", "-"]) {
    assert.throws(() => parseIssueRef(flagShaped), /not a valid issue reference/, flagShaped);
  }
});

test("#27: an invalid issue is refused at DISPATCH time, before any run exists", async () => {
  const m = new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir() });
  try {
    await assert.rejects(
      () => m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "--repo" }),
      /not a valid issue reference/,
    );
    // Nothing was started: a rejected parameter must cost the caller the
    // refusal and nothing else.
    assert.deepEqual(m.list().filter((e) => e.owner === "this-process"), []);
  } finally {
    await m.shutdown();
  }
});

// ---------------------------------------------------------------------------
// 2. the body — verbatim verdict, honest truncation
// ---------------------------------------------------------------------------

test("#27: the comment carries the verdict VERBATIM, not a restatement", () => {
  const verdict = "VERDICT: BUG — src/run.ts:822 writes the tmp file before mkdir. Do not merge.";
  const { body, truncated, redacted } = buildIssueCommentBody(facts({ finalMessage: verdict }));

  assert.equal(truncated, false);
  assert.equal(redacted, false);
  // The exact bytes, on their own line, with nothing wrapped around them: a
  // `> ` blockquote or a ``` fence would already be a transformation of the
  // text this comment exists to reproduce.
  assert.ok(body.split("\n").includes(verdict), `verdict must appear as its own untouched line:\n${body}`);
  assert.ok(body.includes("🤖 clanker `codex-8b2b3` — done · turn 1"));
  assert.ok(body.includes("codex / codex-review"));
  assert.ok(body.includes("observed `gpt-5.5`"));
  assert.ok(body.includes("12m34s"), `754000ms is 12m34s:\n${body}`);
  assert.ok(body.includes("1 turn"));
  assert.ok(body.includes("24.5k tok"));
  assert.ok(body.includes("/tmp/clanker/runs/codex-8b2b3"), "the run_dir is handed over as an absolute path");
});

test("#27: an over-long verdict is cut at the budget and SAYS it was cut", () => {
  const verdict = "X".repeat(ISSUE_COMMENT_VERDICT_BUDGET + 137);
  const { body, truncated } = buildIssueCommentBody(facts({ finalMessage: verdict }));

  assert.equal(truncated, true);
  assert.ok(body.includes("X".repeat(ISSUE_COMMENT_VERDICT_BUDGET)), "the head is present, verbatim");
  assert.ok(!body.includes("X".repeat(ISSUE_COMMENT_VERDICT_BUDGET + 1)), "and stops at the budget");
  // "Truncated silently" is the failure this repo has already paid for once:
  // a clipped verdict that does not announce itself reads as a whole verdict.
  assert.match(
    body,
    new RegExp(`truncated at ${ISSUE_COMMENT_VERDICT_BUDGET} of ${ISSUE_COMMENT_VERDICT_BUDGET + 137} characters`),
  );
  assert.match(body, /result\.md/, "and points at the lossless artifact");
});

test("#27: malformed worker Markdown cannot swallow what the server says about it", () => {
  // Landed by cold review: the truncation notice was appended INSIDE whatever
  // Markdown context the worker's text left open. A verdict that opens an HTML
  // comment or a fence therefore hides the notice, and a clipped verdict reads
  // as a complete one — silent truncation wearing a different hat.
  const budget = ISSUE_COMMENT_VERDICT_BUDGET;
  for (const [name, verdict] of [
    ["unclosed fence", "```\n" + "X".repeat(budget + 50)],
    ["unclosed html comment", "<!-- " + "Y".repeat(budget + 50)],
    ["nested fences", "````text\n```\n" + "Z".repeat(budget + 50)],
  ] as const) {
    const { body, truncated } = buildIssueCommentBody(facts({ finalMessage: verdict }));
    assert.equal(truncated, true, name);
    const lines = body.split("\n");
    const open = lines.find((l) => /^`{3,}$/.test(l))!;
    assert.ok(open, `${name}: the verdict must be fenced:\n${body}`);
    assert.equal(
      lines.filter((l) => l === open).length,
      2,
      `${name}: the server's fence appears exactly twice — worker fences are shorter and cannot close it:\n${body}`,
    );

    // The fence outruns every backtick run the worker wrote, so the worker's
    // text cannot close the block early.
    const longestInside = Math.max(...(verdict.match(/`+/g) ?? [""]).map((r) => r.length));
    assert.ok(open.length > longestInside, `${name}: fence ${open.length} > longest run ${longestInside}`);

    // What a RENDERER would keep inside the block — it closes at the first
    // matching fence, so this is the assertion that the verdict cannot escape.
    const openAt = lines.indexOf(open);
    const closeAt = lines.indexOf(open, openAt + 1);
    assert.equal(
      lines.slice(openAt + 1, closeAt).join("\n"),
      verdict.slice(0, budget),
      `${name}: the whole (truncated) verdict stays inside the block`,
    );

    // And every word the SERVER says sits after the closing fence.
    const close = closeAt;
    const notice = lines.findIndex((l) => l.includes("truncated at"));
    const pointer = lines.findIndex((l) => l.startsWith("run_dir "));
    assert.ok(notice > close, `${name}: the truncation notice must be outside the fence:\n${body}`);
    assert.ok(pointer > close, `${name}: so must the result.md pointer:\n${body}`);
  }
});

test("#27: a run that died before speaking still files an account, labelled as the error", () => {
  const { body } = buildIssueCommentBody(
    facts({ status: "error", finalMessage: "", error: "lane process exited mid-turn (code=1 signal=null)" }),
  );
  assert.ok(body.includes("🤖 clanker `codex-8b2b3` — error · turn 1"));
  assert.ok(body.split("\n").includes("error:"), "the fallback names which field is being shown");
  assert.ok(body.split("\n").includes("lane process exited mid-turn (code=1 signal=null)"));
});

test("#27: the four leaks a cold review landed on `redact()` are all closed at the public sink", async () => {
  // Reproduced verbatim from the review (codex-32405): every one of these
  // reached the comment body intact under `redact()`, which fires only on a
  // NAMED key and therefore blanked the header while publishing the token.
  const leaks: [string, string][] = [
    ["Authorization: Bearer ghp_1234567890abcdefghijklmnopqrstuvwx", "ghp_1234567890abcdefghijklmnopqrstuvwx"],
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
    ["cloned from https://user:hunter2@github.com/kckylechen1/Clanker.git", "hunter2"],
    ["the env dump showed OPENAI_API_KEY=sk-live-abcdefghijklmnop", "sk-live-abcdefghijklmnop"],
  ];
  for (const [verdict, secret] of leaks) {
    const { body, redacted } = buildIssueCommentBody(facts({ finalMessage: verdict }));
    assert.equal(redacted, true, `must be reported as redacted: ${verdict}`);
    assert.ok(!body.includes(secret), `the credential must not reach the comment:\n${body}`);
  }
  // …and the old function still fails all but one of them, which is the whole
  // reason there are now two: a passing test here must not be provable by the
  // sink-agnostic redactor.
  const util = await import("../src/util.js");
  assert.ok(util.redact(leaks[0][0]).includes(leaks[0][1]), "redact() leaves the bearer token — hence redactForPublic");
  assert.ok(util.redact(leaks[2][0]).includes("hunter2"), "redact() leaves URL credentials");
});

test("#27: an auth header is redacted by its STRUCTURE, whatever the scheme is called", async () => {
  const { redactForPublic } = await import("../src/util.js");
  // Second cold review landed `Basic` walking straight through a rule that knew
  // `bearer|token`: `redact()` eats the SCHEME (its `\S+` starts after the
  // colon), leaving `Authorization: [REDACTED] dXNlcjpodW50ZXIy` — the same bug
  // as round one wearing a different scheme name. A short Basic payload is
  // under every length threshold the blob rules use, so nothing else caught it.
  const basic = Buffer.from("user:hunter2").toString("base64");
  for (const [line, secret] of [
    [`Authorization: Basic ${basic}`, basic],
    [`authorization:Basic ${basic}`, basic],
    [`{"Authorization": "Basic ${basic}"}`, basic],
    [`curl -H 'Authorization: Basic ${basic}' https://api.example.com`, basic],
    ["Proxy-Authorization: Digest response=deadbeefcafe1234", "deadbeefcafe1234"],
    ["Authorization: Negotiate YIIZfwYGKwYBBQUCoIIZ", "YIIZfwYGKwYBBQUCoIIZ"],
    ["Authorization: ApiKey k9x2m4", "k9x2m4"],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `credential survived: ${line}\n → ${out}`);
    // The scheme is kept on purpose: "a Basic credential was published here" is
    // what a reader of a redacted verdict needs in order to act on it.
    const scheme = line.match(/(?:Basic|Digest|Negotiate|ApiKey)/)![0];
    assert.ok(out.includes(scheme), `the scheme must survive as evidence: ${out}`);
    assert.ok(out.includes("[REDACTED]"), out);
  }
  // Where the credentials END depends on what the header is embedded in, and
  // both halves were landed by cold review. A BARE header runs to end of line,
  // auth-params and all: excluding quotes (which the curl case below needs)
  // made `Digest username="alice", …, response="<hash>"` stop at the first
  // quote and publish the response hash — 16 hex, which no blob rule catches.
  for (const [line, secret] of [
    ['Authorization: Digest username="alice", realm="private", response="deadbeefcafe1234"', "deadbeefcafe1234"],
    ['Authorization: Signature keyId="k1",signature="c2lnbmF0dXJl"', "c2lnbmF0dXJl"],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `auth-param credential survived:\n${out}`);
    assert.ok(!out.includes("alice") || !out.includes("realm"), `the auth-param list must not be left behind:\n${out}`);
  }
  // A header logged INSIDE a JSON string — the shape a fourth cold review
  // walked through untouched. What pairs an opener with its closer is equal
  // ESCAPING DEPTH, not "raw quote": here the opener is `\"` and so is the
  // closer, and the previous fix ("an escaped quote is never the wrapper")
  // is precisely what would have kept this broken. Counting backslashes
  // handles JSON-inside-JSON with no further branch.
  for (const [line, secret] of [
    [`{\\"Authorization\\": \\"Basic ${basic}\\"}`, basic],
    [`log: {\\"authorization\\":\\"Bearer abc123short\\"}`, "abc123short"],
    [`{\\\\"Authorization\\\\": \\\\"Basic ${basic}\\\\"}`, basic],
    [`sh -c 'curl -H \\'Authorization: Basic ${basic}\\''`, basic],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `escaped-quote header survived:\n${out}`);
    assert.ok(out.includes("[REDACTED]"), out);
  }
  // Backslash PARITY, measured rather than assumed — a fifth cold review
  // flagged this shape as one it could not verify under a read-only contract.
  // `\\` is an escaped backslash, so the quote after it is a REAL closer even
  // though two backslashes precede it. Under the older equality rule the closer
  // went unrecognised and the credentials ran to end of line: over-redaction,
  // never a leak, but it ate the rest of the command.
  const parity = redactForPublic(
    `curl -H "Authorization: Basic ${basic}\\\\" --next https://api.example.com`,
  );
  assert.ok(!parity.includes(basic), parity);
  assert.ok(parity.includes("--next https://api.example.com"), `the tail must survive: ${parity}`);
  // …while an ODD count really is an escaped quote, so it is not the closer.
  const odd = redactForPublic(`curl -H "Authorization: Basic ${basic}\\" still-inside" tail`);
  assert.ok(!odd.includes(basic), odd);
  assert.ok(odd.endsWith(" tail"), `the real closer is the unescaped one: ${odd}`);

  // …and the escaping is handed back exactly as it was written, so the log
  // line still parses as the JSON it came from.
  assert.equal(
    redactForPublic(`{\\"Authorization\\": \\"Basic ${basic}\\", \\"Accept\\": \\"application/json\\"}`),
    `{\\"Authorization\\": \\"Basic [REDACTED]\\", \\"Accept\\": \\"application/json\\"}`,
  );

  // …while a WRAPPED header stops at its wrapper, because everything after it
  // is the caller's command line, which is evidence rather than credential.
  const wrapped: [string, string, string][] = [
    [`curl -H 'Authorization: Basic ${basic}' https://api.example.com`, basic, "https://api.example.com"],
    [`{"Authorization": "Basic ${basic}", "Accept": "application/json"}`, basic, '"Accept": "application/json"'],
    ["the header `Authorization: Bearer ghp_short123` is built in src/foo.ts:12", "ghp_short123", "src/foo.ts:12"],
    // An ESCAPED wrapper is not the wrapper — otherwise the digest below is
    // republished by the very rule that is supposed to eat it.
    ['curl -H "Authorization: Digest response=\\"deadbeefcafe1234\\"" https://api.example.com',
      "deadbeefcafe1234", "https://api.example.com"],
  ];
  for (const [line, secret, keep] of wrapped) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `credential survived a wrapped header:\n${out}`);
    assert.ok(out.includes(keep), `the rule ate past its wrapper and took evidence with it:\n${out}`);
  }

  // Prose about the header is not a header.
  for (const prose of [
    "Authorization header is missing from the request",
    "the Authorization header (RFC 9110) carries a scheme and credentials",
    "src/util.ts:125 — the authorization rule is structural now",
  ]) {
    assert.equal(redactForPublic(prose), prose, `prose must survive: ${prose}`);
  }
  // A worker that writes the park placeholder itself gets it back untouched —
  // the machinery must not be a way to make the redactor say something else.
  // The half this test USED to miss, and a cold review did not: the collision
  // only bites when a real header is present too, because that is what puts an
  // entry at the index the worker's literal names. The verdict came back with
  // the worker's own text replaced by the first parked header — no plaintext
  // leaked, but the verdict was rewritten, and shipping the verdict unaltered
  // is the one promise this whole feature exists to keep.
  for (const literal of ["[[clanker-hdr:0]]", "[[clanker-hdr-1:0]]", "[[clanker-hdr:0]] and [[clanker-hdr-1:0]]"]) {
    const line = `the worker wrote ${literal} and also Authorization: Basic ${basic}`;
    const out = redactForPublic(line);
    assert.ok(out.startsWith(`the worker wrote ${literal} and also `), `worker text was rewritten:\n${out}`);
    assert.ok(!out.includes(basic), `and the real header must still be redacted:\n${out}`);
  }
  assert.equal(redactForPublic("see [[clanker-hdr:0]] below"), "see [[clanker-hdr:0]] below");

  // Deriving the tag must not become the attack. A verdict can name every
  // candidate placeholder it likes; the derivation is one scan plus a lookup
  // per distinct suffix, and it runs on the FULL verdict, before the 3000-char
  // budget — so the worker controls both the number of candidates and the
  // length of the text they sit in.
  const crowded =
    Array.from({ length: 4000 }, (_, i) => `[[clanker-hdr${i === 0 ? "" : `-${i}`}:0]]`).join(" ") +
    `\nAuthorization: Basic ${basic}\n`;
  const started = Date.now();
  const survived = redactForPublic(crowded);
  assert.ok(Date.now() - started < 2_000, `tag derivation must not blow up on adversarial input (${Date.now() - started}ms)`);
  assert.ok(!survived.includes(basic), "…and it still redacts the real header");
  assert.ok(survived.startsWith("[[clanker-hdr:0]] [[clanker-hdr-1:0]]"), "…without touching the worker's own text");
  // A parked header must survive the rules that run while it is parked: the
  // key-name rule's value would otherwise eat the placeholder standing later on
  // the same line, deleting a header this function had already redacted.
  const eaten = redactForPublic(`x-auth: hunter2 then Authorization: Basic ${basic}`);
  assert.ok(eaten.includes("Authorization: Basic [REDACTED]"), `the parked header was consumed:\n${eaten}`);
  assert.ok(!eaten.includes("hunter2"), eaten);
});

test("#27: the public sink's key-name table is longer than the local one, and still bounded", async () => {
  const { redactForPublic, redact } = await import("../src/util.js");
  // `X-Auth: hunter2` — a custom header name with no key-ish word and a short,
  // word-shaped value — used to survive: `redact()`'s table does not contain
  // `auth`, and every blob rule gates on randomness the value does not have.
  // The first version of this fix called that unfixable on the grounds that the
  // only alternative was matching header names as an open set. That was a false
  // dilemma: NAMES can stay a bounded table, only VALUES are open.
  for (const [line, secret] of [
    ["X-Auth: hunter2", "hunter2"],
    ["x-auth = hunter2", "hunter2"],
    ["Set-Cookie: sid=hunter2; HttpOnly", "hunter2"],
    ["session=abc123", "abc123"],
    ["password: hunter2", "hunter2"],
    ["PRIVATE_KEY=hunter2", "hunter2"],
    ["signature: c2ln", "c2ln"],
    ['{"credentials": "hunter2"}', "hunter2"],
    ["passphrase = opensesame", "opensesame"],
    // The four a fourth cold review walked past, all the same miss: the
    // keyword was present but not LAST, and the rule required it to sit
    // immediately before the separator. The rule now takes the whole key token
    // and asks what WORDS it is made of, so position stopped mattering.
    ["X-Session-ID: abc123xyz", "abc123xyz"],
    ["session_id=abc123xyz", "abc123xyz"],
    ["auth_token_v2: hunter2word", "hunter2word"],
    ["X-Api-Key-Legacy: hunter2word", "hunter2word"],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `key-name rule missed: ${line}\n → ${out}`);
    assert.ok(out.includes("[REDACTED]"), out);
    // The key name survives, as everywhere else here: a redaction has to stay
    // legible evidence rather than an unexplained hole.
    assert.match(out, /^[^[]/, `the key name must not be swallowed: ${out}`);
  }
  assert.ok(redact("X-Auth: hunter2").includes("hunter2"), "the LOCAL redactor is deliberately not widened");

  // The value is ONE token, which is the blast radius `redact()` has always
  // had. The first version of this rule ran to end of line and the leader
  // reproduced the cost on prose: a diagnosis sentence whose first word happens
  // to follow a key-shaped word was deleted whole. Corpus statistics missed it
  // because they count SPANS — eating one word and eating a sentence both
  // score 1 — so this assertion is about what is LEFT, not about what is gone.
  for (const [line, kept] of [
    ["token: expired at noon", "at noon"],
    ["session: the run died here", "run died here"],
    ["auth: broken since tuesday", "since tuesday"],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(out.includes(kept), `the rest of the sentence must survive: ${JSON.stringify(out)}`);
    assert.ok(out.includes("[REDACTED]"), out);
  }
  // A query string is where a credential most often turns up in a log line,
  // and both of these were public-sink misses until `?`/`&`/`;` joined the
  // lead set. Adding them was not enough on its own: the scan used to CONSUME
  // a declined match, so `https:` swallowed the rest of the line and the real
  // credential was never examined (see redactKeyedValues).
  for (const [line, secret, kept] of [
    ["https://api.x.com/v1?auth_token_v2=hunter2word", "hunter2word", "https://api.x.com/v1"],
    ["GET /cb?session_id=abc123xyz&next=/home", "abc123xyz", "&next=/home"],
    ["https://api.x.com/v1?page=2&session=abc123&sort=name", "abc123", "&sort=name"],
    ["Set-Cookie: sid=hunter2;auth_token=xyzvalue", "xyzvalue", ";auth_token="],
    ["note: see the header X-Auth: hunter2 for details", "hunter2", "for details"],
  ] as const) {
    const out = redactForPublic(line);
    assert.ok(!out.includes(secret), `query-string credential survived: ${out}`);
    assert.ok(out.includes(kept), `the value must stop at the parameter boundary: ${out}`);
  }
  // …and an ordinary query string is not a credential.
  for (const url of [
    "https://x.com/a?page=2&sort=name",
    "https://x.com/docs?section=auth&page=3",
    "https://github.com/kckylechen1/Clanker/issues/27#issuecomment-5117629276",
  ]) {
    assert.equal(redactForPublic(url), url, `URL must survive: ${url}`);
  }

  // KNOWN AND ACCEPTED false positives, pinned so they cannot change silently.
  // The comments admit these two; a cost that is only admitted in prose gets
  // "fixed" by the next refactor and the corpus number quietly moves. Pinned
  // here, that shows up as a failing test instead.
  assert.equal(
    redactForPublic("owns_session_key = !__zc_session_key_scoped"),
    "owns_session_key = [REDACTED]",
    "a C identifier whose name contains `session` is redacted — 1 span in the corpus, accepted",
  );
  assert.equal(
    redactForPublic("this.laneSessionRef = ref;"),
    "this.laneSessionRef = [REDACTED];",
    "…and so is a TS field assignment whose name contains `Session` — the same accepted trade",
  );

  // The one thing one-token costs, recorded rather than papered over: a
  // passphrase that contains a space keeps everything after the first word.
  // Accepted — the space-bearing credential this codebase actually emits is
  // `Authorization: Basic <blob>`, and that belongs to the header rule.
  assert.equal(redactForPublic("passphrase = open sesame"), "passphrase = [REDACTED] sesame");

  // The bound, which is what keeps this from being the prose-eating rule its
  // predecessor was accused of being: the keyword has to be in KEY POSITION and
  // followed by `:` or `=`. Prose about sessions and signatures is not a key.
  for (const prose of [
    "the session is stale: nobody resumed it",
    "authentication failed because the header was missing",
    "src/session.ts:88 — the session ref is lane-neutral",
    "the cookie jar lives under ~/.config",
    "a signature check runs before the write",
    // Go assignment, quoted as evidence in a verdict — `:=` is not a key
    // separator, and this exact line was a corpus false positive until it was
    // excluded.
    "sig := portfolio.AgentSignal{Kind: kind}",
    // WORDS, not substrings: widening to substring containment would eat all
    // three of these, and the third is a git log line.
    "AgentSignal: kind is set by the router",
    "design: the parked header is restored last",
    "author: Kyle Chen",
    // The shape this whole feature exists to deliver. `auth-service.ts`
    // contains the word `auth`, and a verdict that loses its file:line has
    // lost the thing it was written to carry — measured, the source-extension
    // guard is the only reason this line survives.
    "auth-service.ts:34 — the header rule lives here",
    "session-store.go:88 fails under load",
    "credentials.rs:7 is where the type is declared",
    // Bare `key` is not a credential word, or every YAML file would be redacted.
    "key: value",
    "line: 91",
  ]) {
    assert.equal(redactForPublic(prose), prose, `prose must survive: ${prose}`);
  }
});

test("#27: unlabelled credential shapes are caught, and a verdict's own evidence is not", async () => {
  const { redactForPublic } = await import("../src/util.js");
  // Shapes with no key name and no prefix to announce them. The cost of missing
  // one is a token published to a remote nobody can un-publish. Every value
  // here is synthetic and several are the vendors' own published examples —
  // `gitleaks:allow` because the repo's pre-commit scanner cannot tell a
  // fixture from a leak, and a scanner that had to would be the wrong scanner.
  for (const secret of [
    "wJalrXUtnFEMIxK7MDENGxbPxRfiCYEXAMPLEKEY", // AWS-style 40-char secret — gitleaks:allow
    "a3f1c9d84b7e26f05c1d9ab37e40f2c8", // 32 hex — entropy too low for any generic gate
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", // JWT — gitleaks:allow
    "AKIAIOSFODNN7EXAMPLE", // gitleaks:allow
    "xoxb" + "-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", // gitleaks:allow
  ]) {
    const out = redactForPublic(`the worker printed ${secret} into its final message`);
    assert.ok(!out.includes(secret), `unredacted credential shape: ${secret}\n → ${out}`);
  }
  // The control half, and it is the half that makes the rule usable: a verdict
  // IS file paths, SHAs, identifiers and prose about tokens. A redactor that
  // eats those has destroyed the account it was protecting. Corpus-derived —
  // every line here is a shape that appears in real `result.md` verdicts.
  for (const evidence of [
    "src/issue-comment.ts:172 — the sink calls the wrong redactor",
    "base ebd72edcc69227343e6ea82035d0ccc67d02419d, worktree clean",
    "/Users/kckylechen/Projects/Clanker/.claude/worktrees/agent-a59998409f0a51c75/src/util.ts",
    "branch worktree-agent-a59998409f0a51c75, base_sha=83059a2173a51459bd6a789191dadb92d758a298",
    "the token is staged in a file, never in argv, so no process listing carries it",
    "TestRouteAndPersistThesisAlertSnapshotSourceOwnedRevertContract fails at line 91",
    "DEFAULT_RAW_VECTOR_SIMILARITY_FLOOR is read once at startup",
    " test/issue-comment.test.ts | 106 ++++++++++++++++++++++++++++++++++++++++++",
  ]) {
    assert.equal(redactForPublic(evidence), evidence, `evidence must survive verbatim: ${evidence}`);
  }
});

test("#27: secret-shaped values are redacted before leaving for a remote, and it is announced", () => {
  // The one deliberate deviation from byte-for-byte quoting. A comment is the
  // only artifact this server pushes to a possibly-public surface, and a worker
  // that echoed a credential into its final message would otherwise publish it.
  // Announced in the body, so it is never a silent rewrite.
  const { body, redacted } = buildIssueCommentBody(
    facts({ finalMessage: "the env dump showed ZHIPUAI_API_KEY=sk-live-abcdef and nothing else" }),
  );
  assert.equal(redacted, true);
  assert.ok(!body.includes("sk-live-abcdef"), "the credential must not reach the comment");
  assert.match(body, /secret-shaped values were redacted/);
  assert.match(body, /holds the unredacted text/);
});

// ---------------------------------------------------------------------------
// 3. argv — a comment and nothing else, ever
// ---------------------------------------------------------------------------

test("#27: the executor is only ever handed `gh issue comment`", async () => {
  const rec = recorder();
  const out = await postIssueComment(
    { ref: parseIssueRef("kckylechen1/Clanker#27"), facts: facts(), cwd: os.tmpdir() },
    { run: rec.runner },
  );
  assert.equal(out.ok, true);
  assert.equal(rec.calls.length, 1);

  const args = rec.calls[0].args;
  assert.deepEqual(args.slice(0, 3), ["issue", "comment", "27"]);
  assert.deepEqual(args.slice(3, 5), ["--repo", "kckylechen1/Clanker"]);
  assert.equal(args[5], "--body-file");
  assert.equal(args.length, 7, "no argv beyond the body file");
  // The verdict is NOT in argv at all: it crosses a file boundary, so no
  // process listing carries it and no ARG_MAX ceiling applies. (The operator's
  // own `gh` wrapper refuses inline body text outright — exit 64 — which is how
  // this was found: on the real binary, not against a fake.)
  assert.ok(!args.some((a) => a.includes("VERDICT")), "worker text never reaches argv");
  // No state-changing verb at ANY position.
  for (const [i, arg] of args.entries()) {
    assert.ok(
      !["close", "reopen", "edit", "delete", "transfer", "pin", "lock", "--state"].includes(arg),
      `argv[${i}] = ${arg}`,
    );
  }
  // And the staged body file does not outlive the call.
  assert.equal(fs.existsSync(rec.calls[0].bodyFile), false, "the staged body is not left behind");
});

test("#27: a bare number carries no --repo and answers from the dispatch's own repo", async () => {
  const rec = recorder();
  await postIssueComment({ ref: parseIssueRef("27"), facts: facts(), cwd: os.tmpdir() }, { run: rec.runner });
  assert.deepEqual(rec.calls[0].args.slice(0, 3), ["issue", "comment", "27"]);
  assert.equal(rec.calls[0].args[3], "--body-file");
  assert.equal(rec.calls[0].cwd, os.tmpdir());
});

test("#27: any argv that is not a comment is refused in code, not only in review", () => {
  assert.throws(() => assertCommentOnlyArgs(["issue", "close", "27"]), /only `gh issue comment`/);
  assert.throws(() => assertCommentOnlyArgs(["issue", "edit", "27", "--body-file", "f"]), /only `gh issue comment`/);
  assert.throws(() => assertCommentOnlyArgs(["pr", "merge", "36"]), /only `gh issue comment`/);
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27", "--state", "closed"]), /unexpected flag/);
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "--repo"]), /must be a bare number/);
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27", "--body-file"]), /has no value/);
  // Inline body text is not merely unused here, it is unreachable.
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27", "--body", "hi"]), /unexpected flag/);
  // …and the legitimate shapes still pass.
  assertCommentOnlyArgs(["issue", "comment", "27", "--body-file", "/tmp/b.md"]);
  assertCommentOnlyArgs(["issue", "comment", "27", "--repo", "o/r", "--body-file", "/tmp/b.md"]);
});

test("#27: the gate enforces the shape it CLAIMS, not just the flags it was shown", () => {
  // Landed by cold review: this exact argv passed. `gh issue comment 27` with
  // no body file opens an editor — on a server that is a hang, not a comment —
  // and it passed only because the one caller happens to append the file.
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27"]), /must travel as `--body-file/);
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27", "--repo", "o/r"]), /must travel as `--body-file/);
  // A flag-shaped VALUE is the same argv-position hazard one step in: `gh`
  // would read the body file's place as another flag and post nothing.
  assert.throws(
    () => assertCommentOnlyArgs(["issue", "comment", "27", "--body-file", "--repo"]),
    /flag-shaped value/,
  );
  assert.throws(() => assertCommentOnlyArgs(["issue", "comment", "27", "--repo", "", "--body-file", "b"]), /flag-shaped value/);
  // A repeated flag is a last-one-wins hole: `gh` would honour the second.
  assert.throws(
    () => assertCommentOnlyArgs(["issue", "comment", "27", "--body-file", "/tmp/a.md", "--body-file", "/tmp/b.md"]),
    /given twice/,
  );
  // The gate is what the production builder produces, for both spellings —
  // asserted through the builder so the two can never drift apart.
  assertCommentOnlyArgs(issueCommentArgs(parseIssueRef("27"), "/tmp/b.md"));
  assertCommentOnlyArgs(issueCommentArgs(parseIssueRef("o/r#27"), "/tmp/b.md"));
});

// ---------------------------------------------------------------------------
// 4. failure is loud, never fatal
// ---------------------------------------------------------------------------

/** Run `fn` with `fs.writeFileSync` failing as a full disk does. */
async function withFailingWrite<T>(fn: () => Promise<T>): Promise<T> {
  const real = fs.writeFileSync;
  (fs as { writeFileSync: unknown }).writeFileSync = () => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  try {
    return await fn();
  } finally {
    (fs as { writeFileSync: unknown }).writeFileSync = real;
  }
}

const scratchDirs = () =>
  new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("clanker-issue-comment-")));

test("#27: a body write that fails mid-staging strands nothing on disk", async () => {
  // `mkdtempSync` succeeds, `writeFileSync` throws — ENOSPC, EIO, a quota. The
  // machine that just failed to write a few kilobytes is the last one that can
  // afford a leaked directory per dispatch, and this path runs on EVERY
  // terminal turn of every run that names a ticket.
  const before = scratchDirs();
  const rec = recorder();
  const logged: string[] = [];
  const out = await withFailingWrite(() =>
    postIssueComment({ ref: parseIssueRef("27"), facts: facts() }, { run: rec.runner, logError: (m) => logged.push(m) }),
  );
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /could not stage the comment body/);
  assert.match((out as { error: string }).error, /ENOSPC/, "the real reason travels, not a generic one");
  assert.equal(logged.length, 1, "and it is loud, like every other failure here");
  assert.equal(rec.calls.length, 0, "`gh` is never asked to post a body that was never written");
  assert.deepEqual([...scratchDirs()].filter((d) => !before.has(d)), [], "no scratch directory outlives the failure");
});

test("#27: a cleanup that cannot run says so instead of leaking in silence", async () => {
  // Second cold review's remaining CONCERN: `rmSync` failing was swallowed
  // whole, so the directory stayed AND nothing said who left it. Still
  // best-effort (bookkeeping never fails a dispatch) — but attributable.
  const rec = recorder();
  const logged: string[] = [];
  const realRm = fs.rmSync;
  (fs as { rmSync: unknown }).rmSync = () => {
    throw Object.assign(new Error("EPERM: operation not permitted, rm"), { code: "EPERM" });
  };
  let out;
  try {
    out = await postIssueComment(
      { ref: parseIssueRef("27"), facts: facts() },
      { run: rec.runner, logError: (m) => logged.push(m) },
    );
  } finally {
    (fs as { rmSync: unknown }).rmSync = realRm;
  }
  assert.equal(out.ok, true, "a failed cleanup does not fail the comment that already landed");
  assert.equal(logged.length, 1, "…but it is no longer invisible");
  assert.match(logged[0], /could not remove the staged body/);
  assert.match(logged[0], /EPERM/, "the reason travels");
  assert.match(logged[0], /clanker-issue-comment-/, "and so does the path, so the leak is attributable");
  // The directory really is still there; remove it so the suite leaves nothing.
  const leaked = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("clanker-issue-comment-"));
  for (const dir of leaked) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
});

test("mutation: cleanup installed after the write leaks the directory the write failed in", async () => {
  // The shipped shape: `try/finally` opened AFTER staging, so the staging
  // catch returned before the cleanup existed.
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-late-cleanup",
    [{
      file: "issue-comment.ts",
      find:
        "  let scratch: string | undefined;\n" +
        "  try {\n" +
        "    let bodyFile: string;\n" +
        "    try {\n" +
        '      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-comment-"));\n' +
        '      bodyFile = path.join(scratch, "body.md");\n' +
        "      fs.writeFileSync(bodyFile, body);\n" +
        "    } catch (error) {\n" +
        "      return fail(`could not stage the comment body: ${errMessage(error)}`);\n" +
        "    }\n" +
        "\n" +
        "    let args: string[];",
      replace:
        "  let scratch: string | undefined;\n" +
        "  let bodyFile: string;\n" +
        "  try {\n" +
        '    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-comment-"));\n' +
        '    bodyFile = path.join(scratch, "body.md");\n' +
        "    fs.writeFileSync(bodyFile, body);\n" +
        "  } catch (error) {\n" +
        "    return fail(`could not stage the comment body: ${errMessage(error)}`);\n" +
        "  }\n" +
        "\n" +
        "  try {\n" +
        "    let args: string[];",
    }],
    "issue-comment.ts",
  );
  const before = scratchDirs();
  const out = await withFailingWrite(() =>
    mutant.postIssueComment(
      { ref: mutant.parseIssueRef("27"), facts: facts() },
      { run: recorder().runner, logError: () => {} },
    ),
  );
  assert.equal(out.ok, false);
  const leaked = [...scratchDirs()].filter((d) => !before.has(d));
  assert.equal(leaked.length, 1, "the mutant strands exactly the directory it created — the green build must not");
  for (const dir of leaked) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
});

test("#27: a non-zero `gh` is loud, reports its stderr, and does not throw", async () => {
  const logged: string[] = [];
  const rec = recorder({ code: 1, stdout: "", stderr: "gh: Could not resolve to an Issue with the number 999999." });
  const out = await postIssueComment(
    { ref: parseIssueRef("999999"), facts: facts(), cwd: os.tmpdir() },
    { run: rec.runner, logError: (m) => logged.push(m) },
  );
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /`gh` exited 1/);
  assert.match((out as { error: string }).error, /Could not resolve to an Issue/);
  assert.equal(logged.length, 1, "silence is the failure mode #27 exists to end");
  assert.match(logged[0], /\[clanker\] issue comment for run 'codex-8b2b3' on #999999 FAILED/);
  assert.match(logged[0], /result\.md/, "the log still points the reader at the verdict");
});

test("#27: a missing `gh` binary is reported as itself, not swallowed", async () => {
  const logged: string[] = [];
  const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  const out = await postIssueComment(
    { ref: parseIssueRef("27"), facts: facts() },
    {
      run: () => Promise.reject(enoent),
      logError: (m) => logged.push(m),
    },
  );
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /spawn gh ENOENT/);
  assert.match(logged[0], /spawn gh ENOENT/);
});

test("#27: a `gh` that hangs is cut off by the hard ceiling instead of holding the terminal", async () => {
  const logged: string[] = [];
  const started = Date.now();
  const out = await postIssueComment(
    { ref: parseIssueRef("27"), facts: facts() },
    {
      // Never settles. The ceiling has to live in postIssueComment, not only
      // inside the default executor — an injectable dependency's timeout is a
      // timeout only for that one implementation.
      run: () => new Promise<GhResult>(() => {}),
      timeoutMs: 120,
      logError: (m) => logged.push(m),
    },
  );
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /did not return within 120ms/);
  assert.ok(Date.now() - started < 5_000, "the ceiling really fired");
  assert.equal(logged.length, 1);
});

test("#27: the ceiling is operator-overridable through the environment", async () => {
  const rec = recorder();
  await postIssueComment({ ref: parseIssueRef("27"), facts: facts() }, {
    run: rec.runner,
    env: { CLANKER_ISSUE_COMMENT_TIMEOUT_MS: "2500" },
  });
  assert.equal(rec.calls[0].timeoutMs, 2500);

  const rec2 = recorder();
  await postIssueComment({ ref: parseIssueRef("27"), facts: facts() }, {
    run: rec2.runner,
    env: { CLANKER_ISSUE_COMMENT_TIMEOUT_MS: "not-a-number" },
  });
  assert.equal(rec2.calls[0].timeoutMs, 10_000, "a junk override falls back to the documented default");
});

test("#27: the DEFAULT executor really runs `gh`, and a missing binary rejects", async () => {
  // The one test that exercises the production wiring rather than an injected
  // fake. Without it, every assertion above would hold equally well over a
  // module that never named `gh` at all.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-no-gh-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyDir;
  try {
    await assert.rejects(
      () => execFileGhRunner(["issue", "comment", "27", "--body-file", "/dev/null"], { timeoutMs: 5_000 }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        assert.match(String(error.message), /gh/);
        return true;
      },
    );
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. the wiring: a real dispatch, through the manager
// ---------------------------------------------------------------------------

function makeManager(ghRunner?: GhRunner, baseRepo = os.tmpdir()): LaneManager {
  return new LaneManager({ resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo, ghRunner });
}

test("#27: a terminal run posts exactly one comment carrying its real telemetry", async () => {
  const rec = recorder();
  const m = makeManager(rec.runner);
  try {
    const verdict = "F27-LIVE: the account writes itself";
    const { id } = await m.dispatchProfile({
      profile: "codex-review",
      prompt: verdict,
      cwd: os.tmpdir(),
      issue: "kckylechen1/Clanker#27",
    });
    await until(() => m.status(id).status !== "running");

    assert.equal(rec.calls.length, 1, "one terminal turn, one comment");
    const body = rec.calls[0].body;
    // The fake agent echoes its prompt back as the final message, so the
    // verdict text is the discriminator between "quoted the run" and "invented
    // something plausible".
    assert.ok(body.split("\n").includes(verdict), `verdict must be quoted verbatim:\n${body}`);
    assert.ok(body.includes(`\`${id}\``), "the run id names which dispatch this account is for");
    assert.ok(body.includes("codex / codex-review"), "and which seat shape produced it");
    assert.ok(body.includes(m.status(id).run_dir), "and where the whole evidence lives");
    assert.ok(body.includes("— done · turn 1"));
    assert.equal(m.status(id).telemetry?.issue_comment_error, undefined, "a landed comment records no error");
  } finally {
    await m.shutdown();
  }
});

test("#27: the first terminal wait says the comment is IN FLIGHT, never that it is fine", async () => {
  // The race a cold review landed: the terminal flip and the waiter wake are
  // synchronous, the post is a network call. A `gh` that fails a moment later
  // therefore produced a first wait payload with no `issue_comment_error` —
  // indistinguishable from a comment that landed. The dispatcher reads that
  // first payload as the account, so "not known yet" needed a spelling of its
  // own rather than a faster post: holding the terminal for the network is the
  // cost this repo already refused to pay once (PR #45).
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rec = recorder(async () => {
    await gate;
    return { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
  });
  const m = makeManager(rec.runner);
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "27" });
    await until(() => m.status(id).status !== "running");

    const first = await m.wait(id, 1);
    assert.equal(first.status, "done", "the run really is terminal by now");
    assert.equal(first.telemetry?.issue_comment_pending, true, "the first payload must say the account is not in yet");
    assert.equal(first.telemetry?.issue_comment_error, undefined, "…and must not have guessed an outcome");

    release();
    await until(() => m.status(id).telemetry?.issue_comment_pending === undefined);
    const settled = m.status(id).telemetry!;
    assert.match(settled.issue_comment_error!, /`gh` exited 1/, "the real outcome arrives, late but true");
    assert.equal(settled.issue_comment_pending, undefined, "and the two fields are never both present");
  } finally {
    release();
    await m.shutdown();
  }
});

test("#27: a correction turn does not inherit the previous turn's comment failure", async () => {
  // Second cold review, read off the source: `beginTurn()` cleared `error` and
  // `failureClass` but not `issueCommentError`, so a run whose turn-1 comment
  // failed carried that error into turn 2 — where the terminal flip raises
  // `issue_comment_pending`. The payload then said "the comment failed" (last
  // turn's fact) AND "the comment is unknown" (this turn's), which is both a
  // contract violation and two wrong answers.
  const failFirst = { code: 4, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
  let attempt = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rec = recorder(async () => {
    attempt += 1;
    if (attempt === 1) return failFirst;
    await gate; // hold turn 2's comment in flight so `pending` is observable
    return { code: 0, stdout: "", stderr: "" };
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-stale-"));
  const run = new LaneRun({
    id: "codex-stale-error",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: false,
    supervised: true,
    issueRef: parseIssueRef("27"),
    ghRunner: rec.runner,
  });
  try {
    run.beginTurn("first pass");
    await run.completeTurn();
    assert.match(run.telemetry().issue_comment_error!, /`gh` exited 4/, "turn 1's failure is recorded");

    run.reopenForResume();
    run.beginTurn("you drifted: only touch src/", true);
    assert.equal(run.telemetry().issue_comment_error, undefined, "a new turn does not owe the old turn's failure");

    const terminal = run.completeTurn();
    const midFlight = run.telemetry();
    assert.equal(midFlight.issue_comment_pending, true, "turn 2's comment is in flight");
    assert.equal(midFlight.issue_comment_error, undefined, "…and NOT accompanied by turn 1's stale error");
    release();
    await terminal;

    const settled = run.telemetry();
    assert.equal(settled.issue_comment_pending, undefined);
    assert.equal(settled.issue_comment_error, undefined, "turn 2's comment landed, so nothing is owed");
    assert.equal(rec.calls.length, 2);
  } finally {
    release();
    run.closeStreams();
  }
});

test("#27: a landed comment leaves NEITHER field set — silence means kept, only after the fact", async () => {
  const rec = recorder();
  const m = makeManager(rec.runner);
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "27" });
    await until(() => m.status(id).status !== "running");
    await until(() => m.status(id).telemetry?.issue_comment_pending === undefined);
    const t = m.status(id).telemetry!;
    assert.equal(t.issue_comment_error, undefined);
    assert.equal(t.issue_comment_pending, undefined);
    assert.equal(rec.calls.length, 1);
  } finally {
    await m.shutdown();
  }
});

test("#27: a dispatch with no issue invokes gh ZERO times", async () => {
  // Not "posts nothing useful" — invokes nothing at all. Bookkeeping is opt-in
  // and the server never guesses a ticket from the prompt or a branch name.
  const rec = recorder();
  const m = makeManager(rec.runner);
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "no ticket here #27 (in prose)", cwd: os.tmpdir() });
    await until(() => m.status(id).status !== "running");
    assert.equal(rec.calls.length, 0);
    assert.equal(m.status(id).telemetry?.issue_comment_error, undefined, "no ticket owed means no error either");
  } finally {
    await m.shutdown();
  }
});

test("#27: a failed comment lands in telemetry as issue_comment_error and the run still finishes", async () => {
  const rec = recorder({ code: 4, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" });
  const m = makeManager(rec.runner);
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "27" });
    await until(() => m.status(id).status !== "running");

    const status = m.status(id);
    assert.equal(status.status, "done", "bookkeeping never fails the dispatch it accounts for");
    assert.match(status.telemetry!.issue_comment_error!, /^#27: `gh` exited 4/);
    assert.match(status.telemetry!.issue_comment_error!, /Resource not accessible/);
    // Durable, not just in memory: the record outlives this process, which is
    // the whole point of writing it down instead of logging it.
    const onDisk = JSON.parse(fs.readFileSync(path.join(status.run_dir, "telemetry.json"), "utf8"));
    assert.match(onDisk.issue_comment_error, /`gh` exited 4/);
  } finally {
    await m.shutdown();
  }
});

// ---------------------------------------------------------------------------
// 6. the correction round is a SECOND comment, not an edit
// ---------------------------------------------------------------------------

function makeBaseRepo(): { base: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-comment-repo-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const base = path.join(root, "base");
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["clone", origin, base]);
  return { base, root };
}

test("#27: the second terminal transition APPENDS a turn-2 comment carrying the corrected verdict", async () => {
  // The ruling, spelled out: the ledger row is once per DISPATCH (it feeds
  // rates), result.md is once per TERMINAL TRANSITION and overwrites (a reader
  // must get the corrected verdict), and this is once per terminal transition
  // and APPENDS. "This run was corrected, and here is what changed" is exactly
  // the history the thread exists to preserve; editing the first comment would
  // erase the only durable evidence that a correction round happened.
  //
  // Driven on LaneRun directly so the two turns' MESSAGES differ: the
  // end-to-end test below runs a write profile, whose fake worker echoes the
  // server-prepended write-discipline preamble and therefore produces two
  // verdicts with an identical first ISSUE_COMMENT_VERDICT_BUDGET characters.
  const rec = recorder();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-correction-"));
  const run = new LaneRun({
    id: "oc-corrected",
    lane: "opencode",
    cwd: os.tmpdir(),
    runDir,
    readOnly: false,
    supervised: true,
    profileId: "oc-glm-write",
    issueRef: parseIssueRef("kckylechen1/Clanker#27"),
    ghRunner: rec.runner,
  });
  const say = (text: string) =>
    run.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never);

  run.beginTurn("implement the frozen spec");
  say("VERDICT ONE: shipped, but src/ was widened");
  await run.completeTurn();
  assert.equal(rec.calls.length, 1);

  run.reopenForResume();
  run.beginTurn("you drifted: only touch src/", true);
  say("VERDICT TWO: narrowed back to src/, as corrected");
  await run.completeTurn();

  assert.equal(rec.calls.length, 2, "the correction round is its own entry in the thread");
  const one = rec.calls[0].body;
  const two = rec.calls[1].body;
  assert.ok(one.includes("— done · turn 1"), one);
  assert.ok(two.includes("— done · turn 2"), two);
  assert.ok(two.includes("1 correction"), "and says it WAS a correction");
  assert.ok(one.split("\n").includes("VERDICT ONE: shipped, but src/ was widened"));
  assert.ok(two.split("\n").includes("VERDICT TWO: narrowed back to src/, as corrected"));
  assert.ok(
    !two.includes("VERDICT ONE"),
    "the second comment is the corrected verdict, not a restatement of the first",
  );
  // Both name the same run, so the thread reads as one dispatch's history.
  for (const call of rec.calls) {
    assert.deepEqual(call.args.slice(0, 2), ["issue", "comment"]);
    assert.ok(call.body.includes("`oc-corrected`"));
  }
  run.closeStreams();
});

test("#27: a corrected dispatch really files two comments end to end, turn 1 then turn 2", async () => {
  const rec = recorder();
  const repo = makeBaseRepo();
  const m = makeManager(rec.runner, repo.base);
  try {
    const { id } = await m.dispatchProfile({
      profile: "oc-glm-write",
      prompt: "implement the frozen spec",
      worktree: `clanker/issue-comment-${Math.random().toString(36).slice(2, 8)}`,
      issue: "27",
    });
    await until(() => m.status(id).status !== "running");
    assert.equal(rec.calls.length, 1);

    await m.promptExisting(id, "you drifted: only touch src/", true);
    await until(() => m.status(id).status !== "running");

    assert.equal(rec.calls.length, 2, "the correction round is its own entry in the thread");
    const first = rec.calls[0].body;
    const second = rec.calls[1].body;
    assert.ok(first.includes("· turn 1"), first);
    assert.ok(second.includes("· turn 2"), second);
    assert.ok(second.includes("1 correction"), "and says it WAS a correction");
    assert.ok(first.includes("opencode / oc-glm-write"), "the profile is named, not just the lane");
    // Both comments name the same run: the thread reads as one dispatch's history.
    assert.ok(first.includes(`\`${id}\``) && second.includes(`\`${id}\``));
    // And every one of them was still only ever a comment.
    for (const call of rec.calls) assert.deepEqual(call.args.slice(0, 2), ["issue", "comment"]);
    // One dispatch, one ledger row — the two dedup semantics coexist.
    const ledger = path.join(process.env.CLANKER_LEDGER_DIR ?? "", "ledger.jsonl");
    const rows = fs.existsSync(ledger)
      ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    assert.equal(rows.filter((r) => r.label === id).length, 1, "two comments, still exactly one ledger row");
  } finally {
    await m.shutdown();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("#27: a cancelled run still files its account", async () => {
  const rec = recorder();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-cancel-"));
  const run = new LaneRun({
    id: "codex-cancelled",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
    issueRef: parseIssueRef("27"),
    ghRunner: rec.runner,
  });
  run.beginTurn("do the thing");
  await run.cancelTurn();
  assert.equal(rec.calls.length, 1, "a cancellation is an outcome and belongs on the ticket");
  assert.ok(rec.calls[0].body.includes("— cancelled · turn 1"));
  run.closeStreams();
});

// ---------------------------------------------------------------------------
// 7. discrimination — each rule deleted, the matching assertion goes red
// ---------------------------------------------------------------------------

test("mutation: a permissive pattern lets a flag-shaped reference through", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-loose-pattern",
    [{
      file: "issue-comment.ts",
      find: "export const ISSUE_REF_PATTERN = /^(?:[\\w.-]+\\/[\\w.-]+#)?\\d+$/;",
      replace: "export const ISSUE_REF_PATTERN = /\\d+/;",
    }],
    "issue-comment.ts",
  );
  // Green build refuses it (asserted above); the mutant accepts it and would
  // hand `gh` a token it re-reads as a flag.
  assert.doesNotThrow(() => mutant.parseIssueRef("--repo=evil/repo#41"));
});

test("mutation: the local-file redactor at the public sink republishes the token it blanked", async () => {
  // The shipped bug, restored: one function serving both threat models. The
  // mutant is not "no redaction at all" — it is the redaction this module
  // actually had, which is why the discrimination matters.
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-local-redactor",
    [
      {
        file: "issue-comment.ts",
        find: 'import { createTimeout, errMessage, redactForPublic } from "./util.js";',
        replace: 'import { createTimeout, errMessage, redact, redactForPublic } from "./util.js";',
      },
      {
        file: "issue-comment.ts",
        find: "  const cleaned = redactForPublic(rawVerdict);",
        replace: "  const cleaned = redact(rawVerdict);\n  void redactForPublic;",
      },
    ],
    "issue-comment.ts",
  );
  const token = "ghp_1234567890abcdefghijklmnopqrstuvwx"; // synthetic — gitleaks:allow
  const { body, redacted } = mutant.buildIssueCommentBody(
    facts({ finalMessage: `Authorization: Bearer ${token}` }),
  );
  assert.equal(redacted, true, "the mutant still CLAIMS it redacted…");
  assert.ok(body.includes(token), "…while publishing the token — the green build must not");
});

test("mutation: a scheme-name list instead of the header's structure lets `Basic` through", async () => {
  // The bug the second review landed, reconstructed exactly: the rule knows
  // scheme NAMES rather than the header's shape, so the next scheme escapes.
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-scheme-list",
    [{
      file: "util.ts",
      // Only the SCHEME group is swapped for a name list; everything else about
      // the rule is left intact, so what the assertion below discriminates is
      // structure-vs-list and nothing else.
      find: "([A-Za-z][A-Za-z0-9._-]*)([ \\t]+)([^\\r\\n]+)/gi;",
      replace: "(bearer|token)([ \\t]+)([^\\r\\n]+)/gi;",
    }],
    "util.ts",
  );
  // This mutant briefly stopped discriminating when the key rule's value ran
  // to end of line — that rule then covered the plain `Basic` case as well, and
  // the overlap read as defence in depth. Narrowing the value back to one token
  // (the blast-radius fix) took the overlap away again, and correctly: on
  // `Authorization: Basic <blob>` the key rule can only blank the scheme word,
  // leaving the credential one token further along. So the header rule is once
  // more the only thing standing between this shape and the comment.
  const basic = Buffer.from("user:hunter2").toString("base64");
  const plain = mutant.redactForPublic(`Authorization: Basic ${basic}`);
  assert.ok(plain.includes(basic), `the mutant republishes the credential: ${plain}`);
  // And the quoted auth-param shape, which no other rule can reach at all.
  const digest = mutant.redactForPublic('Authorization: Digest response="deadbeefcafe1234"');
  assert.ok(digest.includes("deadbeefcafe1234"), `the mutant republishes the digest: ${digest}`);
});

test("mutation: a key rule that only reads the END of the token walks past four real shapes", async () => {
  // The shipped rule, restored: the credential word had to be the last thing
  // before the separator. Everything else about the rule is left alone, so
  // what this discriminates is exactly "whole token" versus "tail of token".
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-key-tail-only",
    [{
      file: "util.ts",
      find: "      !keyTokenWords(token).some((word) => PUBLIC_KEY_WORDS.has(word)) ||",
      replace: '      !PUBLIC_KEY_WORDS.has(token.split(/[-_.]/).pop()?.toLowerCase() ?? "") ||',
    }],
    "util.ts",
  );
  for (const [line, secret] of [
    ["X-Session-ID: abc123xyz", "abc123xyz"],
    ["session_id=abc123xyz", "abc123xyz"],
    ["auth_token_v2: hunter2word", "hunter2word"],
    ["X-Api-Key-Legacy: hunter2word", "hunter2word"],
  ] as const) {
    assert.ok(mutant.redactForPublic(line).includes(secret), `the mutant publishes ${line}`);
  }
  // …while still catching the shape it was built for, which is why it survived
  // three rounds of review before this one.
  assert.ok(!mutant.redactForPublic("X-Auth: hunter2").includes("hunter2"));
});

test("mutation: a key value that runs to end of line deletes the sentence after it", async () => {
  // The regression this rule shipped with for exactly one round: the value ran
  // to the end of the line, so a key-shaped word in prose took the diagnosis
  // with it. `redact()` — the rule this one replaced — never did that.
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-key-value-to-eol",
    [{
      file: "util.ts",
      find: '(["\']?[ \\t]*(?::(?!=)|=)[ \\t]*["\']?)((?:(?!\\[\\[)[^\\s\'"`&;])+)/gm;',
      replace: '(["\']?[ \\t]*(?::(?!=)|=)[ \\t]*["\']?)((?:(?!\\[\\[)[^\\r\\n\'"`])+)/gm;',
    }],
    "util.ts",
  );
  const out = mutant.redactForPublic("token: expired at noon");
  assert.ok(!out.includes("at noon"), `the mutant eats the whole sentence: ${out}`);
  assert.equal(out, "token: [REDACTED]");
});

test("mutation: a declined match that swallows its line hides the credential further along it", async () => {
  // Two mutants in one test because the two halves only work together: the
  // lead set has to admit `?`, and the scan has to resume inside a declined
  // match. Removing either one restores the miss.
  const noLead = await loadMutantModule<typeof import("../src/util.js")>(
    "util-key-no-url-lead",
    [{ file: "util.ts", find: "/(^|[\\s,{(\\[\"'?&;])", replace: "/(^|[\\s,{(\\[\"'])" }],
    "util.ts",
  );
  assert.ok(
    noLead.redactForPublic("https://api.x.com/v1?auth_token_v2=hunter2word").includes("hunter2word"),
    "without `?` in the lead set the query parameter is not even a key",
  );

  const noRewind = await loadMutantModule<typeof import("../src/util.js")>(
    "util-key-no-rewind",
    [{
      file: "util.ts",
      find: "      PUBLIC_KEY_ASSIGNMENT.lastIndex = match.index + lead.length + token.length;",
      replace: "      void lead;",
    }],
    "util.ts",
  );
  assert.ok(
    noRewind.redactForPublic("https://api.x.com/v1?auth_token_v2=hunter2word").includes("hunter2word"),
    "…and with the lead set but no rewind, `https:` consumes the line before the credential is examined",
  );
});

test("mutation: substring matching instead of words eats a verdict's own evidence", async () => {
  // The other way to close those four — match keywords anywhere in the token —
  // is the one that looks equivalent and is not.
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-key-substring",
    [{
      file: "util.ts",
      find: "      !keyTokenWords(token).some((word) => PUBLIC_KEY_WORDS.has(word)) ||",
      replace: "      ![...PUBLIC_KEY_WORDS].some((word) => token.toLowerCase().includes(word)) ||",
    }],
    "util.ts",
  );
  assert.ok(
    !mutant.redactForPublic("author: Kyle Chen").includes("Kyle Chen"),
    "the mutant reads `author` as `auth` and blanks a git log line — the green build must not",
  );
});

test("mutation: a constant park token lets worker text be overwritten by a header it never wrote", async () => {
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-constant-park-tag",
    [{
      file: "util.ts",
      find: "  const taken = new Set<string>();\n  for (const match of text.matchAll(/\\[\\[clanker-hdr(-\\d+)?:/g)) taken.add(match[1] ?? \"\");",
      replace: '  const taken = new Set<string>();\n  void text;',
    }],
    "util.ts",
  );
  const basic = Buffer.from("user:hunter2").toString("base64");
  const out = mutant.redactForPublic(`literal [[clanker-hdr:0]] plus Authorization: Basic ${basic}`);
  assert.ok(
    !out.startsWith("literal [[clanker-hdr:0]] plus"),
    `the mutant rewrites the worker's own text into a header it never wrote: ${out}`,
  );
});

test("mutation: 'an escaped quote is never the wrapper' republishes a header logged inside JSON", async () => {
  // The previous round's rule, restored: it treated any escaped quote as
  // never-the-closer, which is right when the opener is raw and wrong when the
  // opener is itself escaped — the JSON-log shape, where both are `\"`.
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-escape-blind-wrapper",
    [{
      file: "util.ts",
      find:
        "  const escapes = wrapper.length - 1;\n" +
        "  const quote = wrapper[wrapper.length - 1]!;",
      replace:
        "  const escapes = 0;\n" +
        "  const quote = wrapper[wrapper.length - 1]!;",
    }],
    "util.ts",
  );
  const basic = Buffer.from("user:hunter2").toString("base64");
  const out = mutant.redactForPublic(`{\\"Authorization\\": \\"Basic ${basic}\\", \\"Accept\\": \\"json\\"}`);
  // With `escapes` pinned to 0 the closer is never found at the right depth, so
  // the credentials run past the end of the JSON value and eat the rest of the
  // object — the header is mangled rather than redacted in place.
  assert.ok(!out.includes('\\"Accept\\"'), `the mutant ate the rest of the log line: ${out}`);
});

test("mutation: credentials that stop at the first quote republish the auth-param they were meant to eat", async () => {
  // The shipped shape: quotes excluded from the credential class, which is
  // right for `curl -H '…'` and wrong for every quoted auth-param list.
  const mutant = await loadMutantModule<typeof import("../src/util.js")>(
    "util-quote-stops-credentials",
    [{
      file: "util.ts",
      find: "  if (wrapper === \"\") return rest.length;",
      replace: "  if (wrapper === \"\") wrapper = '\"';",
    }],
    "util.ts",
  );
  const out = mutant.redactForPublic('Authorization: Digest username="alice", response="deadbeefcafe1234"');
  assert.ok(out.includes("deadbeefcafe1234"), `the mutant leaves the response hash in the comment: ${out}`);
});

test("mutation: a summarizing body stops carrying the verdict verbatim", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-summarize",
    [{
      file: "issue-comment.ts",
      find: "  const head = truncated ? cleaned.slice(0, ISSUE_COMMENT_VERDICT_BUDGET) : cleaned;",
      replace: "  const head = `the worker reported ${cleaned.split(/\\s+/).length} words of judgment`;",
    }],
    "issue-comment.ts",
  );
  const verdict = "VERDICT: BUG — do not merge.";
  const { body } = mutant.buildIssueCommentBody(facts({ finalMessage: verdict }));
  assert.ok(!body.split("\n").includes(verdict), "the mutant restates instead of quoting — the green build must not");
});

test("mutation: without the truncation notice a clipped verdict reads as a whole one", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-silent-truncation",
    [{
      file: "issue-comment.ts",
      find: "  if (truncated) {\n    lines.push(",
      replace: "  if (false) {\n    lines.push(",
    }],
    "issue-comment.ts",
  );
  const { body } = mutant.buildIssueCommentBody(facts({ finalMessage: "X".repeat(ISSUE_COMMENT_VERDICT_BUDGET + 137) }));
  assert.doesNotMatch(body, /truncated at/, "the mutant clips in silence");
});

test("mutation: a fixed-length fence lets the worker close the block and eat the notice", async () => {
  // The subtler half of the render-safety fix: fencing is not enough if the
  // fence is a constant. A worker whose verdict contains ``` closes a
  // three-backtick fence early, and everything the server appends lands back in
  // worker-controlled Markdown — exactly where it was before.
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-fixed-fence",
    [{
      file: "issue-comment.ts",
      find: '  return "`".repeat(Math.max(3, longest + 1));',
      replace: '  void longest;\n  return "```";',
    }],
    "issue-comment.ts",
  );
  const verdict = "```\n" + "X".repeat(ISSUE_COMMENT_VERDICT_BUDGET + 50);
  const { body } = mutant.buildIssueCommentBody(facts({ finalMessage: verdict }));
  // A renderer closes the block at the FIRST matching fence, not at the one the
  // server meant. So the honest measure is what actually stays inside.
  const lines = body.split("\n");
  const open = lines.indexOf("```");
  const rendererCloses = lines.indexOf("```", open + 1);
  const inside = lines.slice(open + 1, rendererCloses).join("\n");
  assert.ok(
    !inside.includes("X".repeat(50)),
    "the mutant's block ends at the worker's own fence, so the verdict — and everything after it — escapes back into worker Markdown",
  );
});

test("mutation: a dropped argv gate would let a state-changing subcommand through", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-no-argv-gate",
    [{
      file: "issue-comment.ts",
      find: "export function assertCommentOnlyArgs(args: readonly string[]): void {",
      replace: "export function assertCommentOnlyArgs(args: readonly string[]): void {\n  if (args) return;",
    }],
    "issue-comment.ts",
  );
  assert.doesNotThrow(() => mutant.assertCommentOnlyArgs(["issue", "close", "27"]));
});

test("mutation: an argv gate that never requires the body file lets a bodyless comment through", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-optional-body",
    [{
      file: "issue-comment.ts",
      find: '  if (!seen.has("--body-file")) {',
      replace: "  if (false as boolean) {",
    }],
    "issue-comment.ts",
  );
  // This is the shipped gate, restored: it inspects only what it was handed.
  assert.doesNotThrow(() => mutant.assertCommentOnlyArgs(["issue", "comment", "27"]));
});

test("mutation: a swallowed gh failure reports success and records nothing", async () => {
  const mutant = await loadMutantModule<typeof import("../src/issue-comment.js")>(
    "issue-comment-silent-failure",
    [{
      file: "issue-comment.ts",
      find: "  if (result.code !== 0) {",
      replace: "  if (false as boolean) {",
    }],
    "issue-comment.ts",
  );
  const logged: string[] = [];
  const out = await mutant.postIssueComment(
    { ref: mutant.parseIssueRef("27"), facts: facts() },
    { run: async () => ({ code: 7, stdout: "", stderr: "boom" }), logError: (m) => logged.push(m) },
  );
  assert.equal(out.ok, true, "the mutant calls a failed post a success");
  assert.equal(logged.length, 0, "…in total silence — the exact shape of #27 itself");
});

test("mutation: without the in-flight mark, the first terminal wait reads as a kept account", async () => {
  // The exact shape the cold review reproduced: no pending mark, so the first
  // payload of a run whose comment is about to fail is byte-identical to the
  // payload of a run whose comment landed.
  const mutant = await loadMutantManager("issue-comment-no-pending", [{
    file: "run.ts",
    find: "    if (this.issueRef) {\n      this.issueCommentPending = true;",
    replace: "    if (false as boolean) {\n      this.issueCommentPending = true;",
  }]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rec = recorder(async () => {
    await gate;
    return { code: 1, stdout: "", stderr: "HTTP 403" };
  });
  const m = new mutant.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), ghRunner: rec.runner,
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "27" });
    await until(() => m.status(id).status !== "running");
    const first = await m.wait(id, 1);
    assert.equal(first.telemetry?.issue_comment_pending, undefined, "the mutant admits nothing is in flight…");
    assert.equal(first.telemetry?.issue_comment_error, undefined, "…and reports no error either — a false clean bill");
  } finally {
    release();
    await m.shutdown();
  }
});

test("mutation: with the invariant kept at the turn entrances, the resume-setup path breaks it again", async () => {
  // The exact sequence a backend resume performs when its connect fails:
  // reopenForResume(), then straight into failTurn() — beginTurn() is never
  // reached. (The end-to-end version of this path, through a real cursor
  // resume with a missing binary, is in test/cursor-resume.test.ts; this one
  // pins WHERE the invariant is enforced.) The mutant keeps the entrance
  // clearing and removes the one in markTerminal, which is the shape that
  // shipped and the shape that lost.
  const mutant = await loadMutantModule<typeof import("../src/run.js")>(
    "run-invariant-at-entrances",
    [{
      file: "run.ts",
      find:
        "      this.issueCommentPending = true;\n" +
        "      // Only ever a PREVIOUS turn's error: this turn's is written after the\n" +
        "      // post settles, which is strictly later than this statement.\n" +
        "      this.issueCommentError = undefined;",
      replace: "      this.issueCommentPending = true;",
    }],
    "run.ts",
  );
  let attempt = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rec = recorder(async () => {
    if (++attempt === 1) return { code: 4, stdout: "", stderr: "HTTP 403" };
    await gate;
    return { code: 0, stdout: "", stderr: "" };
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-resume-mutant-"));
  const run = new mutant.LaneRun({
    id: "cursor-resume-mutant",
    lane: "cursor",
    cwd: os.tmpdir(),
    runDir,
    readOnly: true,
    issueRef: parseIssueRef("27"),
    ghRunner: rec.runner,
  });
  try {
    run.beginTurn("first pass");
    await run.completeTurn();
    assert.match(run.telemetry().issue_comment_error!, /`gh` exited 4/);

    run.reopenForResume();
    const terminal = run.failTurn("spawn cursor-agent ENOENT"); // no beginTurn: setup died first
    const midFlight = run.telemetry();
    assert.equal(midFlight.issue_comment_pending, true);
    assert.match(
      midFlight.issue_comment_error!,
      /`gh` exited 4/,
      "the mutant carries turn 1's failure into turn 2's pending — the second entry point to leak the same invariant",
    );
    release();
    await terminal;
  } finally {
    release();
    run.closeStreams();
  }
});

test("mutation: a running turn that keeps the previous turn's comment error answers for the wrong turn", async () => {
  // Re-aimed when the invariant moved into markTerminal(). Deleting the
  // entrance clearing no longer breaks "at most one" — markTerminal repairs it
  // at the flip — so what this line is still load-bearing FOR is the running
  // window: while turn 2 runs, `issue_comment_error` must not be answering
  // with turn 1's result. That is what the mutant loses, and all it loses.
  const mutant = await loadMutantModule<typeof import("../src/run.js")>(
    "run-stale-comment-error",
    [{
      file: "run.ts",
      find: "    this.issueCommentError = undefined;\n    this.issueCommentPending = false;\n    this.turnsCount += 1;",
      replace: "    this.turnsCount += 1;",
    }],
    "run.ts",
  );
  let attempt = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rec = recorder(async () => {
    attempt += 1;
    if (attempt === 1) return { code: 4, stdout: "", stderr: "HTTP 403" };
    await gate;
    return { code: 0, stdout: "", stderr: "" };
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-stale-mutant-"));
  const run = new mutant.LaneRun({
    id: "codex-stale-mutant",
    lane: "codex",
    cwd: os.tmpdir(),
    runDir,
    readOnly: false,
    supervised: true,
    issueRef: parseIssueRef("27"),
    ghRunner: rec.runner,
  });
  try {
    run.beginTurn("first pass");
    await run.completeTurn();
    run.reopenForResume();
    run.beginTurn("correction", true);
    // Turn 2 is RUNNING here — not terminal, so markTerminal has not repaired
    // anything yet, and the field is answering for a turn that is over.
    assert.equal(run.telemetry().issue_comment_pending, undefined, "no post is in flight during a running turn");
    assert.match(
      run.telemetry().issue_comment_error!,
      /`gh` exited 4/,
      "the mutant reports turn 1's comment failure as if it described the turn now running",
    );
    const terminal = run.completeTurn();
    release();
    await terminal;
  } finally {
    release();
    run.closeStreams();
  }
});

test("mutation: a terminal transition that skips the post leaves the ticket with no account", async () => {
  // Attacks the WIRING, not the module: run.ts's terminal tail is where the
  // account is actually owed, and a module that works perfectly while nobody
  // calls it is the failure this repo has shipped before (#19's bundles).
  const mutant = await loadMutantManager("issue-comment-unwired", [{
    file: "run.ts",
    find: "    this.writeLedgerRowOnce();\n    await this.postIssueCommentForTurn();\n  }\n\n  /**\n   * @param failureClass",
    replace: "    this.writeLedgerRowOnce();\n  }\n\n  /**\n   * @param failureClass",
  }]);
  const rec = recorder();
  const m = new mutant.LaneManager({
    resolveSpec: () => fakeSpec(), disableReaper: true, baseRepo: os.tmpdir(), ghRunner: rec.runner,
  });
  try {
    const { id } = await m.dispatchProfile({ profile: "codex-review", prompt: "review", cwd: os.tmpdir(), issue: "27" });
    await until(() => m.status(id).status !== "running");
    assert.equal(m.status(id).status, "done", "the mutant's run still finishes");
    assert.equal(rec.calls.length, 0, "…and files nothing, which the green build must not");
  } finally {
    await m.shutdown();
  }
});

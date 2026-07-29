/**
 * Issue-comment bookkeeping (#27) — the narrative half of the dispatch ledger.
 *
 * `~/.agents/dispatch-ledger/ledger.jsonl` (ledger.ts) is the STATISTICAL face
 * of a dispatch: one row, grep-consumed downstream, good for refix rates and
 * distillation. It cannot answer "what happened on this ticket, and why was the
 * fix ruled this way" — that answer has always lived in issue threads, and
 * until now it got there by a human hand-copying every verdict. Hand-copying
 * does not merely cost typing, it MISSES: PR #36 carried `Closes #17` in its
 * body, the automatic close never fired, and the ticket stayed open until
 * someone noticed at end of day.
 *
 * The server already holds every fact such a comment needs (telemetry.json:
 * lane, observed_model, duration, turns, tokens; result.md: the verdict). The
 * one missing input is WHICH TICKET a dispatch was run for, which is why
 * `issue` is a caller-supplied dispatch parameter and is never inferred from
 * the prompt text or a branch name: a guessed attribution writes a false
 * account onto someone else's ticket, which is strictly worse than no account.
 *
 * Three disciplines this module exists to keep, all of them load-bearing:
 *
 *  1. THE VERDICT IS QUOTED, NEVER RESTATED. `plugin/README.md` forbids every
 *     relay seat from restating `final_message` — "reproduce this verbatim" is
 *     the one instruction a language model cannot honor, so the verdict travels
 *     as a path and the reader reads the bytes. A server that summarized the
 *     verdict into an issue comment would be breaking, in code, the rule it
 *     imposes on its seats. So the head of the verdict is SLICED, and when the
 *     slice is short of the whole it says so and points at result.md.
 *
 *  2. FAILURE IS LOUD. #27 is itself a report of bookkeeping that died in
 *     silence, so a comment that could not be posted (no `gh`, no network, no
 *     permission, non-zero exit) is reported on stderr AND recorded in the
 *     run's telemetry as `issue_comment_error`. "No comment on the ticket"
 *     must never be indistinguishable from "no issue was named".
 *
 *  3. NOTHING BUT A COMMENT. `assertCommentOnlyArgs` rejects, in code, any argv
 *     that is not exactly `gh issue comment <n> [--repo R] --body-file F`.
 *     Closing a ticket is the act of a person who has read the diff (呈单即止);
 *     a server that could close one because a worker exited 0 would be
 *     automating away the judgment the whole ledger exists to record.
 *
 * The one deliberate deviation from byte-for-byte quoting is `redact()`: a
 * comment is the only artifact this server pushes to a REMOTE, possibly public
 * surface, and a worker that echoed `API_KEY=…` into its final message would
 * otherwise publish it. Redaction is announced in the comment when it fires, so
 * it is never a silent rewrite — the property the verbatim rule protects.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTimeout, errMessage, redact } from "./util.js";

/**
 * The accepted spellings of a ticket reference: a bare number for the repo the
 * dispatch runs in (`"41"`), or a fully qualified one (`"owner/repo#41"`).
 *
 * Anchored and deliberately narrow. `execFile` passes an argv array and never
 * goes through a shell, so this is not shell-injection defence; the hazard is
 * one argv position over. A value like `--repo` or `-R` handed to `gh` as a
 * positional is re-read as a FLAG, not as data — the same class of bug the
 * cursor lane already carries a guard for (`refuseFlagShapedToken`,
 * cursor-acp.ts). A pattern that cannot match a leading `-` closes it at the
 * source instead of at each call site.
 */
export const ISSUE_REF_PATTERN = /^(?:[\w.-]+\/[\w.-]+#)?\d+$/;

/** How much of the verdict a comment carries before it defers to result.md. */
export const ISSUE_COMMENT_VERDICT_BUDGET = 400;

/** Default hard ceiling on the whole `gh` call; `CLANKER_ISSUE_COMMENT_TIMEOUT_MS` overrides. */
export const ISSUE_COMMENT_TIMEOUT_MS = 10_000;

/** A parsed ticket reference. `repo` is present only when the caller qualified it. */
export interface IssueRef {
  /** Issue number, digits only. */
  readonly number: string;
  /** `owner/repo`, when the caller named one; otherwise the dispatch's own repo answers. */
  readonly repo?: string;
  /** Exactly what the caller wrote — quoted back in refusals so they can see their own input. */
  readonly raw: string;
}

/**
 * Parse and validate a caller-supplied `issue`, or refuse loudly.
 *
 * Refusal happens at DISPATCH time, alongside the `base` / `doNotTouch` shape
 * checks, and for the same reason: a parameter that cannot be honored has to be
 * rejected while the caller is still there to hear it. Discovering at terminal
 * time that the account cannot be written is discovering it too late — the run
 * has already cost its tokens, and its verdict now has nowhere to go.
 */
export function parseIssueRef(raw: string): IssueRef {
  const value = raw.trim();
  if (!ISSUE_REF_PATTERN.test(value)) {
    throw new Error(
      `issue '${raw}' is not a valid issue reference; expected a number ('41') or a qualified ` +
        `reference ('owner/repo#41'). It reaches \`gh\` as an argv token, so anything else is refused ` +
        `rather than guessed at.`,
    );
  }
  const hash = value.indexOf("#");
  if (hash === -1) return { number: value, raw };
  return { number: value.slice(hash + 1), repo: value.slice(0, hash), raw };
}

/** Everything a terminal run knows that belongs in its account of itself. */
export interface IssueCommentFacts {
  runId: string;
  /** Terminal status — `done` / `error` / `cancelled`. */
  status: string;
  /** 1-based turn number of the terminal turn that produced this comment. */
  turn: number;
  lane: string;
  /** Dispatch profile id (profiles.ts), when the run was started from one. */
  profileId?: string;
  /** What the backend said it was actually running (telemetry `observed_model`). */
  observedModel?: string | null;
  durationMs?: number;
  totalTokens?: number;
  retries?: number;
  corrections?: number;
  /** The run's own `final_message`, verbatim and untruncated. */
  finalMessage: string;
  /** Terminal error text, used as the body only when there is no final message. */
  error?: string;
  /** Absolute run directory. */
  runDir: string;
}

export interface BuiltComment {
  body: string;
  /** True when the verdict was longer than the budget and the body says so. */
  truncated: boolean;
  /** True when `redact()` changed the verdict and the body says so. */
  redacted: boolean;
}

/**
 * Render the comment body.
 *
 * Layout is header / metrics / verdict / pointer, in that order, because a
 * reader scanning a long issue thread needs the identity and the outcome in the
 * first line and the evidence path in the last. The verdict sits BETWEEN them,
 * unprefixed and unquoted: a `> ` blockquote or a fenced block would be a
 * transformation of the very bytes this comment exists to reproduce.
 */
export function buildIssueCommentBody(facts: IssueCommentFacts): BuiltComment {
  // An errored or cancelled turn frequently has no final message at all (the
  // worker died before saying anything). Falling back to the error text keeps
  // the comment from being an empty account of a run that definitely happened;
  // the `error:` label says which field is being shown, so the fallback is
  // never mistaken for a verdict the worker actually wrote.
  const source = facts.finalMessage.trim();
  const usingError = source === "" && !!facts.error?.trim();
  const rawVerdict = usingError ? facts.error!.trim() : source;

  const cleaned = redact(rawVerdict);
  const redacted = cleaned !== rawVerdict;
  const truncated = cleaned.length > ISSUE_COMMENT_VERDICT_BUDGET;
  const head = truncated ? cleaned.slice(0, ISSUE_COMMENT_VERDICT_BUDGET) : cleaned;

  const metrics = [
    facts.profileId ? `${facts.lane} / ${facts.profileId}` : facts.lane,
    facts.observedModel ? `observed \`${facts.observedModel}\`` : "observed model unreported",
    facts.durationMs !== undefined ? formatDuration(facts.durationMs) : undefined,
    `${facts.turn} turn${facts.turn === 1 ? "" : "s"}`,
    facts.totalTokens !== undefined ? formatTokens(facts.totalTokens) : undefined,
    facts.retries ? `${facts.retries} retry` : undefined,
    facts.corrections ? `${facts.corrections} correction${facts.corrections === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);

  const lines = [
    `🤖 clanker \`${facts.runId}\` — ${facts.status} · turn ${facts.turn}`,
    metrics.join(" · "),
    "",
    ...(usingError ? ["error:"] : []),
    head || "(the worker produced no final message)",
    "",
  ];
  if (truncated) {
    lines.push(
      `_verdict truncated at ${ISSUE_COMMENT_VERDICT_BUDGET} of ${cleaned.length} characters — ` +
        `full text in \`result.md\`._`,
    );
  }
  if (redacted) {
    lines.push("_secret-shaped values were redacted before posting; `result.md` holds the unredacted text._");
  }
  lines.push(`run_dir \`${facts.runDir}\` (verdict: \`result.md\`)`);
  return { body: lines.join("\n"), truncated, redacted };
}

/**
 * Build the exact argv — `gh issue comment <n> [--repo R] --body-file F` and
 * nothing else.
 *
 * A FILE, never `--body <text>`, and this is a finding rather than a taste:
 * the first live run against the real binary was refused outright (exit 64) by
 * the operator's own `gh` wrapper, which rejects inline body text because shell
 * expansion can corrupt Markdown before `gh` ever sees it. The file boundary is
 * independently the right shape anyway — a verdict is arbitrary worker output,
 * and putting it in argv means an ARG_MAX ceiling and the whole text visible in
 * every process listing on the machine.
 */
export function issueCommentArgs(ref: IssueRef, bodyFile: string): string[] {
  const args = ["issue", "comment", ref.number];
  if (ref.repo) args.push("--repo", ref.repo);
  args.push("--body-file", bodyFile);
  assertCommentOnlyArgs(args);
  return args;
}

/**
 * Refuse any argv that is not exactly a comment.
 *
 * This is a code gate rather than a test-only assertion on purpose. "The server
 * only comments, it never closes" is a promise about behaviour under future
 * edits, and the only version of that promise that survives an edit is one the
 * code itself checks. A denylist of dangerous subcommands would not do — so the
 * shape is validated structurally instead: fixed head, then flag/value pairs
 * drawn from a two-entry allowlist. Note that no argv position here can carry
 * worker text at all (the body travels as a file), so the gate never has to
 * make an exception for free-form content.
 */
export function assertCommentOnlyArgs(args: readonly string[]): void {
  const refuse = (why: string): never => {
    throw new Error(`Clanker: refusing to run \`gh ${args.slice(0, 3).join(" ")}\` — ${why}`);
  };
  if (args[0] !== "issue" || args[1] !== "comment") {
    refuse("only `gh issue comment` is permitted; changing an issue's state is a human's act, not a server's");
  }
  if (!/^\d+$/.test(args[2] ?? "")) refuse("the issue argument must be a bare number");
  const allowed = new Set(["--repo", "--body-file"]);
  for (let i = 3; i < args.length; i += 2) {
    if (!allowed.has(args[i])) refuse(`unexpected flag '${args[i]}' (allowed: ${[...allowed].join(", ")})`);
    if (i + 1 >= args.length) refuse(`flag '${args[i]}' has no value`);
  }
}

/** Result of one `gh` invocation, as the injectable executor reports it. */
export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The injectable executor. Its signature is the whole reason `gh` never runs in
 * a test: the module takes the process-spawning capability as an argument
 * instead of reaching for `child_process` at its call site, so a test can hand
 * it a function that records argv and returns a scripted result.
 */
export type GhRunner = (args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<GhResult>;

/**
 * Default executor: `gh`, argv array (never a shell), with its own kill timeout.
 *
 * `execFile` reports two different things through one `error` argument, and the
 * difference matters to the reader of the failure: a STRING `code` is a spawn
 * failure (`ENOENT` — `gh` is not on PATH at all; `EACCES`), which travels as a
 * rejection so its own message reaches the log intact, while a NUMBER `code` is
 * a real `gh` exit status (no network, no permission on the repo, no such
 * issue) whose stderr is the useful evidence and is therefore resolved, not
 * thrown.
 */
export const execFileGhRunner: GhRunner = (args, opts) =>
  new Promise<GhResult>((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });

export interface PostIssueCommentInput {
  ref: IssueRef;
  facts: IssueCommentFacts;
  /** Directory to run `gh` in, so a bare issue number resolves against the right repo. */
  cwd?: string;
}

export interface PostIssueCommentDeps {
  run?: GhRunner;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Injected so a test can assert on what was logged instead of on the console. */
  logError?: (message: string) => void;
}

/** Race sentinel for the hard ceiling below — distinct from any `GhResult`. */
const TIMED_OUT = Symbol("clanker.issue-comment.timeout");

/** `{ ok: true }`, or the reason nobody will find a comment on the ticket. */
export type PostIssueCommentOutcome = { ok: true; body: string } | { ok: false; error: string };

/**
 * Post one comment. NEVER throws and never rejects: bookkeeping must not be
 * able to fail a real dispatch (same contract as `appendLedgerRow` and
 * `writeResultFileOnce`). Every failure comes back as `{ ok: false }` with the
 * reason, is logged to stderr, and is recorded by the caller in telemetry.
 */
export async function postIssueComment(
  input: PostIssueCommentInput,
  deps: PostIssueCommentDeps = {},
): Promise<PostIssueCommentOutcome> {
  const runner = deps.run ?? execFileGhRunner;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const timeoutMs = resolveTimeoutMs(deps.timeoutMs, deps.env ?? process.env);
  const { body } = buildIssueCommentBody(input.facts);

  const fail = (rawReason: string): PostIssueCommentOutcome => {
    // Bounded: a spawn failure's own message quotes the whole command line, and
    // `gh`'s stderr can be long. Neither belongs in telemetry unabridged.
    const reason = rawReason.length > 500 ? `${rawReason.slice(0, 500)}…` : rawReason;
    const message =
      `[clanker] issue comment for run '${input.facts.runId}' on ${describeRef(input.ref)} FAILED: ${reason}. ` +
      `The run itself is unaffected; its verdict is in ${input.facts.runDir}/result.md.`;
    logError(message);
    return { ok: false, error: reason };
  };

  // The body travels as a FILE (see issueCommentArgs). Written under the OS
  // temp root rather than into the run directory on purpose: `retention.ts`
  // and the foreign-run scan both read a run directory by its known member
  // names, and a new permanent file there would be a change to that contract
  // for something that is pure transport.
  let scratch: string;
  let bodyFile: string;
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-issue-comment-"));
    bodyFile = path.join(scratch, "body.md");
    fs.writeFileSync(bodyFile, body);
  } catch (error) {
    return fail(`could not stage the comment body: ${errMessage(error)}`);
  }

  try {
    let args: string[];
    try {
      args = issueCommentArgs(input.ref, bodyFile);
    } catch (error) {
      return fail(errMessage(error));
    }

    // The hard ceiling is enforced HERE, not only inside the default executor:
    // the executor is injectable, and a cap that lives in one implementation of
    // an injectable dependency is a cap the other implementations do not have.
    // Terminal handling waits on this promise, so "the runner hung" has to be a
    // bounded outcome rather than a bounded-in-practice one.
    const timer = createTimeout(timeoutMs);
    let result: GhResult | typeof TIMED_OUT;
    try {
      result = await Promise.race<GhResult | typeof TIMED_OUT>([
        runner(args, { cwd: existingDir(input.cwd), timeoutMs }),
        timer.promise.then(() => TIMED_OUT),
      ]);
    } catch (error) {
      return fail(errMessage(error));
    } finally {
      timer.cancel();
    }

    if (result === TIMED_OUT) return fail(`\`gh\` did not return within ${timeoutMs}ms`);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-400) || "(no output)";
      return fail(`\`gh\` exited ${result.code}: ${detail}`);
    }
    return { ok: true, body };
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best-effort: a stranded temp body is not worth failing an account over */
    }
  }
}

/** `#41` or `owner/repo#41` — how a refusal names the ticket it could not reach. */
export function describeRef(ref: IssueRef): string {
  return ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

function resolveTimeoutMs(explicit: number | undefined, env: Record<string, string | undefined>): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = env.CLANKER_ISSUE_COMMENT_TIMEOUT_MS?.trim();
  if (!raw) return ISSUE_COMMENT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ISSUE_COMMENT_TIMEOUT_MS;
}

/**
 * A write run's dispatch cwd is its worktree, and the terminal path removes a
 * clean worktree BEFORE the status flip that triggers this comment — so the
 * directory `gh` would inherit may no longer exist by now, and spawning into a
 * missing cwd fails with a bare ENOENT that reads like "gh is not installed".
 * Falling back to the server's own cwd keeps a qualified `owner/repo#41` working
 * regardless; a bare number in that situation fails with `gh`'s own message
 * about not finding a repository, which is the truthful error.
 */
function existingDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatTokens(total: number): string {
  if (total < 1000) return `${total} tok`;
  return `${(total / 1000).toFixed(1)}k tok`;
}

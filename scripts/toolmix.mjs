#!/usr/bin/env node
/**
 * What the agents actually did, and what it cost to ask them.
 *
 * The workbench spends most of its money re-sending context, not reading files, so
 * the number that matters is turns rather than bytes. This prints both, per stage,
 * from the two records that already exist:
 *
 * - the board's event log — every tool call the guard saw, including the refused ones,
 *   and what each stage cost. Authoritative for *which* tools a stage reaches for, and
 *   the only place a refusal is written down.
 * - `~/.claude/projects/**\/*.jsonl` — the SDK's own transcripts. The only place that
 *   knows about turns and token usage, which the event log does not record.
 *
 * A transcript is joined to its run by session id, which the event log records for
 * every run since `session_started` was written for all of them. Older runs have none,
 * so those fall back to the ticket, the opening line of the brief — `agents/<stage>.md`'s
 * first line, distinct per stage — and the nearest start time.
 *
 * Read-only. Run it before a change and after, and compare.
 *
 *   node scripts/toolmix.mjs                          the board this directory is in
 *   node scripts/toolmix.mjs ../mimi ../family_tree   several boards, each on its own
 *   node scripts/toolmix.mjs --since t45              one board, cut in two at a ticket
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects');
const STAGES = ['plan', 'implement', 'review', 'verify'];

/** What `src/config.ts` calls these, and where it puts them when a board does not say. */
const CONFIG_FILE = 'workbench.config.json';
const HOME_DIR = '.workbench';

/**
 * How a transcript says which stage it is, when no session id says so. These are the
 * opening words of each `agents/<stage>.md`, and the brief puts the instructions first.
 * Editing an agent file's first line breaks this fallback, which is why an unmatched
 * transcript is counted and reported rather than dropped quietly.
 */
const OPENINGS = [
  ['plan', 'You are the planning stage'],
  ['implement', 'You are the implementation stage'],
  ['review', 'You are the adversarial review'],
  ['verify', 'You are the verification stage'],
];

/** How far a transcript's first record may be from its run's start and still be it. */
const FALLBACK_WINDOW_MS = 10 * 60_000;

/**
 * What a token costs relative to a fresh input token. Cache reads are a tenth, so a
 * headline "context re-sent" figure counted raw overstates the bill roughly tenfold —
 * both are printed rather than picking one and being wrong quietly.
 */
const PRICE = { input: 1, cacheRead: 0.1, cacheWrite: 1.25 };

const args = parseArgv(process.argv.slice(2));

function parseArgv(argv) {
  const dirs = [];
  let since = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--since') {
      dirs.push(argv[i]);
      continue;
    }
    const given = argv[++i] ?? '';
    since = Number.parseInt(given.replace(/^t/, ''), 10);
    if (!Number.isInteger(since)) fail(`--since wants a ticket, like --since t45 (got "${given}")`);
  }
  // Ticket numbers are per board: t45 on one is nothing to do with t45 on another.
  if (since !== null && dirs.length > 1) fail('--since cuts one board; name one, or none');
  return { dirs: dirs.length > 0 ? dirs : [process.cwd()], since };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Where a board lives, from a directory in or above it — the same walk `wb` makes, so
 * this reads the board that `wb list` run from the same place would talk to.
 */
function findHome(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (fs.existsSync(path.join(dir, HOME_DIR, CONFIG_FILE))) return path.join(dir, HOME_DIR);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The event log and the worktree root, resolved against the home as `loadConfig` does. */
function boardAt(home) {
  const config = JSON.parse(fs.readFileSync(path.join(home, CONFIG_FILE), 'utf8'));
  return {
    home,
    repoRoot: path.resolve(home, config.repoRoot ?? '..'),
    name: path.basename(path.resolve(home, config.repoRoot ?? '..')),
    db: path.resolve(home, config.dbPath ?? 'data/workbench.db'),
    worktreeRoot: path.resolve(home, config.worktreeRoot ?? '.worktrees'),
  };
}

function main() {
  for (const dir of args.dirs) {
    const home = findHome(dir);
    if (home === null) {
      console.error(`no workbench in or above ${path.resolve(dir)}`);
      process.exitCode = 1;
      continue;
    }
    const board = boardAt(home);
    if (!fs.existsSync(board.db)) {
      console.error(`no event log at ${board.db}`);
      process.exitCode = 1;
      continue;
    }
    report(board);
  }

  console.log(
    `\n  (cache reads at ${PRICE.cacheRead}x — the raw figure is the one that flatters a change)`,
  );
  if (args.since === null) console.log('  Compare two periods with: --since t45');
  console.log();
}

function report(board) {
  const runs = runsFrom(board.db);
  const join = joinTranscripts(board, runs);
  const sides = args.since === null ? ['all'] : ['before', 'since'];

  for (const which of sides) {
    const label =
      which === 'all'
        ? 'EVERY RUN'
        : which === 'before'
          ? `BEFORE t${args.since}`
          : `t${args.since} ONWARDS`;
    const mine = [...runs.values()].filter((r) => side(r.ticket) === which);

    console.log(`\n${'='.repeat(78)}\n${board.name} — ${label}\n${board.db}\n${'='.repeat(78)}`);

    console.log('\nTOOL MIX — from the event log (every call the guard saw)\n');
    for (const stage of STAGES) {
      const mix = new Map();
      for (const r of mine.filter((r) => r.stage === stage)) {
        for (const [tool, seen] of r.tools) {
          const into = mix.get(tool) ?? { calls: 0, refused: 0 };
          into.calls += seen.calls;
          into.refused += seen.refused;
          mix.set(tool, into);
        }
      }
      const total = [...mix.values()].reduce((a, b) => a + b.calls, 0);
      if (total === 0) continue;
      console.log(`  ${stage}  (${total} calls)`);
      for (const [tool, { calls, refused }] of [...mix].sort((a, b) => b[1].calls - a[1].calls)) {
        const share = `${Math.round((100 * calls) / total)}%`.padStart(4);
        const no = refused > 0 ? `  ${refused} refused` : '';
        console.log(`    ${String(calls).padStart(5)} ${share}  ${tool}${no}`);
      }
      console.log();
    }

    console.log('TURNS AND CONTEXT — from the SDK transcripts\n');
    console.log(
      '  stage        runs  $/run  turns  calls  calls/run  calls/turn  solo%  median ctx  p90 ctx',
    );
    const all = blank();
    for (const stage of STAGES) {
      // Runs with turns, so a board whose early transcripts are gone is not averaged
      // over runs this report cannot see into.
      const s = { ...blank(), joined: 0 };
      for (const r of mine.filter((r) => r.stage === stage)) {
        s.runs += 1;
        s.cost += r.costUsd;
        if (r.turns.length > 0) s.joined += 1;
        for (const turn of r.turns) add(s, turn);
      }
      if (s.runs === 0) continue;
      all.cost += s.cost;
      all.runs += s.runs;
      for (const key of ['turns', 'calls', 'toolTurns', 'soloTurns', 'billed']) all[key] += s[key];
      all.ctx.push(...s.ctx);
      console.log(
        '  ' +
          stage.padEnd(12) +
          String(s.runs).padStart(4) +
          (s.cost / s.runs).toFixed(2).padStart(7) +
          String(s.turns).padStart(7) +
          String(s.calls).padStart(7) +
          (s.calls / Math.max(s.joined, 1)).toFixed(1).padStart(11) +
          (s.calls / Math.max(s.toolTurns, 1)).toFixed(2).padStart(12) +
          `${Math.round((100 * s.soloTurns) / Math.max(s.toolTurns, 1))}%`.padStart(7) +
          k(pct(s.ctx, 0.5)).padStart(12) +
          k(pct(s.ctx, 0.9)).padStart(9),
      );
    }

    const raw = all.ctx.reduce((a, b) => a + b, 0);
    const models = new Map();
    for (const r of mine) for (const [m, n] of r.models) models.set(m, (models.get(m) ?? 0) + n);
    const unjoined = mine.filter((r) => r.turns.length === 0).length;

    console.log(`\n  spent                     $${all.cost.toFixed(2)} over ${all.runs} runs`);
    console.log(`  context re-sent, raw      ${k(raw)} tokens over ${all.ctx.length} turns`);
    console.log(`  context re-sent, billed   ${k(all.billed)} input-token equivalents`);
    console.log(
      `  models, by turns          ${[...models].map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}`,
    );
    if (unjoined > 0) {
      console.log(
        `  ${unjoined} of ${mine.length} runs have no transcript — their turns are not counted above`,
      );
    }
  }

  if (join.unmatched > 0) {
    console.log(`\n  ${join.unmatched} transcript(s) matched no run — the join may be stale`);
  }
}

/** Which side of the cut a ticket falls, or 'all' when no cut was asked for. */
function side(ticketId) {
  if (args.since === null) return 'all';
  const n = Number.parseInt(String(ticketId).replace(/^t/, ''), 10);
  if (!Number.isInteger(n)) return 'before';
  return n >= args.since ? 'since' : 'before';
}

/** Every stage run the log knows, with its tool calls, its cost and its session ids. */
function runsFrom(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('select ticket_id, at, body from events order by id').all();
  const runs = new Map();

  for (const row of rows) {
    const e = JSON.parse(row.body);
    if (e.type === 'stage_started') {
      runs.set(e.runId, {
        ticket: row.ticket_id,
        stage: e.stage,
        startedAt: Date.parse(row.at),
        tools: new Map(),
        sessions: new Set(),
        costUsd: 0,
        turns: [],
        models: new Map(),
      });
      continue;
    }
    const run = runs.get(e.runId);
    if (run === undefined) continue;

    if (e.type === 'tool_requested') {
      const seen = run.tools.get(e.tool) ?? { calls: 0, refused: 0 };
      seen.calls += 1;
      if (e.allowed === false) seen.refused += 1;
      run.tools.set(e.tool, seen);
    }
    if (typeof e.sessionId === 'string') run.sessions.add(e.sessionId);
    if (e.type === 'stage_finished') run.costUsd = e.costUsd ?? 0;
  }
  return runs;
}

/**
 * Attach every transcript under the board's worktrees to the run that wrote it. A run
 * that asked a question and was resumed can own more than one; each adds its turns.
 *
 * Session ids first, for every file, and only then the fallback — so a guess can never
 * take a run that a later file would have claimed outright. A worktree also holds
 * sessions that are not stages at all (chat, name checks); those open on no stage's
 * brief and are passed over rather than counted as a failed join.
 */
function joinTranscripts(board, runs) {
  const bySession = new Map();
  for (const run of runs.values()) for (const s of run.sessions) bySession.set(s, run);

  const attach = (run, records) => {
    for (const turn of turnsIn(records)) {
      run.turns.push(turn);
      run.models.set(turn.model, (run.models.get(turn.model) ?? 0) + 1);
    }
  };

  const unclaimed = [];
  for (const { file, ticket } of transcriptsOf(board)) {
    const records = readRecords(file);
    const run = bySession.get(path.basename(file, '.jsonl'));
    if (run === undefined) unclaimed.push({ ticket, records });
    else attach(run, records);
  }

  let unmatched = 0;
  for (const { ticket, records } of unclaimed) {
    const stage = stageOfTranscript(records);
    if (stage === null) continue;
    const run = nearestRun(runs, ticket, stage, records);
    if (run === undefined) unmatched += 1;
    else attach(run, records);
  }
  return { unmatched };
}

/** The fallback join: same ticket, same stage, the closest start that has no turns yet. */
function nearestRun(runs, ticket, stage, records) {
  const first = Date.parse(records.find((r) => r.timestamp)?.timestamp ?? '');
  if (Number.isNaN(first)) return undefined;

  let best;
  let distance = FALLBACK_WINDOW_MS;
  for (const run of runs.values()) {
    if (run.ticket !== ticket || run.stage !== stage || run.turns.length > 0) continue;
    const d = Math.abs(run.startedAt - first);
    if (d < distance) [best, distance] = [run, d];
  }
  return best;
}

function readRecords(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a half-written last line while a run is live
      }
    });
}

/**
 * One round trip to the model, from the several records the transcript writes for it.
 *
 * A transcript stores one record per *content block*, all sharing a `requestId` and all
 * carrying a copy of the same `usage`. Counted per record, every turn looks like it made
 * exactly one tool call and the context appears several times over — which is the whole
 * measurement, wrong in the flattering direction.
 */
function turnsIn(records) {
  const byRequest = new Map();

  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const usage = r.message?.usage;
    if (!usage) continue;

    // A missing requestId would collapse every such record into one turn, so those
    // fall back to their own identity rather than being merged with strangers.
    const id = r.requestId ?? r.message?.id ?? r.uuid;
    if (!byRequest.has(id)) {
      byRequest.set(id, {
        calls: 0,
        model: r.message.model ?? 'unknown',
        ctx:
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        billed:
          (usage.input_tokens ?? 0) * PRICE.input +
          (usage.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
          (usage.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite,
      });
    }
    byRequest.get(id).calls += (r.message.content ?? []).filter(
      (b) => b?.type === 'tool_use',
    ).length;
  }

  return [...byRequest.values()];
}

/** Which stage wrote this transcript, by the opening line of the brief it was sent. */
function stageOfTranscript(records) {
  const first = records.find((r) => r.type === 'user');
  const content = first?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
        : '';

  for (const [stage, opening] of OPENINGS) if (text.startsWith(opening)) return stage;
  return null;
}

/**
 * Every session file this board's worktrees produced, with the ticket it belongs to.
 * The SDK keys its transcripts by working directory, written with every character that
 * is not a letter or digit as '-', and a stage's working directory is its ticket's
 * worktree — so the directory name is the worktree root, then the ticket.
 *
 * `<repo>/workbench/.worktrees` too: where a board kept its worktrees before boards
 * moved into `.workbench/`, and where a long-running board's early tickets still are.
 */
function transcriptsOf(board) {
  if (!fs.existsSync(TRANSCRIPTS)) return [];
  const roots = [board.worktreeRoot, path.join(board.repoRoot, 'workbench', '.worktrees')];
  const prefixes = [...new Set(roots.map((r) => r.replace(/[^A-Za-z0-9]/g, '-') + '-'))];

  return fs.readdirSync(TRANSCRIPTS).flatMap((d) => {
    const prefix = prefixes.find((p) => d.startsWith(p));
    if (prefix === undefined) return [];
    const ticket = /^(t\d+)$/.exec(d.slice(prefix.length));
    if (ticket === null) return [];
    const dir = path.join(TRANSCRIPTS, d);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: path.join(dir, f), ticket: ticket[1] }));
  });
}

function blank() {
  return { runs: 0, cost: 0, turns: 0, calls: 0, toolTurns: 0, soloTurns: 0, ctx: [], billed: 0 };
}

function add(into, turn) {
  into.turns += 1;
  into.calls += turn.calls;
  into.ctx.push(turn.ctx);
  into.billed += turn.billed;
  if (turn.calls > 0) into.toolTurns += 1;
  if (turn.calls === 1) into.soloTurns += 1;
}

function pct(xs, p) {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function k(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

main();

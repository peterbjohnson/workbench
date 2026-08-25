#!/usr/bin/env node
/**
 * What the agents actually did, and what it cost to ask them.
 *
 * The workbench spends most of its money re-sending context, not reading files, so
 * the number that matters is turns rather than bytes. This prints both, per stage,
 * from the two records that already exist:
 *
 * - `data/workbench.db` — every tool call the guard saw, including the refused ones.
 *   Authoritative for *which* tools a stage reaches for, and the only place a refusal
 *   is written down.
 * - `~/.claude/projects/**\/*.jsonl` — the SDK's own transcripts. The only place that
 *   knows about turns and token usage, which the event log does not record.
 *
 * Nothing joins those two by id: `sessionId` is kept only when a run is resumable
 * (`runStage.ts`), so 12 of 233 runs have one. A transcript is matched to its stage
 * by the opening line of its brief instead, which is `agents/<stage>.md`'s first line
 * and is distinct per stage.
 *
 * Read-only. Run it before a change and after, and compare.
 *
 *   node scripts/toolmix.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const WORKBENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(WORKBENCH, 'data', 'workbench.db');
const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects');

/**
 * How a transcript says which stage it is. These are the opening words of each
 * `agents/<stage>.md`, and the brief puts the instructions first — so the first user
 * message names the stage. Editing an agent file's first line breaks this join, which
 * is why an unmatched transcript is counted and reported rather than dropped quietly.
 */
const OPENINGS = [
  ['plan', 'You are the planning stage'],
  ['implement', 'You are the implementation stage'],
  ['review', 'You are the adversarial review'],
  ['verify', 'You are the verification stage'],
];

/**
 * What a token costs relative to a fresh input token. Cache reads are a tenth, so a
 * headline "context re-sent" figure counted raw overstates the bill roughly tenfold —
 * both are printed rather than picking one and being wrong quietly.
 */
const PRICE = { input: 1, cacheRead: 0.1, cacheWrite: 1.25 };

/**
 * Where to cut the corpus in two, as a ticket number: `--since t45`.
 *
 * Without this the report is one average over every run there has ever been, and a
 * change to the tools cannot be seen in it — two new runs against two hundred old ones
 * move the mean by nothing. The whole strategy is measure, change, measure again, so
 * the report has to be able to answer "did that help".
 */
const since = sinceFromArgv();

function sinceFromArgv() {
  const at = process.argv.indexOf('--since');
  if (at === -1) return null;
  const given = process.argv[at + 1] ?? '';
  const n = Number.parseInt(given.replace(/^t/, ''), 10);
  if (!Number.isInteger(n)) {
    console.error(`--since wants a ticket, like --since t45 (got "${given}")`);
    process.exit(1);
  }
  return n;
}

/** Which side of the cut a ticket falls, or 'all' when no cut was asked for. */
function side(ticketId) {
  if (since === null) return 'all';
  const n = Number.parseInt(String(ticketId).replace(/^t/, ''), 10);
  if (!Number.isInteger(n)) return 'before';
  return n >= since ? 'since' : 'before';
}

function main() {
  const fromEvents = toolMixByStage();
  const fromTranscripts = turnsByStage();

  const sides = since === null ? ['all'] : ['before', 'since'];

  for (const which of sides) {
    const label =
      which === 'all' ? 'EVERY RUN' : which === 'before' ? `BEFORE t${since}` : `t${since} ONWARDS`;

    console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);

    console.log('\nTOOL MIX — from the event log (every call the guard saw)\n');
    for (const stage of ['plan', 'implement', 'review', 'verify']) {
      const mix = fromEvents.get(`${which}|${stage}`);
      if (!mix) continue;
      const total = [...mix.values()].reduce((a, b) => a + b.calls, 0);
      console.log(`  ${stage}  (${total} calls)`);
      for (const [tool, { calls, refused }] of [...mix].sort((a, b) => b[1].calls - a[1].calls)) {
        const share = `${Math.round((100 * calls) / total)}%`.padStart(4);
        const no = refused > 0 ? `  ${refused} refused` : '';
        console.log(`    ${String(calls).padStart(5)} ${share}  ${tool}${no}`);
      }
      console.log();
    }

    console.log('TURNS AND CONTEXT — from the SDK transcripts\n');
    console.log('  stage        runs  turns  calls  calls/run  calls/turn  solo%   median ctx');
    for (const [stage, s] of fromTranscripts.rows(which)) {
      console.log(
        '  ' +
          stage.padEnd(12) +
          String(s.runs).padStart(4) +
          String(s.turns).padStart(7) +
          String(s.calls).padStart(7) +
          (s.calls / Math.max(s.runs, 1)).toFixed(1).padStart(11) +
          (s.calls / Math.max(s.toolTurns, 1)).toFixed(2).padStart(12) +
          `${Math.round((100 * s.soloTurns) / Math.max(s.toolTurns, 1))}%`.padStart(7) +
          k(median(s.ctx)).padStart(13),
      );
    }

    const all = fromTranscripts.all(which);
    const raw = all.ctx.reduce((a, b) => a + b, 0);
    console.log(`\n  context re-sent, raw      ${k(raw)} tokens over ${all.ctx.length} turns`);
    console.log(`  context re-sent, billed   ${k(all.billed)} input-token equivalents`);
  }

  console.log(
    `\n  (cache reads at ${PRICE.cacheRead}x — the raw figure is the one that flatters a change)`,
  );
  if (since === null) {
    console.log('  Compare two periods with: node scripts/toolmix.mjs --since t45');
  }
  if (fromTranscripts.unmatched > 0) {
    console.log(
      `  ${fromTranscripts.unmatched} transcript(s) matched no stage opening — join may be stale`,
    );
  }
  console.log();
}

/** Per stage, how often each tool was asked for and how often it was refused. */
function toolMixByStage() {
  if (!fs.existsSync(DB)) {
    console.error(`no event log at ${DB}`);
    return new Map();
  }
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('select ticket_id, body from events order by id').all();

  const stageOf = new Map();
  const mix = new Map();

  for (const row of rows) {
    const e = JSON.parse(row.body);
    if (e.type === 'stage_started') stageOf.set(e.runId, e.stage);
    if (e.type !== 'tool_requested') continue;

    const stage = stageOf.get(e.runId);
    if (stage === undefined) continue;

    const key = `${side(row.ticket_id)}|${stage}`;
    if (!mix.has(key)) mix.set(key, new Map());
    const tools = mix.get(key);
    const seen = tools.get(e.tool) ?? { calls: 0, refused: 0 };
    seen.calls += 1;
    if (e.allowed === false) seen.refused += 1;
    tools.set(e.tool, seen);
  }
  return mix;
}

/**
 * Per stage, the turns those calls were spread over and the context each one carried.
 * A turn with two tool calls costs one round trip; a turn with one costs the same, and
 * that difference is the whole reason this script exists.
 */
function turnsByStage() {
  const blank = () => ({
    runs: 0,
    turns: 0,
    calls: 0,
    toolTurns: 0,
    soloTurns: 0,
    ctx: [],
    billed: 0,
  });
  /** Keyed `<side>|<stage>`, plus `<side>|` for that side's total. */
  const buckets = new Map();
  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, blank());
    return buckets.get(key);
  };
  let unmatched = 0;

  for (const { file, ticketId } of transcripts()) {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    const records = lines.flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a half-written last line while a run is live
      }
    });

    const stage = stageOfTranscript(records);
    if (stage === null) {
      unmatched += 1;
      continue;
    }

    const which = side(ticketId);
    const s = bucket(`${which}|${stage}`);
    const total = bucket(`${which}|`);
    s.runs += 1;
    total.runs += 1;

    for (const turn of turnsIn(records)) {
      for (const into of [s, total]) {
        into.turns += 1;
        into.calls += turn.calls;
        into.ctx.push(turn.ctx);
        into.billed += turn.billed;
        if (turn.calls > 0) into.toolTurns += 1;
        if (turn.calls === 1) into.soloTurns += 1;
      }
    }
  }

  return {
    rows: (which) =>
      ['plan', 'implement', 'review', 'verify']
        .map((stage) => [stage, buckets.get(`${which}|${stage}`)])
        .filter(([, s]) => s !== undefined && s.runs > 0),
    all: (which) => buckets.get(`${which}|`) ?? blank(),
    unmatched,
  };
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
 * Every session file the workbench's own worktrees produced, with the ticket it
 * belongs to — which is in the directory name, since the SDK keys its transcripts by
 * the working directory and that is the ticket's worktree.
 */
function transcripts() {
  if (!fs.existsSync(TRANSCRIPTS)) return [];
  return fs.readdirSync(TRANSCRIPTS).flatMap((d) => {
    const ticket = /workbench--worktrees-(t\d+)$/.exec(d);
    if (ticket === null) return [];
    const dir = path.join(TRANSCRIPTS, d);
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: path.join(dir, f), ticketId: ticket[1] }));
  });
}

const median = (xs) => pct(xs, 0.5);

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

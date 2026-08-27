import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * How one turn ended: the same four fields a cold attempt in `chat.ts` ends with, so
 * a turn served by a living process and one served by a fresh spawn are read alike.
 */
export type LiveTurn = {
  text: string;
  costUsd: number;
  sessionId?: string;
  failed?: string;
  /**
   * The turn ended on `maxTurns` or `maxBudgetUsd`. Both bound a `query()`, and a
   * living process's query is the whole conversation rather than one turn of it, so
   * these are not this turn being too big — they are the conversation having used up
   * an allowance written for a single turn. Told apart from every other ending
   * because it is the one the caller should go cold on however much it spent.
   */
  capped?: boolean;
};

export type LiveChats = {
  /**
   * One turn down the process standing for `key`, or `undefined` when there is none
   * that can serve it — nothing standing, another ticket's, or one mid-turn. The
   * caller then spawns its own, which is what every turn used to do.
   *
   * `prompt` is asked what to say once it is known which it is talking to: a process
   * that has answered before holds the brief already and is told the message alone.
   */
  take: (
    key: string,
    prompt: (fresh: boolean) => string,
    signal: AbortSignal,
  ) => Promise<LiveTurn | undefined>;
  /** A turn on `key` is coming — the pane is open. Have a process up for it. */
  warm: (key: string, options: Options) => void;
  close: () => Promise<void>;
};

/**
 * How long after the last turn the process is let go. A conversation is a few
 * minutes of thinking with gaps in it, and a pane left open overnight should not
 * hold a subprocess until morning.
 */
const IDLE_MS = 5 * 60 * 1000;

/**
 * A subprocess that has been spoken to, or is waiting to be, and that will be spoken
 * to again. Unlike a `warmPool` standby it is not spent by one answer: the session is
 * the conversation, and keeping it is the whole point.
 */
type Living = {
  /** What it was spawned to serve. A turn for anything else cannot have it. */
  key: string;
  /** A turn is being served right now, so nothing else may touch it. */
  busy: boolean;
  /** Nothing has been said down it yet, so it holds no brief. */
  fresh: boolean;
  turn: (prompt: string) => Promise<LiveTurn>;
  close: () => void;
};

/**
 * The one Claude Code subprocess the chat is talking to, kept between turns.
 *
 * Every turn used to be a fresh process told to reload the conversation off disk,
 * and almost all of what a turn took was that. Here the process is started when the
 * pane opens and fed turn after turn down a stream, so the second thing the manager
 * asks costs what it costs to answer and nothing to ask.
 *
 * One process, not a pool. What binds it is settled at spawn — `cwd`, the MCP server
 * and the hook are all this ticket's — so nothing can be got ready before it is known
 * which ticket it serves, and the manager is looking at one ticket at a time. This is
 * why it cannot be `warmPool`, whose standbys are interchangeable because they are
 * bound to nothing.
 */
export function createLiveChats(deps: { run?: typeof query; idleMs?: number } = {}): LiveChats {
  const run = deps.run ?? query;
  const idleMs = deps.idleMs ?? IDLE_MS;

  /** The one standing, if there is one. */
  let living: Living | undefined;
  let idle: NodeJS.Timeout | undefined;
  let closed = false;

  /** Let this one go, whether or not it is still the one standing. */
  function retire(one: Living): void {
    if (living === one) living = undefined;
    one.close();
  }

  /** Nothing said for long enough means the pane has been left. */
  function countdown(): void {
    clearTimeout(idle);
    if (closed) return;
    idle = setTimeout(() => {
      // Never mid-answer: a turn running this long is slow, not abandoned, and
      // the countdown starts again the moment it ends.
      if (living !== undefined && !living.busy) retire(living);
    }, idleMs);
  }

  return {
    take: async (key, prompt, signal) => {
      const one = living;
      if (closed || one === undefined || one.busy || signal.aborted) return undefined;
      if (one.key !== key) {
        // Another ticket's, or this one's with the agent file edited under it.
        // Either way it cannot serve this turn — and one that would answer as the
        // old definition is worse than no process at all, so it goes now rather
        // than waiting to be replaced.
        retire(one);
        return undefined;
      }

      clearTimeout(idle);
      one.busy = true;
      // Aborting kills the process rather than pausing it. There is no way to take
      // a half-said turn back, and a session interrupted mid-answer is not one the
      // next turn should be carried on down.
      const stop = () => retire(one);
      signal.addEventListener('abort', stop, { once: true });

      try {
        const answered = await one.turn(prompt(one.fresh));
        // One that went wrong is not asked a second thing. Whatever broke the turn
        // is as likely to be the process as the question, and the caller has a cold
        // path to fall back to.
        if (answered.failed !== undefined) retire(one);
        return answered;
      } finally {
        one.busy = false;
        signal.removeEventListener('abort', stop);
        countdown();
      }
    },

    warm: (key, options) => {
      if (closed) return;
      // A turn in flight owns its process to the end of it, even when the pane has
      // moved on: taking it away mid-answer loses an answer already paid for.
      if (living?.busy === true) return;
      if (living === undefined || living.key !== key) {
        if (living !== undefined) retire(living);
        living = spawn(run, key, options);
      }
      countdown();
    },

    close: async () => {
      // Closed first, so a turn still in flight settles into something that starts
      // nothing back up — the order `warmPool.close` documents, and for the reason
      // it documents: a subprocess started on the way out holds `wb serve` open.
      closed = true;
      clearTimeout(idle);
      if (living !== undefined) retire(living);
    },
  };
}

/**
 * A subprocess started now and spoken to later, and then again. The prompts are
 * handed over as a stream that has said nothing yet, which is the trick `warmPool`
 * measured: the SDK spawns against it anyway, and the session says not a word until
 * it is given something to answer.
 *
 * The difference from a standby is the loop. Each turn pushes one message and reads
 * to that turn's `result`, leaving the iterator where it stopped — so the next turn
 * carries on down the same session rather than reloading it from disk.
 */
function spawn(run: typeof query, key: string, options: Options): Living {
  let push!: (prompt: string) => void;
  const awaiting = () =>
    new Promise<string>((resolve) => {
      push = resolve;
    });
  let pushed = awaiting();

  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const content = await pushed;
      // Made ready before the message goes out, so a turn pushed while the SDK is
      // still reading this one is held rather than lost.
      pushed = awaiting();
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    }
  }

  const said = run({ prompt: input(), options });

  /**
   * Asked for its first message now rather than at the first turn. Measured, the SDK
   * spawns and boots against an input stream nobody has pulled on, so this is not what
   * makes the warm work today — a warmed turn cost 45ms against a cold one's 1100ms
   * with and without it. It is what stops that being luck: an SDK that went lazy would
   * leave a warm that boots nothing and a first turn quietly as slow as it ever was,
   * which is the complaint this was written for. `warmPool.spawn` consumes from the
   * moment it spawns for the same reason. One message ahead rather than a loop,
   * because each turn has to stop reading at its own `result`.
   */
  let coming = said.next();
  // A process that dies with nobody talking to it must not bring the workbench down
  // with it. Whatever it failed with is read by the turn that does come, if one does.
  coming.catch(() => {});

  /**
   * What this session has cost so far. The SDK reports `total_cost_usd` as a running
   * total across the turns of a streaming session, so the turn's own cost is the
   * difference — otherwise the second turn would be charged for the first as well.
   */
  let paid = 0;

  const living: Living = {
    key,
    busy: false,
    fresh: true,
    close: () => options.abortController?.abort(),
    turn: async (prompt) => {
      living.fresh = false;
      push(prompt);

      let sessionId: string | undefined;
      try {
        for (;;) {
          const { value, done } = await coming;
          // A session that ends rather than answering is a death like any other:
          // the caller falls back, exactly as it does for one that threw.
          if (done) return { text: '', costUsd: 0, sessionId, failed: 'the chat ended' };
          // The next is asked for before this one is dealt with, so the process is
          // never held up waiting to be read — including between turns, which is the
          // gap the boot happens in.
          coming = said.next();
          coming.catch(() => {});

          sessionId ??= value.session_id;
          if (value.type !== 'result') continue;

          // A total lower than the last means the running total restarted, not that
          // money came back: the SDK zeroes it on a crashed or half-started result
          // and resets it on a `/clear`. What it now says is then this turn's own
          // cost, where charging the difference would charge nothing for a turn that
          // was really paid for. Either way a turn is charged once, and never less
          // than nothing.
          const spent =
            value.total_cost_usd >= paid ? value.total_cost_usd - paid : value.total_cost_usd;
          paid = value.total_cost_usd;

          if (value.subtype === 'success') return { text: value.result, costUsd: spent, sessionId };

          // Which of the endings is the conversation running out rather than the
          // turn going wrong. The agent file's caps were written when every turn
          // was its own query and got its own allowance; down a living process one
          // query is the whole conversation, so the fifth question can end on a
          // limit meant for the first.
          const capped =
            value.subtype === 'error_max_turns' || value.subtype === 'error_max_budget_usd';

          return {
            text: '',
            costUsd: spent,
            sessionId,
            failed: `the chat stopped: ${value.subtype}`,
            ...(capped ? { capped: true } : {}),
          };
        }
      } catch (error) {
        return {
          text: '',
          costUsd: 0,
          sessionId,
          failed: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };

  return living;
}

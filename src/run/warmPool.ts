import { query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** One question, and the answer's text. It throws if the ask got nowhere. */
export type Asker = (prompt: string) => Promise<string>;

export type WarmPool = {
  ask: Asker;
  /** Someone is about to start asking: pay the waiting now rather than then. */
  warm: () => void;
  close: () => Promise<void>;
};

/**
 * How many standbys are kept. Two, because the board's ticket form says two
 * questions in flight is the ordinary case — the wait before one is asked is
 * shorter than the answer to the one before it takes.
 */
const STANDBYS = 2;

/** How long after the last sign of anyone the standbys are let go. */
const IDLE_MS = 5 * 60 * 1000;

/**
 * A subprocess that is already up, waiting to be asked one thing.
 *
 * Single-use on purpose. Each ask is turn one of a fresh session, so nothing
 * carries over from the last one — a second ask down the same process would put
 * the previous ticket's name in front of this one and the answers drift.
 */
type Standby = {
  ask: Asker;
  close: () => void;
};

/**
 * Booted, idle Claude Code subprocesses, so that a question that takes a second to
 * answer does not take twenty to ask. Almost all of that is startup, and startup is
 * the same whatever is being asked — so it can be paid before the question arrives.
 *
 * What the pool owns is the standing options: one cheap turn, no tools, nothing from
 * this machine. Anything asked that way can be served from it. Naming a ticket is the
 * first, not the only one.
 */
export function createWarmPool(
  deps: { run?: typeof query; standbys?: number; idleMs?: number } = {},
): WarmPool {
  const run = deps.run ?? query;
  const target = deps.standbys ?? STANDBYS;
  const idleMs = deps.idleMs ?? IDLE_MS;

  /** Every subprocess started and not yet let go of, waiting or mid-answer. */
  const live = new Set<Standby>();
  let waiting: Standby[] = [];
  let idle: NodeJS.Timeout | undefined;
  let closed = false;

  function start(): Standby {
    const standby = spawn(run);
    live.add(standby);
    return standby;
  }

  function letGo(standby: Standby): void {
    live.delete(standby);
    standby.close();
  }

  function topUp(): void {
    if (closed) return;
    while (waiting.length < target) waiting.push(start());
  }

  /** Nothing asked and nobody warming for long enough means nobody is there. */
  function countdown(): void {
    clearTimeout(idle);
    if (closed) return;
    idle = setTimeout(drain, idleMs);
  }

  function drain(): void {
    for (const standby of waiting) letGo(standby);
    waiting = [];
  }

  /** One ask down one standby, which is spent by the end of it either way. */
  async function askOf(standby: Standby, prompt: string): Promise<string> {
    try {
      return await standby.ask(prompt);
    } finally {
      letGo(standby);
    }
  }

  return {
    ask: async (prompt) => {
      try {
        // No standby is slow, not broken: a cold spawn is what every ask used to be.
        return await askOf(waiting.shift() ?? start(), prompt);
      } catch (failed) {
        // A standby can be gone by the time it is asked — a boot that got nowhere,
        // a credential refused, a machine that slept — and the question must not go
        // with it. One more, down a process that is certainly new. A pool that is
        // shutting down starts nothing: that answer was on its way out anyway.
        if (closed) throw failed;
        return await askOf(start(), prompt);
      } finally {
        // Whether it answered or died, that one is spent. Someone asking once is
        // about to ask again, so the next is got ready while they type.
        topUp();
        countdown();
      }
    },
    warm: () => {
      topUp();
      countdown();
    },
    close: async () => {
      // Closed first, so that an ask still in flight settles into a pool that
      // starts nothing back up. Ctrl-C during a name check is the ordinary way
      // this happens, and a top-up after it held `wb serve` open for five minutes.
      closed = true;
      clearTimeout(idle);
      // All of them, not only what is waiting: the standby handed to that ask is a
      // subprocess too, and it is the one nothing else can reach.
      for (const standby of [...live]) letGo(standby);
      waiting = [];
    },
  };
}

/**
 * A subprocess started now and asked later. The prompt is handed over as a stream
 * that has said nothing yet, and the SDK spawns against it anyway — measured: the
 * process is up within a second of `run` returning and still there eight seconds
 * later with nothing pushed. That gap is the boot, and it is the whole trick.
 *
 * There is nothing to wait for before asking, and nothing worth waiting for: the
 * session says not a word until it has been given something to answer, so the
 * first message out of it is already the answer.
 */
function spawn(run: typeof query): Standby {
  let push!: (prompt: string) => void;
  const asked = new Promise<string>((resolve) => {
    push = resolve;
  });

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: await asked },
      parent_tool_use_id: null,
    };
  }

  const abortController = new AbortController();

  const answer = (async () => {
    let reply: string | undefined;
    for await (const message of run({
      prompt: input(),
      options: {
        // One cheap question with one line of answer, and nothing else: whoever
        // asked is mid-sentence, so this costs almost nothing and comes back
        // before they have finished typing.
        model: 'claude-haiku-4-5',
        maxTurns: 1,
        allowedTools: [],
        // Nothing from this machine, for the same reason a stage takes nothing:
        // what is asked here is what the caller wrote and no more.
        settingSources: [],
        strictMcpConfig: true,
        abortController,
        canUseTool: async (toolName): Promise<PermissionResult> => ({
          behavior: 'deny',
          message: `${toolName} is not part of answering this`,
        }),
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') reply = message.result;
    }
    if (reply === undefined) throw new Error('the ask ended with no answer');
    return reply;
  })();
  // A standby that dies while nobody is asking it anything must not bring the
  // workbench down with it. The ask that does come gets the failure, if one does.
  answer.catch(() => {});

  return {
    ask: (prompt) => {
      push(prompt);
      return answer;
    },
    close: () => abortController.abort(),
  };
}

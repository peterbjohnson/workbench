import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.ts';
import { openStore, type Store } from './store/store.ts';
import { loadAgents, loadChatAgent, loadSkills } from './agents/load.ts';
import { whatHappenedTo } from './agents/brief.ts';
import { createOrchestrator, type Orchestrator } from './orchestrator/loop.ts';
import { createStageRunner } from './run/runStage.ts';
import { createChatRunner } from './run/chat.ts';
import { cachedCredentials } from './run/credentials.ts';
import { createFakeRunner } from './run/fakeRunner.ts';
import { createFakeChatRunner } from './run/fakeChatRunner.ts';
import { createCheckRunner } from './run/checks.ts';
import { diff, gitWorkspace, worktreeFor } from './git/worktree.ts';
import { githubHost } from './github/pr.ts';
import { createApi } from './api/server.ts';

/**
 * What the project is, read once at startup rather than per stage. Absent is fine
 * and means the section is simply not in the brief — better than a heading with an
 * apology under it.
 */
function readAbout(config: Config): string {
  try {
    return fs.readFileSync(path.resolve(config.repoRoot, config.about), 'utf8');
  } catch {
    return '';
  }
}

export type Workbench = {
  store: Store;
  orchestrator: Orchestrator;
  /** What the API is really listening on, which is not `config.port` when that is 0. */
  port: number;
  close: () => Promise<void>;
};

/**
 * The composition root: the one place that knows every module, and the file to read
 * to see how the workbench is put together. It decides nothing and prints nothing —
 * `announce` is where anything it has to say comes out.
 *
 * The orchestrator is wired but not started, so the caller can say what it found
 * before work begins.
 */
export async function startWorkbench(
  config: Config,
  announce: (message: string) => void,
): Promise<Workbench> {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const store = openStore(config.dbPath);
  // Read once here so a broken agent file stops the workbench starting rather than
  // failing the first stage that needs it; read again per run, because the board
  // edits them.
  loadAgents(config.agentDirs);
  loadChatAgent(config.agentDirs);
  const agents = () => loadAgents(config.agentDirs);
  const fake = config.runner === 'fake';

  const orchestrator = createOrchestrator(
    {
      store,
      announce,
      workspace: gitWorkspace(config),
      host: githubHost(config),
      checks: createCheckRunner(config.checks),
      runStage: fake
        ? createFakeRunner({ agents, protectedPaths: config.protectedPaths })
        : createStageRunner({
            agents,
            protectedPaths: config.protectedPaths,
            pluginRoot: config.pluginRoot,
            skills: () => loadSkills(config.pluginRoot),
            about: readAbout(config),
            diff: (ticket) => diff(config, worktreeFor(config, ticket.id), ticket.base),
            continued: (ticketId) =>
              whatHappenedTo(store.ticket(ticketId), store.eventsFor(ticketId)),
          }),
      // Fake agents need no credentials: nothing they do leaves this machine.
      credentials: fake ? async () => ({ ok: true, how: 'fake agents' }) : cachedCredentials(),
    },
    { pollMs: config.pollMs },
  );

  const api = createApi(store, config, {
    chat: fake
      ? createFakeChatRunner()
      : createChatRunner({
          agent: () => loadChatAgent(config.agentDirs),
          // A ticket has no worktree until it starts, and a conversation about one
          // that has not started is a conversation about this repository.
          cwd: (ticket) => {
            const worktree = worktreeFor(config, ticket.id).path;
            return fs.existsSync(worktree) ? worktree : config.repoRoot;
          },
          protectedPaths: config.protectedPaths,
          about: readAbout(config),
        }),
  });
  const port = await api.listen(config.port);

  return {
    store,
    orchestrator,
    port,
    close: async () => {
      await orchestrator.stop();
      await api.close();
      store.close();
    },
  };
}

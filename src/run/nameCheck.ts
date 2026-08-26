import fs from 'node:fs';
import path from 'node:path';

import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { PACKAGE_ROOT, type Config } from '../config.ts';

/** A better name for a ticket than the one typed, and the one line saying why. */
export type Suggestion = { name: string; why: string };

/**
 * What a ticket about to be written could be called instead. Null is the ordinary
 * answer: the name given is fine, or nothing useful came back. A hint about a name
 * is never worth stopping someone writing a ticket, so this refuses nothing and
 * reports no errors — it either has something to offer or it has not.
 */
export type NameChecker = (title: string, body: string) => Promise<Suggestion | null>;

/** The skill saying what a good ticket name is, wherever it is being read from. */
const SKILL = path.join('skills', 'naming-a-ticket', 'SKILL.md');

export function createNameChecker(config: Config, run: typeof query = query): NameChecker {
  return async (title, body) => {
    try {
      let reply = '';
      const session = run({
        prompt: ask(skillText(config), title, body),
        options: {
          // One cheap question with one line of answer, and nothing else: the
          // person is mid-sentence, so this costs almost nothing and comes back
          // before they have finished typing the instructions.
          model: 'claude-haiku-4-5',
          maxTurns: 1,
          allowedTools: [],
          // Nothing from this machine, for the same reason a stage takes nothing:
          // what is asked here is what this file says and no more.
          settingSources: [],
          strictMcpConfig: true,
          canUseTool: async (toolName): Promise<PermissionResult> => ({
            behavior: 'deny',
            message: `${toolName} is not part of answering this`,
          }),
        },
      });

      for await (const message of session) {
        if (message.type === 'result' && message.subtype === 'success') reply = message.result;
      }
      return readSuggestion(reply, title);
    } catch {
      return null;
    }
  };
}

/**
 * The skill's text: the home's own copy if it has one, and the one that ships
 * otherwise — the same nearest-first search `config.agentDirs` does per stage.
 *
 * Read per call rather than held, because the board edits this file, and a hint
 * from the version before an edit looks exactly like an edit that did not save.
 */
function skillText(config: Config): string {
  const own = path.join(config.pluginRoot, SKILL);
  return fs.readFileSync(fs.existsSync(own) ? own : path.join(PACKAGE_ROOT, SKILL), 'utf8');
}

function ask(skill: string, title: string, body: string): string {
  return [
    skill,
    '',
    '---',
    '',
    'The ticket someone is writing on the board right now:',
    '',
    `Name: ${title}`,
    body.trim() === '' ? 'It has no instructions yet.' : `Instructions:\n${body.trim()}`,
    '',
    'Answer with NAME: and WHY:, or with KEEP. Nothing else.',
  ].join('\n');
}

/**
 * The two lines a reply is, if it is one. Null for `KEEP`, for a reply that is
 * neither, and for a suggestion that is the name it was asked about — all three
 * say the same thing to the board, which is that there is nothing to show.
 */
export function readSuggestion(reply: string, asked: string): Suggestion | null {
  let name = '';
  let why = '';

  for (const line of reply.split('\n')) {
    const named = /^NAME:\s*(.+)$/i.exec(line.trim());
    if (named?.[1]) name = named[1].trim();
    const because = /^WHY:\s*(.+)$/i.exec(line.trim());
    if (because?.[1]) why = because[1].trim();
  }

  if (name === '' || name.toLowerCase() === asked.trim().toLowerCase()) return null;
  return { name, why };
}

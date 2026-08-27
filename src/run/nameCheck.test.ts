import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createNameChecker, readSuggestion } from './nameCheck.ts';
import { CONFIG_FILE, loadConfig, type Config } from '../config.ts';

type Query = NonNullable<Parameters<typeof createNameChecker>[1]>;

/** A model service that never leaves the machine: one reply, or one failure. */
function service(reply: string | Error): { query: Query; prompts: string[] } {
  const prompts: string[] = [];

  const query: Query = ({ prompt }) => {
    prompts.push(String(prompt));

    async function* messages(): AsyncGenerator<SDKMessage, void> {
      if (reply instanceof Error) throw reply;
      yield {
        type: 'result',
        subtype: 'success',
        result: reply,
        total_cost_usd: 0,
        session_id: 'session-1',
      } as unknown as SDKMessage;
    }

    return messages() as ReturnType<Query>;
  };

  return { query, prompts };
}

/** A throwaway home, with no skills of its own unless a test writes one. */
function scratchConfig(): Config {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-name-'));
  fs.writeFileSync(path.join(home, CONFIG_FILE), '{}');
  return loadConfig(home);
}

test('a reply in the two lines is a suggestion', () => {
  const suggestion = readSuggestion('NAME: Retry failed pushes\nWHY: it named no verb\n', 'Pushes');

  assert.deepEqual(suggestion, { name: 'Retry failed pushes', why: 'it named no verb' });
});

test('KEEP means the name typed is fine', () => {
  assert.equal(readSuggestion('KEEP\n', 'Retry failed pushes'), null);
});

test('a reply that says neither offers nothing', () => {
  // Silence and rubbish are the same thing here: there is nothing to show. It must
  // never surface as an error under a field someone is still typing in.
  assert.equal(readSuggestion('', 'Pushes'), null);
  assert.equal(readSuggestion('That looks like a fine name to me!', 'Pushes'), null);
});

test('a suggestion of the name it was asked about is not a suggestion', () => {
  assert.equal(
    readSuggestion('NAME: Retry failed pushes\nWHY: it is good', 'Retry failed pushes'),
    null,
  );
});

test('the skill that ships is what is asked, when the home has none of its own', async () => {
  const config = scratchConfig();
  const model = service('NAME: Retry failed pushes\nWHY: it named no verb');

  const suggestion = await createNameChecker(config, model.query)('Pushes', 'They give up early.');

  assert.deepEqual(suggestion, { name: 'Retry failed pushes', why: 'it named no verb' });
  assert.match(model.prompts[0] ?? '', /imperative verb/, 'the rules reached the model');
  assert.match(model.prompts[0] ?? '', /Name: Pushes/, 'and so did the name being asked about');
  assert.match(model.prompts[0] ?? '', /They give up early\./, 'and what the ticket says');
  fs.rmSync(config.home, { recursive: true, force: true });
});

test("the home's own copy of the skill beats the one that ships", async () => {
  const config = scratchConfig();
  const own = path.join(config.pluginRoot, 'skills', 'naming-a-ticket');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(
    path.join(own, 'SKILL.md'),
    '---\ndescription: How this repository names tickets.\n---\n\nEvery name starts with a moon.\n',
  );

  const model = service('KEEP');
  await createNameChecker(config, model.query)('Pushes', '');

  assert.match(model.prompts[0] ?? '', /starts with a moon/);
  assert.doesNotMatch(model.prompts[0] ?? '', /imperative verb/, 'not both — the nearest wins');
  fs.rmSync(config.home, { recursive: true, force: true });
});

test('a call that fails offers nothing, rather than failing', async () => {
  const config = scratchConfig();
  const model = service(new Error('the model service is down'));

  assert.equal(await createNameChecker(config, model.query)('Pushes', ''), null);
  fs.rmSync(config.home, { recursive: true, force: true });
});

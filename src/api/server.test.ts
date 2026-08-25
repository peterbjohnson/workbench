import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './server.ts';
import { createClient, type Client } from './client.ts';
import { openStore, type Store } from '../store/store.ts';
import { CONFIG_FILE, loadConfig } from '../config.ts';

/**
 * A throwaway workbench home, of the shape `wb init` leaves behind: the workbench's
 * own agents copied in, and a skill of the project's own.
 *
 * The skill is written here rather than copied from the workbench, which ships none —
 * how a repository writes Python is that repository's to say. Copying them was what
 * tied these tests to this directory being the workbench's own.
 */
function scratchConfig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-'));
  fs.writeFileSync(path.join(home, CONFIG_FILE), '{}');
  const own = fileURLToPath(new URL('..', import.meta.url));
  fs.cpSync(path.join(own, '..', 'agents'), path.join(home, 'agents'), { recursive: true });

  fs.mkdirSync(path.join(home, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'here' }),
  );
  fs.mkdirSync(path.join(home, 'skills', 'writing-python'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'skills', 'writing-python', 'SKILL.md'),
    '---\nname: writing-python\ndescription: How Python is written in this repository.\n---\n\n# Python\n',
  );
  return loadConfig(home);
}

/** A real server on an ephemeral port, with a real client talking to it. */
async function withApi(fn: (wb: Client, store: Store) => Promise<void>): Promise<void> {
  const store = openStore(':memory:');
  const config = scratchConfig();
  const api = createApi(store, config);
  const port = await api.listen(0);
  try {
    await fn(createClient(`http://127.0.0.1:${port}`), store);
  } finally {
    await api.close();
    store.close();
    fs.rmSync(config.home, { recursive: true, force: true });
  }
}

test('a ticket can be created and read back over HTTP', async () => {
  await withApi(async (wb) => {
    const created = await wb.create('Add a retry', 'It gives up too early.');
    assert.equal(created.id, 't1');
    assert.equal(created.status, 'backlog');

    const { ticket, events } = await wb.ticket('t1');
    assert.equal(ticket.title, 'Add a retry');
    assert.deepEqual(
      events.map((e) => e.type),
      ['ticket_created'],
    );
  });
});

test('ids keep counting up', async () => {
  await withApi(async (wb) => {
    await wb.create('one', '');
    await wb.create('two', '');
    const tickets = await wb.tickets();
    assert.deepEqual(
      tickets.map((t) => t.id),
      ['t1', 't2'],
    );
  });
});

test('the manager can approve, reject and answer through the API', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'the plan',
    });

    await wb.approve('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'implementing');

    await wb.reject('t1', 'wrong problem');
    const sentBack = (await wb.ticket('t1')).ticket;
    assert.equal(sentBack.status, 'planning');
    assert.equal(sentBack.rejection, 'wrong problem');
  });
});

test('answering a blocked ticket resumes it', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'question_asked',
      runId: 'r1',
      question: 'which config?',
      reasoning: 'two disagree',
    });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'blocked',
      summary: 'waiting',
    });
    assert.equal((await wb.ticket('t1')).ticket.status, 'blocked');

    await wb.answer('t1', 'the one in etc/');
    const resumed = (await wb.ticket('t1')).ticket;
    assert.equal(resumed.status, 'planning');
    assert.equal(resumed.question, null);
  });
});

test('the work-in-progress limit is readable and settable', async () => {
  await withApi(async (wb) => {
    assert.equal((await wb.policy()).wipLimit, 2);
    assert.equal((await wb.setPolicy({ wipLimit: 3 })).wipLimit, 3);
    assert.equal((await wb.policy()).wipLimit, 3, 'and it survives the round trip');
  });
});

test('bad requests are refused with a reason, not a stack trace', async () => {
  await withApi(async (wb) => {
    await assert.rejects(() => wb.create('', ''), /needs a title/);

    await wb.create('a thing', '');
    await assert.rejects(() => wb.reject('t1', '   '), /say why/);
    await assert.rejects(() => wb.answer('t1', ''), /answer is needed/);
    await assert.rejects(() => wb.ticket('nope'), /no ticket nope/);
    await assert.rejects(() => wb.approve('nope'), /no ticket nope/);
  });
});

test('a client with nothing to talk to says where it tried', async () => {
  // The address, not the advice. Quoting the whole sentence back made this fail when
  // the advice changed to a command that exists, which is the edit it should welcome.
  const wb = createClient('http://127.0.0.1:1');
  await assert.rejects(() => wb.tickets(), /127\.0\.0\.1:1/);
});

test('the event stream carries events as they are appended', async () => {
  const store = openStore(':memory:');
  const api = createApi(store, scratchConfig());
  const port = await api.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = response.body!.getReader();
    await reader.read(); // the ": connected" preamble

    store.append('t1', { type: 'ticket_created', title: 'streamed', body: '' });

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /);

    const event = JSON.parse(text.replace(/^data: /, '').trim()) as Record<string, unknown>;
    assert.equal(event['type'], 'ticket_created');
    assert.equal(event['ticketId'], 't1');

    await reader.cancel();
  } finally {
    await api.close();
    store.close();
  }
});

test('a ticket can be cancelled, whatever it was doing', async () => {
  await withApi(async (wb) => {
    const ticket = await wb.create('a thing', 'do it');
    await wb.cancel(ticket.id, 'changed my mind');

    const { ticket: stopped, events } = await wb.ticket(ticket.id);
    assert.equal(stopped.status, 'cancelled');
    assert.ok(
      events.some((e) => e.type === 'cancelled' && e.reason === 'changed my mind'),
      'the reason is on the record',
    );
  });
});

test('a ticket can carry on from one that left work behind', async () => {
  await withApi(async (wb, store) => {
    await wb.create('the first attempt', '');
    await assert.rejects(() => wb.create('carry on', '', { from: 't1' }), /left no work/);

    store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'wrote a draft',
      commit: 'abc1234',
    });
    store.append('t1', { type: 'gave_up', reason: 'planned 3 times' });

    const carried = await wb.create('carry on', 'fix the units', { from: 't1' });
    assert.equal(carried.continues, 't1', 'and it says what it continues');

    await assert.rejects(() => wb.create('carry on', '', { from: 't99' }), /no ticket t99/);
  });
});

test('a ticket can be rewritten over HTTP', async () => {
  await withApi(async (wb) => {
    await wb.create('a thing', 'the details');

    const retitled = await wb.edit('t1', { title: 'a better thing' });
    assert.equal(retitled.title, 'a better thing');
    assert.equal(retitled.body, 'the details', 'what was not sent is left alone');

    assert.equal((await wb.edit('t1', { body: '' })).body, '', 'and clearing it is allowed');
    await assert.rejects(() => wb.edit('t1', { title: '  ' }), /needs a title/);
    await assert.rejects(() => wb.edit('t1', {}), /nothing to change/);
  });
});

test('the manager can commit a ticket to the queue and take it back', async () => {
  await withApi(async (wb) => {
    const created = await wb.create('an idea', '');
    assert.equal(created.status, 'backlog');

    await wb.queue('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'queued');

    await wb.backlog('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'backlog');
  });
});

test('offered work can be sent back, or kept and put right', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    // Nothing planned yet: there is no work to keep, so only the expensive no
    // is on offer — the other would send it to implement with nothing to build.
    await assert.rejects(() => wb.changes('t1', 'fix it'), /nothing has been planned/);

    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'the plan',
    });
    store.append('t1', { type: 'pr_opened', url: 'https://example/pr/1' });

    const fixing = await wb.changes('t1', '- the units are wrong');
    assert.equal(fixing.status, 'implementing');
    assert.equal(fixing.changes, '- the units are wrong');
    assert.equal(fixing.prUrl, 'https://example/pr/1', 'still headed for the same pull request');

    await assert.rejects(() => wb.changes('t1', '  '), /say what to put right/);
  });
});

test('a ticket can be written already waiting for others', async () => {
  await withApi(async (wb) => {
    await wb.create('the dependency', '');
    await wb.create('another', '');

    // The moment you know what the work follows is the moment you write it down.
    const held = await wb.create('the one that waits', '', { waitsFor: ['t1', 't2'] });
    assert.deepEqual(held.waitsFor, ['t1', 't2']);
    assert.equal(held.status, 'backlog', 'and it still waits in the backlog as usual');

    // Checked before anything is created, so a typo leaves no ticket behind that
    // says nothing about what it was supposed to wait for.
    await assert.rejects(() => wb.create('bad', '', { waitsFor: ['t9'] }), /no ticket t9/);
    assert.equal((await wb.tickets()).length, 3, 'and nothing was created');
  });
});

test('the manager can put a ticket in front of another, or last', async () => {
  await withApi(async (wb) => {
    for (const title of ['one', 'two', 'three']) await wb.create(title, '');

    const moved = await wb.move('t3', 't1');
    assert.deepEqual(
      moved.map((t) => t.id),
      ['t3', 't1', 't2'],
      'the whole order comes back, because that is what changed',
    );
    assert.deepEqual(
      (await wb.move('t3', null)).map((t) => t.id),
      ['t1', 't2', 't3'],
    );

    await assert.rejects(() => wb.move('t1', 't1'), /before itself/);
    await assert.rejects(() => wb.move('t1', 't9'), /no ticket t9/);
  });
});

test('a ticket can be held until another offers its work, and let go again', async () => {
  await withApi(async (wb, store) => {
    await wb.create('the dependency', '');
    await wb.create('the one that waits', '');

    await wb.create('another dependency', '');

    // The whole set each time, so taking one off is sending the rest.
    assert.deepEqual((await wb.wait('t2', ['t1', 't3'])).waitsFor, ['t1', 't3']);
    assert.deepEqual((await wb.wait('t2', ['t1'])).waitsFor, ['t1']);
    assert.deepEqual((await wb.wait('t2', [])).waitsFor, [], 'and an empty list lets it go');

    // Named twice is waited for once.
    assert.deepEqual((await wb.wait('t2', ['t1', 't1'])).waitsFor, ['t1']);

    await assert.rejects(() => wb.wait('t2', ['t2']), /cannot wait for itself/);
    await assert.rejects(() => wb.wait('t2', ['t1', 't9']), /no ticket t9/);
    assert.deepEqual((await wb.ticket('t2')).ticket.waitsFor, ['t1'], 'and nothing was written');

    // A ring of tickets waiting on each other would never start, and nothing
    // downstream would be able to say why.
    await assert.rejects(() => wb.wait('t1', ['t2']), /hold each other up/);

    store.append('t4', { type: 'ticket_created', title: 'a fourth', body: '' });
    store.append('t4', { type: 'waits_for', tickets: ['t2'] });
    await assert.rejects(() => wb.wait('t1', ['t4']), /hold each other up/);
  });
});

test('the board is served, and the api routes still win', async () => {
  const store = openStore(':memory:');
  const api = createApi(store, scratchConfig());
  const port = await api.listen(0);

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);

    const json = await fetch(`http://127.0.0.1:${port}/tickets`);
    assert.match(json.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    await api.close();
    store.close();
  }
});

test('a second workbench on the same port says so, rather than crashing', async () => {
  const store = openStore(':memory:');
  const first = createApi(store, scratchConfig());
  const port = await first.listen(0);
  const second = createApi(store, scratchConfig());

  try {
    await assert.rejects(
      () => second.listen(port),
      /already running on port/,
      'an ordinary mistake, not a stack trace from inside node',
    );
  } finally {
    await first.close();
    store.close();
  }
});

test('the plan gate is asked for when the ticket is written, and kept', async () => {
  await withApi(async (wb) => {
    assert.equal((await wb.create('gated by default', '')).requiresApproval, true);
    assert.equal(
      (await wb.create('asked for one', '', { requiresApproval: true })).requiresApproval,
      true,
    );

    const ungated = await wb.create('no gate', 'go on then', { requiresApproval: false });
    assert.equal(ungated.requiresApproval, false);

    // It survives the round trip, because it is on the event rather than in memory.
    const { ticket, events } = await wb.ticket(ungated.id);
    assert.equal(ticket.requiresApproval, false);
    assert.ok(
      events.some((e) => e.type === 'ticket_created' && e.requiresApproval === false),
      'the choice is on the record, where the ticket is rebuilt from',
    );
  });
});

test('the agents are readable, and what each declares is said with it', async () => {
  await withApi(async (wb) => {
    const agents = await wb.docs('agent');
    assert.deepEqual(
      agents.map((a) => a.name),
      ['plan', 'implement', 'review', 'verify'],
      'in the order they run',
    );

    const plan = agents[0]!;
    assert.match(plan.where, /agents\/plan\.md$/);
    assert.match(plan.about, /turns/, 'what it costs, from its own frontmatter');
    assert.match(plan.text, /^---/, 'the file as written, frontmatter and all');
  });
});

test('an agent that would not load is refused, and the file is left as it was', async () => {
  await withApi(async (wb) => {
    const before = (await wb.docs('agent'))[0]!;

    await assert.rejects(
      () => wb.saveDoc('agent', 'plan', before.text.replace('effort: high', 'effort: sideways')),
      /effort must be one of/,
      'the complaint names the field, because it reaches the person who typed it',
    );
    await assert.rejects(
      () => wb.saveDoc('agent', 'nonesuch', 'hello'),
      /no agent called nonesuch/,
    );

    assert.equal((await wb.docs('agent'))[0]!.text, before.text);
  });
});

test('an agent saved from the board is what the next stage is run from', async () => {
  await withApi(async (wb) => {
    const before = (await wb.docs('agent'))[0]!;
    const saved = await wb.saveDoc('agent', 'plan', `${before.text}\nAnd one more thing.\n`);

    assert.match(saved.text, /And one more thing\./);
    assert.equal((await wb.docs('agent'))[0]!.text, saved.text, 'on disk, not only in the reply');
  });
});

test('a skill is refused if nothing would ever decide to read it', async () => {
  await withApi(async (wb) => {
    const skills = await wb.docs('skill');
    assert.ok(skills.length > 0, 'the workbench ships with some');
    const one = skills[0]!;
    assert.match(one.where, /skills\/.*\/SKILL\.md$/);
    assert.equal(one.about.length > 0, true, 'its description, which is its whole trigger');

    await assert.rejects(
      () => wb.saveDoc('skill', one.name, '---\ndescription: ""\n---\n\nSomething.'),
      /no description/,
    );
  });
});

test('the settings say what the workbench is set to, and a limit changed there holds', async () => {
  await withApi(async (wb) => {
    const before = await wb.settings();
    const wip = before.find((s) => s.key === 'wipLimit');
    assert.equal(wip?.value, 2);
    assert.equal(wip?.restart, false, 'a limit takes effect at once');

    const after = await wb.setSettings({ wipLimit: '4' });
    assert.equal(after.find((s) => s.key === 'wipLimit')?.value, 4);
    assert.equal((await wb.policy()).wipLimit, 4, 'the rules read the same number');
  });
});

test('a setting that is a fact about the installation cannot be set', async () => {
  await withApi(async (wb) => {
    await assert.rejects(() => wb.setSettings({ repoRoot: '/tmp' }), /not something you set/);
    await assert.rejects(() => wb.setSettings({ maxRevisions: 9 }), /not something you set/);
    await assert.rejects(() => wb.setSettings({ nonesuch: 1 }), /no setting called nonesuch/);
    await assert.rejects(() => wb.setSettings({ wipLimit: 0 }), /at least 1/);
  });
});

test('a configured setting is written to the config file, and a default is taken back out', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const after = await wb.setSettings({ base: 'trunk', checks: 'yarn test\nyarn typecheck' });
    assert.equal(after.find((s) => s.key === 'base')?.restart, true, 'and it says so');
    assert.equal(file()['base'], 'trunk');
    assert.deepEqual(file()['checks'], ['yarn test', 'yarn typecheck']);

    // Back at the default, so the file stops mentioning it: what is in there is
    // what this project decided, not a copy of every default.
    await wb.setSettings({ base: 'main' });
    assert.equal('base' in file(), false);
  });
});

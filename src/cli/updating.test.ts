import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offer, relaunch, taken } from './updating.ts';

test('the offer names both commits and both answers', () => {
  const said = offer('abcdef12', '34567890');

  assert.match(said, /abcdef12 → 34567890/);
  // Both answers on the question, because one of them is what happens if you say
  // nothing and nobody should have to guess which.
  assert.match(said, /Install it and start the new one/);
  assert.match(said, /serve this version as it is/);
  assert.match(said, /\[y\/N\] $/);
});

test('only a typed yes takes the update', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y ']) assert.equal(taken(answer), true);
});

test('saying nothing serves as it is', () => {
  // The default is no: this replaces the code the agents run under, so an Enter
  // pressed to get past a prompt must not be what installs it.
  for (const answer of ['', '  ', '\n', 'n', 'N', 'no', 'later', 'yep']) {
    assert.equal(taken(answer), false);
  }
});

test('the relaunch runs the same command again under this Node', () => {
  const { command, args } = relaunch('/usr/bin/node', ['/usr/bin/node', '/opt/wb/bin/wb.mjs']);

  assert.equal(command, '/usr/bin/node');
  // argv[1] is the installed entry point, which imports the build npm has just
  // replaced. Running it again is what makes the new code the one that serves.
  assert.deepEqual(args, ['/opt/wb/bin/wb.mjs']);
});

test('the relaunch keeps the arguments it was given', () => {
  const { args } = relaunch('/usr/bin/node', ['/usr/bin/node', '/opt/wb/bin/wb.mjs', 'serve']);

  assert.deepEqual(args, ['/opt/wb/bin/wb.mjs', 'serve']);
});

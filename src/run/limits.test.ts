import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSessionLimit } from './limits.ts';

const MESSAGE = "You've hit your session limit · resets 10:30pm (Europe/London)";

test('a reset later today is read in the zone it was said in', () => {
  // 20:00 UTC is 21:00 in London in September, so 10:30pm there is 90 minutes off.
  const at = readSessionLimit(MESSAGE, new Date('2026-09-14T20:00:00Z'));

  assert.equal(at?.toISOString(), '2026-09-14T21:30:00.000Z');
});

test('the reset minute is now, not this time tomorrow', () => {
  // 21:30 UTC is 22:30 in London: the minute the message names. This is the ordinary
  // case — the message is read the moment the run dies on it — and it must not park
  // the board for 24 hours.
  const now = new Date('2026-09-14T21:30:12Z');

  assert.ok(readSessionLimit(MESSAGE, now)!.getTime() <= now.getTime());
});

test('a couple of minutes behind is still now', () => {
  // The same message read again at 22:32 in London, by a tick or a restart. Two minutes
  // late is late, not a day early.
  const now = new Date('2026-09-14T21:32:00Z');

  assert.ok(readSessionLimit(MESSAGE, now)!.getTime() <= now.getTime());
});

test('a reset that has already gone today is tomorrow', () => {
  // 23:00 in London, half an hour past the time the message names.
  const at = readSessionLimit(MESSAGE, new Date('2026-09-14T22:00:00Z'));

  assert.equal(at?.toISOString(), '2026-09-15T21:30:00.000Z');
});

test('no zone means this machine', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const at = readSessionLimit("You've hit your session limit · resets 3pm", now);

  assert.ok(at !== undefined && at > now);
  assert.equal(at.getHours(), 15, 'the local clock reads what the message said');
  assert.equal(at.getMinutes(), 0);
});

test('nothing readable is nothing to wait for', () => {
  const now = new Date('2026-09-14T12:00:00Z');

  // Not a limit at all: the ordinary failure, which must go on failing.
  assert.equal(readSessionLimit('Error: fetch failed', now), undefined);
  // A limit that does not say when. Waiting for a time nobody gave is worse than
  // failing, because nothing would ever start again.
  assert.equal(readSessionLimit("You've hit your session limit", now), undefined);
  // A zone this machine has never heard of.
  assert.equal(readSessionLimit('session limit · resets 10:30pm (Mars/Olympus)', now), undefined);
});

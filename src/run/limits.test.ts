import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSessionLimit } from './limits.ts';

const MESSAGE = "You've hit your session limit · resets 10:30pm (Europe/London)";

test('a reset later today is read in the zone it was said in', () => {
  // 20:00 UTC is 21:00 in London in September, so 10:30pm there is 90 minutes off.
  const at = readSessionLimit(MESSAGE, new Date('2026-09-14T20:00:00Z'));

  assert.equal(at?.toISOString(), '2026-09-14T21:30:00.000Z');
});

test('the reset minute is the end of the grace, not this time tomorrow', () => {
  // 21:30 UTC is 22:30 in London: the minute the message names. This is the ordinary
  // case — the message is read the moment the run dies on it — and it must not park
  // the board for 24 hours. It comes back at the far edge of the grace, 22:33, rather
  // than at the moment of reading, which is already gone.
  const now = new Date('2026-09-14T21:30:12Z');
  const at = readSessionLimit(MESSAGE, now)!;

  assert.equal(at.toISOString(), '2026-09-14T21:33:00.000Z');
  assert.ok(at.getTime() > now.getTime());
});

test('a couple of minutes behind names the same instant', () => {
  // The same message read again at 22:32 in London, by a tick or a restart. Two minutes
  // late is late, not a day early — and it is the same comeback the first read named,
  // so re-reading inside the grace does not push the wait along.
  const now = new Date('2026-09-14T21:32:00Z');
  const at = readSessionLimit(MESSAGE, now)!;

  assert.equal(at.toISOString(), '2026-09-14T21:33:00.000Z');
  assert.ok(at.getTime() > now.getTime());
});

test('the grace does not go round twice', () => {
  // A service still refusing when the run resumes throws the same message again — now
  // read at the instant the first read named, which is past the grace. It rolls to the
  // next day, so waiting one out costs one retry however fast the API answers.
  const at = readSessionLimit(MESSAGE, new Date('2026-09-14T21:33:00Z'));

  assert.equal(at?.toISOString(), '2026-09-15T21:30:00.000Z');
});

test('the instant is never one that has already gone', () => {
  // The invariant the rest of the machinery rests on: a ticket parked until a time in
  // the past is carried on by the tick that parked it, and parked again, for as long as
  // the service keeps refusing. Every message this reads at all, read from every side of
  // the grace, must name a moment still to come.
  const messages = [
    MESSAGE,
    'session limit · resets 22:30 (Europe/London)',
    // The zoneless form too: it is read against this machine's clock, so where in the
    // grace it falls depends on where the test runs — and the invariant must not.
    "You've hit your session limit · resets 3pm",
  ];
  for (const message of messages) {
    for (const minute of [-5, -1, 0, 1, 2, 3, 30, 60]) {
      for (const second of [0, 12, 59]) {
        const now = new Date(Date.UTC(2026, 8, 14, 21, 30 + minute, second));
        const at = readSessionLimit(message, now)!;

        assert.ok(at.getTime() > now.getTime(), `${message} read at ${now.toISOString()}`);
      }
    }
  }
});

test('a reset that has already gone today is tomorrow', () => {
  // 23:00 in London, half an hour past the time the message names.
  const at = readSessionLimit(MESSAGE, new Date('2026-09-14T22:00:00Z'));

  assert.equal(at?.toISOString(), '2026-09-15T21:30:00.000Z');
});

test('no zone means this machine', () => {
  // Read against whatever clock the machine keeps, so the instant must be the next local
  // 3pm wherever this runs. :20 past the hour, because every zone's offset is a whole
  // number of quarter-hours: the local clock here reads :20, :35, :05 or :50, never near
  // enough to 15:00 for the grace — which would answer 15:03 — to be in play at all.
  const now = new Date('2026-09-14T12:20:00Z');
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

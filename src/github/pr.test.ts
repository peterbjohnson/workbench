import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readVerdict } from './pr.ts';

test('a merged pull request is an acceptance', () => {
  assert.deepEqual(readVerdict({ state: 'MERGED' }), { kind: 'accepted' });
});

test('an open pull request with no review is still pending', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN' }), { kind: 'pending' });
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [] }), { kind: 'pending' });
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'COMMENTED' }] }), {
    kind: 'pending',
  });
});

test('requesting changes is a rejection, and the comment becomes the reason', () => {
  assert.deepEqual(
    readVerdict({
      state: 'OPEN',
      reviews: [{ state: 'CHANGES_REQUESTED', body: 'use the existing helper' }],
    }),
    { kind: 'rejected', reason: 'use the existing helper' },
  );
});

test('the most recent change request wins', () => {
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'first thought', submittedAt: '2026-08-01T10:00:00Z' },
      { state: 'APPROVED', body: 'ignore me', submittedAt: '2026-08-02T10:00:00Z' },
      { state: 'CHANGES_REQUESTED', body: 'second thought', submittedAt: '2026-08-03T10:00:00Z' },
    ],
  });
  assert.deepEqual(verdict, { kind: 'rejected', reason: 'second thought' });
});

test('changes requested with no comment still rejects, with something to read', () => {
  const verdict = readVerdict({ state: 'OPEN', reviews: [{ state: 'CHANGES_REQUESTED' }] });
  assert.equal(verdict.kind, 'rejected');
  assert.match(verdict.kind === 'rejected' ? verdict.reason : '', /no comment/);
});

test('a change request the branch has moved past has been addressed', () => {
  // A ticket sent back is offered again on the same pull request. Reading the review
  // that sent it back as a live rejection would send it round again the moment it
  // re-offered itself, for ever, on an objection already dealt with.
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [{ state: 'CHANGES_REQUESTED', body: 'use it', submittedAt: '2026-08-01T10:00:00Z' }],
    commits: [{ committedDate: '2026-08-02T10:00:00Z' }],
  });
  assert.deepEqual(verdict, { kind: 'pending' }, 'it waits for someone to look again');
});

test('a change request on the work as it stands is still a rejection', () => {
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'still wrong', submittedAt: '2026-08-03T10:00:00Z' },
    ],
    commits: [{ committedDate: '2026-08-02T10:00:00Z' }],
  });
  assert.deepEqual(verdict, { kind: 'rejected', reason: 'still wrong' });
});

test('closing a pull request without merging rejects it', () => {
  const verdict = readVerdict({ state: 'CLOSED' });
  assert.deepEqual(verdict, {
    kind: 'rejected',
    reason: 'the pull request was closed without merging',
  });
});

test('an approving review alone does not accept — only merging does', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'APPROVED' }] }), {
    kind: 'pending',
  });
});

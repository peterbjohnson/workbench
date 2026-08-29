import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alreadyMerged, mergeArgs, readVerdict, retryableMergeFailure, reusablePr } from './pr.ts';

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

test('merging squashes the ticket into one commit on the base', () => {
  assert.deepEqual(mergeArgs('https://example/pr/7'), [
    'pr',
    'merge',
    'https://example/pr/7',
    '--squash',
  ]);
});

test('a branch keeps its pull request when it is offered again — unless that one merged', () => {
  const view = (state: string) => JSON.stringify({ url: 'https://example/pr/7', state });

  // A ticket reworked after an objection must come back to the pull request that
  // objection was written on, whether it is still open or was closed.
  assert.equal(reusablePr(view('OPEN')), 'https://example/pr/7');
  assert.equal(reusablePr(view('CLOSED')), 'https://example/pr/7');

  // A ticket sent back to be tweaked after it merged is offered on the same branch.
  // Reusing the merged pull request would have the workbench poll it, read MERGED
  // as an acceptance, and call the ticket done with the tweak never merged.
  assert.equal(reusablePr(view('MERGED')), null);

  assert.equal(reusablePr('{}'), null, 'and no pull request is no pull request');
});

test('GitHub not having caught up is worth asking again about', () => {
  // The base moved a moment ago and GitHub has not finished working out what that
  // did to this pull request. Asked now it says no; asked again it says yes.
  for (const message of [
    'GraphQL: Pull Request is not mergeable (mergePullRequest)',
    'X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.',
    'GraphQL: Base branch was modified. Review and try the merge again.',
  ]) {
    assert.equal(retryableMergeFailure(message), true, message);
  }
});

test('a refusal that is a decision blocks the ticket rather than being retried', () => {
  // GitHub words most of these as "not mergeable" too, so what tells them apart is
  // the reason it gives after it — asking again would only get the same answer.
  for (const message of [
    'X Pull request #7 is not mergeable: the base branch policy prohibits the merge.',
    'X Pull request #7 is not mergeable: required status checks have not passed.',
    'X Pull request #7 is not mergeable: at least 1 approving review is required.',
    'GraphQL: You do not have permission to merge this pull request',
    'error: failed to push some refs',
  ]) {
    assert.equal(retryableMergeFailure(message), false, message);
  }
});

test('a pull request that has already merged is not merged again', () => {
  // A retry whose merge landed, or a workbench restarted with the request still
  // standing: `gh pr merge` on a merged pull request is an error, not a no-op.
  assert.equal(alreadyMerged(JSON.stringify({ state: 'MERGED' })), true);
  assert.equal(alreadyMerged(JSON.stringify({ state: 'OPEN' })), false);
  assert.equal(alreadyMerged('{}'), false, 'and nothing read is nothing merged');
});

test('an approving review alone does not accept — only merging does', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'APPROVED' }] }), {
    kind: 'pending',
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { joinTitle, splitTitle } from './titles.ts';

const PREFIXES = ['feature', 'fix', 'chore', 'docs'];

test('no prefix leaves the title as it was typed', () => {
  assert.equal(joinTitle('', '  Card drag leaves board lit  '), 'Card drag leaves board lit');
});

test('a prefix goes on the front of the title', () => {
  assert.equal(joinTitle('fix', 'Card drag leaves board lit'), 'fix: Card drag leaves board lit');
});

test('a configured prefix comes back off again', () => {
  assert.deepEqual(splitTitle('fix: Card drag leaves board lit', PREFIXES), {
    prefix: 'fix',
    rest: 'Card drag leaves board lit',
  });
});

test('a colon that is not a configured prefix leaves the title whole', () => {
  // Otherwise every title with a colon in it loses half of itself on the way into
  // the form, and saving it back would quietly rewrite it.
  for (const title of ['Ticket naming: a proposal', 'fix:no space', 'spike: try esbuild']) {
    assert.deepEqual(splitTitle(title, PREFIXES), { prefix: '', rest: title });
  }
});

test('with no prefixes configured nothing is split off', () => {
  assert.deepEqual(splitTitle('fix: Card drag leaves board lit', []), {
    prefix: '',
    rest: 'fix: Card drag leaves board lit',
  });
});

test('a title survives a trip through the form unchanged', () => {
  for (const title of ['fix: Card drag leaves board lit', 'Ticket naming: a proposal', 'Plain']) {
    const { prefix, rest } = splitTitle(title, PREFIXES);
    assert.equal(joinTitle(prefix, rest), title);
  }
});

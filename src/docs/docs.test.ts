import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { reference, REFERENCE, splice } from './generate.ts';

test('the generated sections of the reference are what the code says they are', () => {
  // The whole point of generating them: this fails when someone changes an agent or a
  // command and does not run `npm run docs`, so the page cannot quietly stop being true.
  assert.equal(
    fs.readFileSync(REFERENCE, 'utf8'),
    reference(),
    'docs/reference.md is out of date — run `npm run docs`',
  );
});

test('a section that lost its markers is an error, not a silent omission', () => {
  // Deleting a marker by accident would leave the last generated text sitting there
  // looking current for ever.
  assert.throws(() => splice('# nothing to write into\n', 'stages', 'x'), /no <!-- generated/);
});

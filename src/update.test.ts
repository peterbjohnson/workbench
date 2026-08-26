import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareUrl, installed, remotesFor, short } from './update.ts';

const COMMIT = 'd4388de9f85714adf19cd96c71a7e4f1fc186dfa';

/**
 * A project with the workbench installed into it, of the shape npm leaves behind:
 * the dependency asked for by repository, and a lock file naming the commit that
 * was resolved to.
 */
function project(overrides: { dependencies?: unknown; packages?: unknown } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-update-'));
  const from = path.join(root, 'node_modules', 'workbench');
  fs.mkdirSync(from, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'a-project',
      dependencies: overrides.dependencies ?? { workbench: 'github:peterbjohnson/workbench' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      packages: overrides.packages ?? {
        'node_modules/workbench': {
          version: '0.1.5',
          resolved: `git+ssh://git@github.com/peterbjohnson/workbench.git#${COMMIT}`,
        },
      },
    }),
  );
  return { repoRoot: root, from };
}

test('an installed copy knows the commit it is', () => {
  const { repoRoot, from } = project();

  assert.deepEqual(installed({ repoRoot }, from), {
    name: 'workbench',
    spec: 'github:peterbjohnson/workbench',
    url: 'ssh://git@github.com/peterbjohnson/workbench.git',
    commit: COMMIT,
  });
});

test('a workbench running from its own checkout is not an installed copy', () => {
  const { repoRoot } = project();

  // Running from the repository itself rather than from inside node_modules: there
  // is nothing for npm to fetch, and saying so is how the command knows to refuse.
  assert.equal(installed({ repoRoot }, repoRoot), undefined);
});

test('a lock file that does not mention it is no answer at all', () => {
  const { repoRoot, from } = project({ packages: {} });

  assert.equal(installed({ repoRoot }, from), undefined);
});

test('a dependency the project does not ask for cannot be asked for again', () => {
  // In the lock but not in package.json — nothing to hand back to `npm install`.
  const { repoRoot, from } = project({ dependencies: {} });

  assert.equal(installed({ repoRoot }, from), undefined);
});

test('a resolved url with no commit on it is no answer either', () => {
  const { repoRoot, from } = project({
    packages: {
      'node_modules/workbench': { resolved: 'https://registry.npmjs.org/workbench.tgz' },
    },
  });

  assert.equal(installed({ repoRoot }, from), undefined);
});

test('what changed is a link, whichever way the remote is written', () => {
  const where = `/compare/${COMMIT}...${'a'.repeat(40)}`;

  for (const url of [
    'ssh://git@github.com/peterbjohnson/workbench.git',
    'https://github.com/peterbjohnson/workbench.git',
    'https://github.com/peterbjohnson/workbench',
  ]) {
    assert.equal(
      compareUrl(url, COMMIT, 'a'.repeat(40)),
      `https://github.com/peterbjohnson/workbench${where}`,
      url,
    );
  }
});

test('a host with no such page is not given one', () => {
  assert.equal(compareUrl('https://git.example.com/pbj/workbench.git', COMMIT, COMMIT), undefined);
});

test('an ssh remote is asked over https first', () => {
  // npm records git+ssh whatever the dependency was asked for as, and a machine that
  // reaches GitHub with a token and no key can only answer the https one.
  assert.deepEqual(remotesFor('ssh://git@github.com/peterbjohnson/workbench.git'), [
    'https://github.com/peterbjohnson/workbench.git',
    'ssh://git@github.com/peterbjohnson/workbench.git',
  ]);
});

test('a remote already https is asked once', () => {
  assert.deepEqual(remotesFor('https://github.com/peterbjohnson/workbench.git'), [
    'https://github.com/peterbjohnson/workbench.git',
  ]);
});

test('a remote somewhere else is asked as it is written', () => {
  assert.deepEqual(remotesFor('ssh://git@git.example.com/pbj/workbench.git'), [
    'ssh://git@git.example.com/pbj/workbench.git',
  ]);
});

test('a commit is said in eight characters', () => {
  assert.equal(short(COMMIT), 'd4388de9');
});

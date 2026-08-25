import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cachedCredentials,
  fromEnvironment,
  readAuthStatus,
  type Credentials,
} from './credentials.ts';

const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const LOGGED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claudeai' });

function why(c: Credentials): string {
  return c.ok ? '' : c.why;
}

function how(c: Credentials): string {
  return c.ok ? c.how : '';
}

/** What the environment authenticates as, or '' when it authenticates as nothing. */
function inEnv(env: NodeJS.ProcessEnv): string {
  const found = fromEnvironment(env);
  return found === undefined ? '' : how(found);
}

test('being logged out is read from the JSON, not from an exit code', () => {
  // `claude auth status` exits 0 whether or not you are logged in, so anything that
  // trusted the exit code would call this a working setup.
  const result = readAuthStatus(LOGGED_OUT);

  assert.equal(result.ok, false);
  assert.match(why(result), /not logged in/);
});

test('a working login is reported with the method that produced it', () => {
  const result = readAuthStatus(LOGGED_IN);

  assert.equal(result.ok, true);
  assert.match(how(result), /claudeai/);
});

test('an API key wins, and says so', () => {
  // A forgotten key in a shell profile outranks the CLI login — checked before the
  // CLI is even asked. Saying which one is in use is the whole point: otherwise the
  // workbench quietly works as an account nobody intended, and the bill turns up
  // somewhere unexpected.
  assert.match(inEnv({ ANTHROPIC_API_KEY: 'sk-ant-whatever' }), /ANTHROPIC_API_KEY/);

  assert.equal(fromEnvironment({}), undefined, 'nothing there means nothing to report');
  assert.equal(
    fromEnvironment({ ANTHROPIC_API_KEY: '   ' }),
    undefined,
    'and an empty one is not a credential',
  );
});

test('output that cannot be read is a problem, not a pass', () => {
  const result = readAuthStatus('claude: command not found');

  assert.equal(result.ok, false);
  assert.match(why(result), /could not read/);
});

test('every failure says how to fix it, starting with the one that lasts', () => {
  for (const raw of [LOGGED_OUT, 'nonsense', '']) {
    const result = readAuthStatus(raw);
    assert.equal(result.ok, false);
    const fix = result.ok ? '' : result.fix;
    assert.match(fix, /claude setup-token/, 'the long-lived option comes first');
    assert.match(fix, /claude auth login/);
    assert.match(fix, /ANTHROPIC_API_KEY/);
  }
});

test('the answer is cached, so one tick asks once however many tickets it looks at', async () => {
  let asked = 0;
  const check = cachedCredentials(async () => {
    asked++;
    return { ok: true, how: 'a test' };
  }, 60_000);

  await Promise.all([check(), check(), check()]);
  await check();

  assert.equal(asked, 1, 'spawning a subprocess per ticket per tick would be silly');
});

test('a non-zero exit that still printed the answer is read, not discarded', async () => {
  // `claude auth status --json` exits 1 when you are logged out and prints the answer
  // anyway. Treating the failed exit as "I cannot tell" loses the one thing it said,
  // and reports a broken CLI instead of a plain "you are not logged in".
  const failed = Object.assign(new Error('Command failed: claude auth status --json'), {
    stdout: LOGGED_OUT,
  });

  const result = readAuthStatus(stdoutOf(failed));
  assert.equal(result.ok, false);
  assert.match(why(result), /not logged in/, 'not "could not run"');
});

/** Mirrors what checkCredentials pulls off a rejected execFile. */
function stdoutOf(error: unknown): string {
  const said = (error as { stdout?: unknown } | null)?.stdout;
  return typeof said === 'string' ? said : '';
}

test('a setup-token token counts, and is not mistaken for being logged out', () => {
  // `claude setup-token` hands you a token rather than storing one, so the CLI still
  // reports loggedIn: false while the SDK authenticates perfectly well. Reading only
  // the CLI would pause the board on a setup that works — a false negative, which is
  // worse than the problem the check exists to solve.
  assert.equal(readAuthStatus(LOGGED_OUT).ok, false, 'the CLI alone says no');
  assert.match(inEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-whatever' }), /ANTHROPIC_AUTH_TOKEN/);
});

test('an API key outranks a setup-token token, and the name says which', () => {
  const both = inEnv({
    ANTHROPIC_API_KEY: 'sk-ant-key',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-token',
  });

  assert.match(both, /ANTHROPIC_API_KEY/);
});

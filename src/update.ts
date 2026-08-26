import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_ROOT } from './config.ts';

const run = promisify(execFile);

/** How long the code host gets to say what is newest before the question is dropped. */
const LOOK_MS = 3_000;

/**
 * Where the running workbench came from, when it came from somewhere.
 *
 * There are no releases and no tags: a project depends on the repository itself, and
 * npm writes down the commit it resolved that to. That commit is the version — the
 * only one there is, and the only thing an update can be measured against.
 */
export type Installed = {
  /** What the dependency is called here. Not always "workbench": npm allows aliases. */
  name: string;
  /** The dependency as the project asked for it, which is what an update asks for again. */
  spec: string;
  /** Where npm fetched it from, as the lock file records it. */
  url: string;
  /** The commit that is on disk, and therefore running. */
  commit: string;
};

/**
 * The installed copy this process is, or nothing when it is not one.
 *
 * Running from a checkout is the ordinary case while working on the workbench itself,
 * and there is nothing to update: what to update is then the checkout, which the person
 * is already standing in. Saying nothing is how that case is told apart.
 *
 * `from` is where this code is running, which is the whole of the question — a copy in
 * `node_modules` was installed, and anywhere else was not. It is a parameter because a
 * test cannot move itself into someone's `node_modules` to ask.
 */
export function installed(
  project: { repoRoot: string },
  from: string = PACKAGE_ROOT,
): Installed | undefined {
  const key = path.relative(project.repoRoot, from).replaceAll(path.sep, '/');
  if (!key.startsWith('node_modules/')) return undefined;

  const lock = readJson(path.join(project.repoRoot, 'package-lock.json'));
  const entry = lock?.['packages'] as Record<string, { resolved?: unknown }> | undefined;
  const resolved = entry?.[key]?.resolved;
  if (typeof resolved !== 'string') return undefined;

  const commit = /#([0-9a-f]{40})$/.exec(resolved)?.[1];
  if (commit === undefined) return undefined;

  const name = key.slice('node_modules/'.length);
  const manifest = readJson(path.join(project.repoRoot, 'package.json'));
  const spec = specIn(manifest, name);
  if (spec === undefined) return undefined;

  return { name, spec, url: resolved.replace(/#.*$/, '').replace(/^git\+/, ''), commit };
}

/**
 * The commit at the head of what the project depends on, asked of the code host
 * directly. No clone, no fetch, and nothing written: `ls-remote` is the one git
 * command that answers about a repository without having one.
 *
 * Nothing here throws. Being unable to find out is an ordinary answer — offline, no
 * key, a remote that has moved — and every caller wants to carry on regardless.
 */
export async function newest(url: string): Promise<string | undefined> {
  for (const remote of remotesFor(url)) {
    const head = await headOf(remote);
    if (head !== undefined) return head;
  }
  return undefined;
}

/**
 * The remotes to try, in the order to try them.
 *
 * npm writes `git+ssh` into the lock file even for a dependency asked for as
 * `github:owner/repo`, and a machine that reaches GitHub over HTTPS — a token, `gh`,
 * or a public repository needing nothing at all — has no key to answer an ssh one
 * with. So the https form goes first, and the recorded one after it, for the private
 * repository where ssh is the way in.
 */
export function remotesFor(url: string): string[] {
  const repo = githubRepo(url);
  if (repo === undefined) return [url];
  const https = `https://github.com/${repo}.git`;
  return https === url ? [url] : [https, url];
}

/**
 * Where a person can read what changed, when the host is one that shows such a page.
 * Two commits and a URL is a better answer than a summary this would have to invent.
 */
export function compareUrl(url: string, from: string, to: string): string | undefined {
  const repo = githubRepo(url);
  return repo && `https://github.com/${repo}/compare/${from}...${to}`;
}

function githubRepo(url: string): string | undefined {
  const found = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  return found?.[1];
}

async function headOf(remote: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['ls-remote', remote, 'HEAD'], {
      timeout: LOOK_MS,
      // Never stop to ask for a password. This runs at startup too, where a prompt
      // nobody is watching is a workbench that never finishes starting.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    return /^([0-9a-f]{40})\s/m.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/** Fetches it and builds it, exactly as the first install did. */
export async function install(project: { repoRoot: string }, here: Installed): Promise<void> {
  await run('npm', ['install', `${here.name}@${here.spec}`], { cwd: project.repoRoot });
}

/** The first eight characters, which is how a commit is said out loud. */
export function short(commit: string): string {
  return commit.slice(0, 8);
}

function specIn(manifest: Record<string, unknown> | undefined, name: string): string | undefined {
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = manifest?.[field] as Record<string, string> | undefined;
    if (typeof deps?.[name] === 'string') return deps[name];
  }
  return undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

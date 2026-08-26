import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, type Config } from '../config.ts';
import { POLICY_KEYS, type Policy } from '../domain/rules.ts';
import { MAX_REVISIONS } from '../domain/ticket.ts';
import type { Store } from '../store/store.ts';

/**
 * One thing about how this workbench works: what it is, what it is set to, and
 * whether you may change it. The board draws the page by walking this list, so a
 * setting appears there by being here and nowhere else.
 */
export type Setting = {
  key: string;
  label: string;
  value: string | number | string[];
  /** How it is edited. `lines` is a list, one to a line. */
  type: 'number' | 'text' | 'lines' | 'choice';
  choices?: string[];
  about: string;
  /** Read-only settings are facts about this installation, not decisions. */
  writable: boolean;
  /** Whether a change waits for the next `wb serve`. */
  restart: boolean;
  group: string;
};

/** What a value in the config file is when the file does not mention it. */
const CONFIG_DEFAULTS: Record<string, string | number | string[]> = {
  base: 'main',
  checks: [],
  about: 'claude.md',
  worktreeRoot: '.worktrees',
  protectedPaths: [],
  pollMs: 30_000,
  port: 4600,
  runner: 'claude',
};

const LIMITS: Record<keyof Policy, { label: string; about: string }> = {
  wipLimit: {
    label: 'Tickets at a time',
    about: 'How many tickets may have a stage running at once.',
  },
  maxCycles: {
    label: 'Plans per ticket',
    about:
      'How many times one ticket may be planned before the workbench stops and asks ' +
      'you to settle it. Reaching it is the agents failing to agree, not the ticket ' +
      'being finished with.',
  },
  maxTicketUsd: {
    label: 'Cost per ticket ($)',
    about: 'What one ticket may spend, across every stage and every cycle. Then it is given up on.',
  },
};

const CONFIGURED: Record<string, Omit<Setting, 'key' | 'value' | 'writable' | 'restart'>> = {
  base: {
    label: 'Base branch',
    type: 'text',
    group: 'Work',
    about: 'The branch new work starts from, and pull requests target.',
  },
  checks: {
    label: 'Checks',
    type: 'lines',
    group: 'Work',
    about:
      'The standing suite, one command to a line. The workbench runs them itself, in ' +
      'the ticket’s worktree, before the verify agent is called. With none set, ' +
      '"approved" only ever means an agent could not break it.',
  },
  about: {
    label: 'Project brief',
    type: 'text',
    group: 'Work',
    about:
      'A file describing the project, relative to the repository root, put in front of ' +
      'every stage. Point it at nothing and the section is left out.',
  },
  runner: {
    label: 'Runner',
    type: 'choice',
    choices: ['claude', 'fake'],
    group: 'Work',
    about:
      '"claude" calls the model service and spends real money. "fake" runs a scripted ' +
      'agent that makes no external calls but does real work on disk. WB_RUNNER overrides this.',
  },
  pollMs: {
    label: 'Verdict poll (ms)',
    type: 'number',
    group: 'Work',
    about: 'How often to ask the code host whether a pull request has been merged or refused.',
  },
  port: {
    label: 'Port',
    type: 'number',
    group: 'Work',
    about: 'What `wb serve` listens on, and every other command talks to.',
  },
  worktreeRoot: {
    label: 'Worktrees',
    type: 'text',
    group: 'Where things are',
    about: 'Where each ticket’s own checkout is made, relative to the workbench home.',
  },
  protectedPaths: {
    label: 'Protected paths',
    type: 'lines',
    group: 'Where things are',
    about:
      'Directories agents may read but never write, left out of ticket worktrees ' +
      'entirely. The workbench’s own home is always one, whatever is listed here.',
  },
};

/**
 * Everything this workbench is set to. The limits come from the database and take
 * effect at once; the rest comes from the config file and takes effect when the
 * workbench is next started, which each one says.
 */
export function settings(store: Store, config: Config): Setting[] {
  const policy = store.policy();
  const file = readConfigFile(config);

  const limits: Setting[] = POLICY_KEYS.map((key) => ({
    key,
    ...LIMITS[key],
    type: 'number',
    value: policy[key],
    writable: true,
    restart: false,
    group: 'Limits',
  }));

  const configured: Setting[] = Object.entries(CONFIGURED).map(([key, how]) => ({
    key,
    ...how,
    value: file[key] ?? CONFIG_DEFAULTS[key] ?? '',
    writable: true,
    restart: true,
  }));

  return [
    ...limits,
    {
      key: 'maxRevisions',
      label: 'Changes per plan',
      value: MAX_REVISIONS,
      type: 'number',
      about:
        'How many rounds of changes one plan may absorb before an objection is treated ' +
        'as being about the approach and the ticket is re-planned. Fixed: it is what a ' +
        'repeated objection means, not what you will pay for.',
      writable: false,
      restart: false,
      group: 'Limits',
    },
    ...configured,
    ...facts(config),
  ];
}

/** Where this workbench put things. Worked out at startup, not chosen here. */
function facts(config: Config): Setting[] {
  const fact = (key: string, label: string, value: string | string[], about: string): Setting => ({
    key,
    label,
    value,
    type: 'text',
    about,
    writable: false,
    restart: false,
    group: 'Where things are',
  });

  return [
    fact('home', 'Workbench home', config.home, 'Where this workbench keeps everything it has.'),
    fact('repoRoot', 'Repository', config.repoRoot, 'The repository the work happens in.'),
    fact(
      'dbPath',
      'Event log',
      config.dbPath,
      'Every event ever appended. The tickets are derived from it.',
    ),
    fact(
      'agentDirs',
      'Agent files',
      config.agentDirs,
      'Searched in this order, per stage. Saving an agent writes to the first.',
    ),
    fact('pluginRoot', 'Skills', config.pluginRoot, 'The plugin the skills load from.'),
  ];
}

/**
 * Changes some of them. Everything is validated before anything is written, so a
 * bad second value cannot leave the first one changed.
 */
export function applySettings(
  store: Store,
  config: Config,
  patch: Record<string, unknown>,
): Setting[] {
  const known = new Map(settings(store, config).map((s) => [s.key, s]));
  const limits: Record<string, number> = {};
  const configured: Record<string, string | number | string[]> = {};

  for (const [key, raw] of Object.entries(patch)) {
    const setting = known.get(key);
    if (setting === undefined) throw new Error(`no setting called ${key}`);
    if (!setting.writable) throw new Error(`${setting.label} is not something you set`);

    const value = coerce(setting, raw);
    if (setting.group === 'Limits') limits[key] = value as number;
    else configured[key] = value;
  }

  if (Object.keys(limits).length > 0) store.setPolicy(limits);
  if (Object.keys(configured).length > 0) writeConfigFile(config, configured);
  return settings(store, config);
}

/** What the board sent, as the setting's own type — or a complaint naming the setting. */
function coerce(setting: Setting, raw: unknown): string | number | string[] {
  const bad = (complaint: string): never => {
    throw new Error(`${setting.label} ${complaint}`);
  };

  if (setting.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return bad('must be a number');
    // Money is the one that is not a count. Everything else is whole, and a limit
    // of none would be a workbench that can never start anything.
    if (setting.key === 'maxTicketUsd') return n > 0 ? n : bad('must be more than zero');
    if (!Number.isInteger(n)) return bad('must be a whole number');
    const least = setting.key === 'pollMs' ? 1000 : setting.group === 'Limits' ? 1 : 0;
    return n >= least ? n : bad(`must be at least ${least}`);
  }

  if (setting.type === 'lines') {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
    return list.map((one) => String(one).trim()).filter((one) => one !== '');
  }

  const text = String(raw ?? '').trim();
  if (setting.type === 'choice' && !(setting.choices ?? []).includes(text)) {
    return bad(`must be one of ${(setting.choices ?? []).join(', ')}`);
  }
  if (text === '' && setting.key !== 'about') return bad('cannot be empty');
  return text;
}

function readConfigFile(config: Config): Record<string, string | number | string[]> {
  const raw = fs.readFileSync(path.join(config.home, CONFIG_FILE), 'utf8');
  return JSON.parse(raw) as Record<string, string | number | string[]>;
}

/**
 * The file, with these changed. A value back at its default is *removed* rather
 * than written: the file says what this project decided, and one that lists every
 * default is one nobody can read for what is unusual about it.
 */
export function writeConfigFile(
  config: Config,
  changes: Record<string, string | number | string[]>,
): void {
  const file = { ...readConfigFile(config), ...changes };
  for (const [key, value] of Object.entries(changes)) {
    if (JSON.stringify(value) === JSON.stringify(CONFIG_DEFAULTS[key])) delete file[key];
  }
  fs.writeFileSync(path.join(config.home, CONFIG_FILE), `${JSON.stringify(file, null, 2)}\n`);
}

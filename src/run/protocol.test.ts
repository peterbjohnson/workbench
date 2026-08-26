import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readApproval,
  readCompletionCriteria,
  readLater,
  readScale,
  readStep,
  readSteps,
} from './protocol.ts';

test('plan and implement have no verdict to read', () => {
  assert.deepEqual(readApproval('plan', 'here is a plan'), {});
  assert.deepEqual(readApproval('implement', 'REJECTED: irrelevant here'), {});
});

test('APPROVED on the last line passes the stage', () => {
  assert.deepEqual(readApproval('review', 'Looks fine.\n\nAPPROVED'), {});
  assert.deepEqual(readApproval('review', 'Looks fine.\n\nAPPROVED\n\n  \n'), {});
  assert.deepEqual(readApproval('verify', '  APPROVED  '), {});
});

test('REJECTED carries its reason to the next plan', () => {
  assert.deepEqual(readApproval('review', 'Found a bug.\nREJECTED: retries are unbounded'), {
    rejected: 'retries are unbounded',
  });
  assert.deepEqual(readApproval('verify', 'REJECTED:   2 tests fail  '), {
    rejected: '2 tests fail',
  });
});

test('an unreadable verdict is treated as a rejection, not as approval', () => {
  for (const text of [
    '',
    'I think it is probably fine',
    'APPROVED with reservations',
    'REJECTED',
    'REJECTED:',
  ]) {
    const result = readApproval('review', text);
    assert.ok(result.rejected, `"${text}" must not read as approval`);
  }
});

test('a mention inside a sentence is not a vote', () => {
  const text = 'The plan said APPROVED would be the marker.\nStill investigating.';
  assert.ok(readApproval('review', text).rejected);
});

test('a verdict is still a verdict with something after it', () => {
  // What t17 did: voted, then listed six things for later, and was sent round again
  // for not having voted. The verdict is a marker like any other and is found where
  // it is — the instructions cannot have both it and `LATER:` be the final line.
  const t17 = ['## APPROVED', '', 'LATER:', '- the schematic draws the channel as water'].join(
    '\n',
  );

  assert.deepEqual(readApproval('review', t17), {});
  assert.deepEqual(readLater(t17), { later: ['the schematic draws the channel as water'] });

  assert.deepEqual(readApproval('review', 'APPROVED\nbut worth a look one day'), {});
  assert.deepEqual(readApproval('verify', '**APPROVED**'), {});
  assert.deepEqual(readApproval('review', '### REJECTED: the model is inverted\n\nLATER:\n- x'), {
    rejected: 'the model is inverted',
  });

  // A later objection still beats an earlier approval: the safe direction.
  assert.deepEqual(readApproval('review', '## APPROVED\n\nCHANGES:\n- the units are wrong'), {
    changes: '- the units are wrong',
  });
});

test('only the plan declares a scale', () => {
  for (const stage of ['implement', 'review', 'verify'] as const) {
    assert.deepEqual(readScale(stage, 'SCALE: small'), {}, `${stage} does not get a say`);
  }
});

test('the plan says how much the work warrants', () => {
  assert.deepEqual(readScale('plan', 'the plan\n\nSCALE: small'), { scale: 'small' });
  assert.deepEqual(readScale('plan', 'the plan\n\nSCALE: large'), { scale: 'large' });
  assert.deepEqual(readScale('plan', 'the plan\n\n  scale: Small  '), { scale: 'small' });
});

test('a plan that does not say, or cannot be read, gets standard rather than small', () => {
  // The same principle as an unreadable verdict counting as a rejection: forgetting
  // to say must never be the cheap way to buy yourself a lighter review.
  for (const text of [
    'a plan with no verdict line at all',
    '',
    'SCALE: tiny',
    'SCALE:',
    'SCALE: small-ish',
    'I would call this SCALE: small if pushed',
  ]) {
    assert.deepEqual(readScale('plan', text), { scale: 'standard' }, `"${text}"`);
  }
});

test('the scale line is found wherever the plan put it last', () => {
  // Unlike the verdict, this need not be the final line — a plan often signs off
  // after it. The last one that parses wins.
  const text = 'the plan\n\nSCALE: large\n\nThat is my assessment.';
  assert.deepEqual(readScale('plan', text), { scale: 'large' });
});

test('the plan says what the work breaks into', () => {
  const text = [
    'Here is the plan. It changes two files.',
    '',
    'STEPS:',
    '1. Add readSteps beside readScale',
    '2. Carry the steps on to the ticket',
    '3) Show the checklist in the panel',
    '',
    'SCALE: standard',
  ].join('\n');

  assert.deepEqual(readSteps('plan', text), {
    steps: [
      'Add readSteps beside readScale',
      'Carry the steps on to the ticket',
      'Show the checklist in the panel',
    ],
  });
});

test('only the plan declares steps, and a plan need not declare any', () => {
  for (const stage of ['implement', 'review', 'verify'] as const) {
    assert.deepEqual(readSteps(stage, 'STEPS:\n1. not yours'), {});
  }

  // No block, and a block that lists nothing. Both leave the ticket without steps,
  // which costs it the checklist and nothing else.
  assert.deepEqual(readSteps('plan', 'a plan with no steps in it'), {});
  assert.deepEqual(readSteps('plan', 'STEPS:\n\nnothing numbered here'), {});
});

test('prose after the steps is not a step', () => {
  const text = 'STEPS:\n1. Do the thing\n\nThe second half is the risky part.\n2. Not this';
  assert.deepEqual(readSteps('plan', text), { steps: ['Do the thing'] });
});

test('a stage announces the step it has reached', () => {
  assert.equal(readStep('STEP 2'), 2);
  assert.equal(readStep('Right, on with it.\n\nSTEP 3 — the checklist\n\nReading first.'), 3);
  assert.equal(readStep('step 1'), 1);

  // The furthest one wins: an agent that closes one step and opens the next in a
  // single message is at the next.
  assert.equal(readStep('STEP 1 done\nSTEP 2 starting'), 2);

  assert.equal(readStep('I will do step 2 next'), undefined, 'prose is not an announcement');
  assert.equal(readStep('nothing here'), undefined);
});

test('review can ask for changes rather than reject outright', () => {
  const text = [
    'The approach is sound. Three things are wrong.',
    '',
    'CHANGES:',
    '- calcs_v04.md:12 the headline claim contradicts table 2',
    '- calcs_v04.md:31 "4% leaves 2.02" is neither 2.02 nor constant',
  ].join('\n');

  assert.deepEqual(readApproval('review', text), {
    changes:
      '- calcs_v04.md:12 the headline claim contradicts table 2\n' +
      '- calcs_v04.md:31 "4% leaves 2.02" is neither 2.02 nor constant',
  });

  // Both stages that judge get the same three verdicts.
  assert.ok(readApproval('verify', 'CHANGES:\n- the probe fails on an empty file').changes);
  // Written on one line rather than as a block.
  assert.deepEqual(readApproval('review', 'CHANGES: fix the units'), { changes: 'fix the units' });
});

test('an explicit verdict is the last word, whatever came before it', () => {
  // A reviewer that lists objections and then rejects means the rejection: the
  // single-line verdicts are read from the end.
  assert.deepEqual(readApproval('review', 'CHANGES:\n- a\n\nREJECTED: wrong problem'), {
    rejected: 'wrong problem',
  });
  assert.deepEqual(readApproval('review', 'CHANGES:\n- a\n\nAPPROVED'), {});
});

test('an empty changes block is not a verdict', () => {
  // Silence is not approval, and neither is a heading with nothing under it.
  const verdict = readApproval('review', 'Looks fine to me.\n\nCHANGES:');
  assert.ok(verdict.rejected);
  assert.equal(verdict.changes, undefined, 'a heading with nothing under it sends nothing back');
});

test('the plan says when the ticket is finished', () => {
  const text = [
    'A plan for the report.',
    '',
    'COMPLETION CRITERIA:',
    '- every number matches calcs_v03.py',
    '- the three existing figures are referenced',
    '',
    'STEPS:',
    '1. Draft it',
    '',
    'SCALE: small',
  ].join('\n');

  assert.deepEqual(readCompletionCriteria('plan', text), {
    completionCriteria: [
      'every number matches calcs_v03.py',
      'the three existing figures are referenced',
    ],
  });
  // The blocks do not bleed into each other.
  assert.deepEqual(readSteps('plan', text), { steps: ['Draft it'] });

  assert.deepEqual(
    readCompletionCriteria('review', text),
    {},
    'only the plan sets the finish line',
  );
  assert.deepEqual(readCompletionCriteria('plan', 'a plan with no conditions'), {});

  // A clean break: the old heading is no longer a heading.
  const old = 'A plan for the report.\n\nDONE WHEN:\n- every number matches calcs_v03.py';
  assert.deepEqual(readCompletionCriteria('plan', old), {});
});

test('improvements that are not this ticket are kept apart from the verdict', () => {
  const text = [
    'It meets every condition.',
    '',
    'LATER:',
    '- Put units in the captions — the four figures label the axes but not the',
    '  units, so a reader has to find them in the table above.',
    '- Extract the retry helper',
    '',
    'APPROVED',
  ].join('\n');

  // An item long enough to say something is one long enough to wrap, and a wrapped
  // one used to end the list where it wrapped — losing every item after it.
  assert.deepEqual(readLater(text), {
    later: [
      'Put units in the captions — the four figures label the axes but not the units, so a reader has to find them in the table above.',
      'Extract the retry helper',
    ],
  });
  // Suggesting things is not objecting to them.
  assert.deepEqual(readApproval('review', text), {});
  assert.deepEqual(readLater('nothing to add'), {});
});

test('a block of objections stops where the next block starts', () => {
  // Without this the CHANGES list ran to the end of the message, so the
  // reviewer's suggestions arrived as things the implementer had to fix.
  const text = [
    'CHANGES:',
    '- the units are wrong',
    '',
    'LATER:',
    '- the captions could carry the units',
  ].join('\n');

  assert.deepEqual(readApproval('review', text), { changes: '- the units are wrong' });
  assert.deepEqual(readLater(text), { later: ['the captions could carry the units'] });
});

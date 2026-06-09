import assert from 'node:assert/strict';

import {
  applyPlannerResultAndSend,
  extractLastNPlots,
  formatPlotsBlock,
} from '../ena-planner/ena-planner-runtime-utils.js';

{
  const chat = [
    { mes: 'no plot here' },
    { mes: '<plot>old one</plot>\n<plot>old two</plot>' },
    { mes: 'assistant says <plot>new one</plot>' },
  ];
  assert.deepEqual(extractLastNPlots(chat, 2), [
    '<plot>new one</plot>',
    '<plot>old two</plot>',
  ]);
  assert.deepEqual(extractLastNPlots(chat, 0), []);
  assert.deepEqual(extractLastNPlots(null, 3), []);
}

{
  const block = formatPlotsBlock([
    '<plot>newest</plot>',
    '<plot>older</plot>',
  ]);
  assert.equal(
    block,
    '<previous_plots>\n【plot -2】\n<plot>older</plot>\n\n【plot -1】\n<plot>newest</plot>\n</previous_plots>',
  );
  assert.equal(formatPlotsBlock([]), '');
}

{
  const order = [];
  const textarea = { value: 'raw' };
  const button = { click: () => order.push('click') };
  const plannerState = { bypassNextSend: false, lastInjectedText: '' };
  const plannerRecall = { result: { selected: ['memory-a'] } };
  const runtime = {
    preparePlannerRecallHandoff(payload) {
      order.push('handoff');
      assert.equal(payload.rawUserInput, 'raw input');
      assert.equal(payload.plannerAugmentedMessage, 'raw input\n\n<plot>next</plot>');
      assert.equal(payload.plannerRecall, plannerRecall);
    },
  };

  const result = applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput: 'raw input',
    filtered: '<plot>next</plot>',
    plannerRecall,
    runtime,
    plannerState,
  });

  assert.deepEqual(order, ['handoff', 'click']);
  assert.equal(result.applied, true);
  assert.equal(result.handoffPrepared, true);
  assert.equal(textarea.value, 'raw input\n\n<plot>next</plot>');
  assert.equal(plannerState.lastInjectedText, textarea.value);
  assert.equal(plannerState.bypassNextSend, true);
}

{
  const order = [];
  const result = applyPlannerResultAndSend({
    textarea: null,
    button: { click: () => order.push('click') },
  });
  assert.deepEqual(result, { applied: false, reason: 'missing-target' });
  assert.deepEqual(order, []);
}

console.log('ena-planner-plots tests passed');

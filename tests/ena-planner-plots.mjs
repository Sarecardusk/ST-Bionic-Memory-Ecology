import assert from 'node:assert/strict';

import {
  applyPlannerResultAndSend,
  extractLastNPlots,
  formatPlotsBlock,
} from '../ena-planner/ena-planner-runtime-utils.js';
import {
  createStructuredPlotRecord,
  readPlannerPlotHistory,
  writeStructuredPlotRecordToMatchingUserMessage,
  writeStructuredPlotRecordToMessage,
} from '../ena-planner/planner-plot-history.js';

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
      assert.deepEqual(payload.plannerPlotRecord, {
        rawUserInput: 'raw input',
        plannerAugmentedMessage: 'raw input\n\n<plot>next</plot>',
        plotText: '<plot>next</plot>',
      });
    },
  };

  const result = applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput: 'raw input',
    filtered: '<plot>next</plot>',
    plannerRecall,
    plannerPlotRecord: { plotText: '<plot>next</plot>' },
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
  const chat = [
    { is_user: true, mes: 'raw old', extra: {} },
    { is_user: false, mes: '<plot>legacy stale</plot>' },
    { is_user: true, mes: 'raw latest', extra: {} },
  ];
  writeStructuredPlotRecordToMessage(chat[2], createStructuredPlotRecord({
    rawUserInput: 'raw latest',
    plannerAugmentedMessage: 'raw latest\n\n<plot>structured</plot>',
    plotText: '<plot>structured</plot>',
  }));
  const history = readPlannerPlotHistory(chat, { count: 2 });
  assert.equal(history.source, 'structured');
  assert.deepEqual(history.plots, ['<plot>structured</plot>']);
  assert.ok(history.block.includes('<plot>structured</plot>'));
  assert.ok(!history.block.includes('legacy stale'));
}

{
  const chat = [
    { is_user: true, mes: 'raw old', extra: {} },
    { is_user: false, mes: '<plot>legacy old</plot>' },
  ];
  chat[0].extra.st_bme_plot = { version: 999, plotText: '<plot>bad</plot>' };
  const history = readPlannerPlotHistory(chat, { count: 1 });
  assert.equal(history.source, 'legacy');
  assert.deepEqual(history.plots, ['<plot>legacy old</plot>']);
}

{
  const chat = [
    { is_user: true, mes: 'first input', extra: {} },
    { is_user: false, mes: 'assistant' },
    { is_user: true, mes: 'second input', extra: {} },
  ];
  const result = writeStructuredPlotRecordToMatchingUserMessage(chat, {
    rawUserInput: 'first input',
    plannerAugmentedMessage: 'first input\n\n<plot>first plan</plot>',
    plotText: '<plot>first plan</plot>',
  });
  assert.equal(result.index, 0);
  assert.equal(chat[0].extra.st_bme_plot.plotText, '<plot>first plan</plot>');
  assert.equal(chat[2].extra.st_bme_plot, undefined);
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

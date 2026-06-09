export function extractLastNPlots(chat, n) {
    if (!Array.isArray(chat) || chat.length === 0) return [];
    const want = Math.max(0, Number(n) || 0);
    if (!want) return [];

    const plots = [];
    const plotRe = /<plot\b[^>]*>[\s\S]*?<\/plot>/gi;

    for (let i = chat.length - 1; i >= 0; i--) {
        const text = chat[i]?.mes ?? '';
        if (!text) continue;
        const matches = [...text.matchAll(plotRe)];
        for (let j = matches.length - 1; j >= 0; j--) {
            plots.push(matches[j][0]);
            if (plots.length >= want) return plots;
        }
    }
    return plots;
}

export function formatPlotsBlock(plotList) {
    if (!Array.isArray(plotList) || plotList.length === 0) return '';
    const chrono = [...plotList].reverse();
    const lines = [];
    chrono.forEach((p, idx) => {
        lines.push(`【plot -${chrono.length - idx}】\n${p}`);
    });
    return `<previous_plots>\n${lines.join('\n\n')}\n</previous_plots>`;
}

export function applyPlannerResultAndSend({
    textarea,
    button,
    rawUserInput = '',
    filtered = '',
    plannerRecall = null,
    runtime = null,
    plannerState = null,
} = {}) {
    if (!textarea || !button) return { applied: false, reason: 'missing-target' };

    const raw = String(rawUserInput ?? '').trim();
    const merged = `${raw}\n\n${String(filtered ?? '')}`.trim();
    textarea.value = merged;
    if (plannerState && typeof plannerState === 'object') {
        plannerState.lastInjectedText = merged;
    }

    let handoffPrepared = false;
    if (runtime?.preparePlannerRecallHandoff && plannerRecall?.result) {
        runtime.preparePlannerRecallHandoff({
            rawUserInput: raw,
            plannerAugmentedMessage: merged,
            plannerRecall,
        });
        handoffPrepared = true;
    }

    if (plannerState && typeof plannerState === 'object') {
        plannerState.bypassNextSend = true;
    }
    button.click();
    return { applied: true, merged, handoffPrepared };
}

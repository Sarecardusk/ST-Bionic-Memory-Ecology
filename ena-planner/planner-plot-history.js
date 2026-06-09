import {
    extractLastNPlots,
    formatPlotsBlock,
} from './ena-planner-runtime-utils.js';

export const ST_BME_PLOT_HISTORY_KEY = 'st_bme_plot';
export const ST_BME_PLOT_HISTORY_VERSION = 1;

export function hashPlannerPlotInput(text = '') {
    let hash = 2166136261;
    for (const char of String(text || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return String(Math.abs(hash >>> 0));
}

export function createStructuredPlotRecord({
    rawUserInput = '',
    plannerAugmentedMessage = '',
    plotText = '',
    plotBlocks = null,
    promptProfileId = '',
    recallHandoffId = '',
    taskResults = [],
    createdAt = Date.now(),
    inputHash = '',
} = {}) {
    const normalizedRaw = String(rawUserInput || '').trim();
    const normalizedPlot = String(plotText || '').trim();
    const blocks = Array.isArray(plotBlocks)
        ? plotBlocks.map((item) => String(item || '').trim()).filter(Boolean)
        : extractLastNPlots([{ mes: normalizedPlot }], 99);
    return {
        version: ST_BME_PLOT_HISTORY_VERSION,
        inputHash: String(inputHash || hashPlannerPlotInput(normalizedRaw)),
        rawUserInput: normalizedRaw,
        plannerAugmentedMessage: String(plannerAugmentedMessage || '').trim(),
        plotText: normalizedPlot,
        plotBlocks: blocks,
        promptProfileId: String(promptProfileId || ''),
        recallHandoffId: String(recallHandoffId || ''),
        taskResults: Array.isArray(taskResults) ? taskResults : [],
        createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now(),
    };
}

export function normalizeStructuredPlotRecord(value) {
    if (!value || typeof value !== 'object') return null;
    if (Number(value.version) !== ST_BME_PLOT_HISTORY_VERSION) return null;
    const plotText = String(value.plotText || '').trim();
    const plotBlocks = Array.isArray(value.plotBlocks)
        ? value.plotBlocks.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
    if (!plotText && plotBlocks.length === 0) return null;
    return createStructuredPlotRecord({
        ...value,
        plotText,
        plotBlocks,
        createdAt: value.createdAt,
    });
}

export function readStructuredPlotRecordFromMessage(message) {
    return normalizeStructuredPlotRecord(message?.extra?.[ST_BME_PLOT_HISTORY_KEY]);
}

export function collectStructuredPlotRecords(chat, count = 2) {
    if (!Array.isArray(chat) || chat.length === 0) return [];
    const want = Math.max(0, Number(count) || 0);
    if (!want) return [];
    const records = [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const record = readStructuredPlotRecordFromMessage(chat[index]);
        if (!record) continue;
        records.push(record);
        if (records.length >= want) break;
    }
    return records;
}

export function readPlannerPlotHistory(chat, { count = 2 } = {}) {
    const structuredRecords = collectStructuredPlotRecords(chat, count);
    if (structuredRecords.length > 0) {
        const plots = structuredRecords.map((record) => record.plotText || record.plotBlocks.join('\n')).filter(Boolean);
        return {
            source: 'structured',
            records: structuredRecords,
            plots,
            block: formatPlotsBlock(plots),
        };
    }

    const plots = extractLastNPlots(chat, count);
    return {
        source: plots.length > 0 ? 'legacy' : 'empty',
        records: [],
        plots,
        block: formatPlotsBlock(plots),
    };
}

export function writeStructuredPlotRecordToMessage(message, recordInput) {
    if (!message || typeof message !== 'object' || !message.is_user) return false;
    const record = normalizeStructuredPlotRecord(
        recordInput?.version ? recordInput : createStructuredPlotRecord(recordInput),
    );
    if (!record) return false;
    message.extra = message.extra && typeof message.extra === 'object'
        ? message.extra
        : {};
    message.extra[ST_BME_PLOT_HISTORY_KEY] = record;
    return true;
}

export function writeStructuredPlotRecordToMatchingUserMessage(chat, recordInput) {
    if (!Array.isArray(chat)) return null;
    const record = normalizeStructuredPlotRecord(
        recordInput?.version ? recordInput : createStructuredPlotRecord(recordInput),
    );
    if (!record) return null;
    const inputHash = String(record.inputHash || hashPlannerPlotInput(record.rawUserInput));
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message?.is_user) continue;
        if (hashPlannerPlotInput(message.mes || '') !== inputHash) continue;
        if (writeStructuredPlotRecordToMessage(message, record)) {
            return { index, record };
        }
    }
    return null;
}

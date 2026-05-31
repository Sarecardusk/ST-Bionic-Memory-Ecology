export async function rollbackGraphForRerollController(
  runtime,
  { targetFloor, context = runtime.getContext?.() } = {},
) {
  const {
    applyRecoveryPlanToVectorState,
    assertRecoveryChatStillActive,
    buildRecoveryResult,
    buildReverseJournalRecoveryPlan,
    clearHistoryDirty,
    clearInjectionState,
    ensureCurrentGraphRuntimeState,
    findJournalRecoveryPoint,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    isBackendVectorConfig,
    normalizeGraphRuntimeState,
    prepareVectorStateForReplay,
    pruneProcessedMessageHashesFromFloor,
    refreshPanelLiveState,
    rollbackAffectedJournals,
    saveGraphToChat,
    setCurrentGraph,
    setExtractionCount,
    setLastExtractedItems,
    setRuntimeStatus,
    tryDeleteBackendVectorHashesForRecovery,
    updateProcessedHistorySnapshot,
  } = runtime;
  ensureCurrentGraphRuntimeState();
  let currentGraph = getCurrentGraph();
  const chatId = getCurrentChatId(context);
  const buildRerollFailure = (
    recoveryPath,
    error,
    { resultCode = "reroll.rollback.failed", affectedBatchCount = 0 } = {},
  ) => ({
    success: false,
    rollbackPerformed: false,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor: null,
    recoveryPath,
    affectedBatchCount,
    resultCode,
    error,
  });
  const recoveryPoint = findJournalRecoveryPoint(currentGraph, targetFloor);

  if (!recoveryPoint) {
    return buildRerollFailure(
      "unavailable",
      "未找到可用的回滚点，无法安全重新提取。请先执行一次历史恢复或重新提取更早的批次。",
      {
        resultCode: "reroll.rollback.unavailable",
      },
    );
  }

  clearInjectionState();
  setLastExtractedItems([]);

  const config = getEmbeddingConfig();
  const recoveryPath = recoveryPoint.path || "unknown";
  const affectedBatchCount = recoveryPoint.affectedBatchCount || 0;

  if (recoveryPath === "reverse-journal") {
    const recoveryPlan = buildReverseJournalRecoveryPlan(
      recoveryPoint.affectedJournals,
      targetFloor,
    );
    if (recoveryPlan?.valid === false) {
      const invalidReason = String(
        recoveryPlan.invalidReason || "unknown",
      ).trim();
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "reroll-rollback-rejected",
        {
          fromFloor: targetFloor,
          effectiveFromFloor: null,
          path: "reverse-journal",
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: `回滚计划完整性校验失败: ${invalidReason}`,
          debugReason: `reroll-rollback-plan-invalid:${invalidReason}`,
          resultCode: "reroll.rollback.plan-invalid",
          invalidReason,
        },
      );
      saveGraphToChat({ reason: "reroll-rollback-rejected" });
      refreshPanelLiveState();
      return buildRerollFailure(
        "reverse-journal-rejected",
        `回滚计划完整性校验失败: ${invalidReason}`,
        {
          affectedBatchCount,
          resultCode: "reroll.rollback.plan-invalid",
        },
      );
    }
    rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
    currentGraph = getCurrentGraph();
    currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    applyRecoveryPlanToVectorState(recoveryPlan, targetFloor);

    if (
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      setRuntimeStatus(
        "重新提取准备中",
        `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
        "running",
      );
      assertRecoveryChatStillActive(chatId, "reroll-pre-vector");
      await tryDeleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
        undefined,
        {
          source: "reroll",
        },
      );
    }

    if (isBackendVectorConfig(config)) {
      setRuntimeStatus(
        "重新提取准备中",
        "正在准备向量回放状态",
        "running",
      );
    }
    assertRecoveryChatStillActive(chatId, "reroll-pre-prepare");
    await prepareVectorStateForReplay(false, undefined, {
      skipBackendPurge: isBackendVectorConfig(config),
    });
  } else if (recoveryPath === "legacy-snapshot") {
    currentGraph = normalizeGraphRuntimeState(
      recoveryPoint.snapshotBefore,
      chatId,
    );
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    await prepareVectorStateForReplay(false);
  } else {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "reroll-rollback-rejected",
      {
        fromFloor: targetFloor,
        effectiveFromFloor: null,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: `不支持的回滚路径: ${recoveryPath}`,
        debugReason: `reroll-rollback-unsupported:${recoveryPath}`,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
    saveGraphToChat({ reason: "reroll-rollback-rejected" });
    refreshPanelLiveState();
    return buildRerollFailure(
      recoveryPath,
      `不支持的回滚路径: ${recoveryPath}`,
      {
        affectedBatchCount,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
  }

  const effectiveFromFloor = Number.isFinite(
    currentGraph.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor + 1
    : 0;

  clearHistoryDirty(
    currentGraph,
    buildRecoveryResult("reroll-rollback", {
      fromFloor: targetFloor,
      effectiveFromFloor,
      path: recoveryPath,
      affectedBatchCount,
      detectionSource: "manual-reroll",
      reason: "manual-reroll",
      resultCode: "reroll.rollback.applied",
    }),
  );
  if (
    Array.isArray(context?.chat) &&
    Number.isFinite(currentGraph.historyState?.lastProcessedAssistantFloor) &&
    currentGraph.historyState.lastProcessedAssistantFloor >= 0
  ) {
    // Preserve the rolled-back prefix immediately so a failed follow-up
    // re-extraction does not look like a generic "missing processed hashes"
    // corruption on the next history integrity check.
    updateProcessedHistorySnapshot(
      context.chat,
      currentGraph.historyState.lastProcessedAssistantFloor,
    );
  }
  pruneProcessedMessageHashesFromFloor(currentGraph, effectiveFromFloor);
  currentGraph.lastProcessedSeq =
    currentGraph.historyState?.lastProcessedAssistantFloor ?? -1;
  currentGraph.vectorIndexState.lastIntegrityIssue = null;
  saveGraphToChat({ reason: "reroll-rollback-complete" });
  refreshPanelLiveState();

  return {
    success: true,
    rollbackPerformed: true,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor,
    recoveryPath,
    affectedBatchCount,
    resultCode: "reroll.rollback.applied",
    error: "",
  };

}

export async function recoverHistoryIfNeededController(
  runtime,
  { trigger = "history-recovery" } = {},
) {
  const {
    applyRecoveryPlanToVectorState,
    assertRecoveryChatStillActive,
    beginStageAbortController,
    buildRecoveryResult,
    buildReverseJournalRecoveryPlan,
    clampRecoveryStartFloor,
    clearHistoryDirty,
    clearInjectionState,
    createEmptyGraph,
    ensureCurrentGraphRuntimeState,
    enterRestoreLock,
    findJournalRecoveryPoint,
    finishStageAbortController,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    getIsRecoveringHistory,
    getRenderLimitedHistoryRecoveryGuard,
    getSettings,
    inspectHistoryMutation,
    isAbortError,
    isBackendVectorConfig,
    isRestoreLockActive,
    leaveRestoreLock,
    maybeResumePendingAutoExtraction,
    normalizeGraphRuntimeState,
    notifyRenderLimitedHistoryRecoveryBlocked,
    prepareVectorStateForReplay,
    refreshPanelLiveState,
    replayExtractionFromHistory,
    rollbackAffectedJournals,
    saveGraphToChat,
    setCurrentGraph,
    setExtractionCount,
    setIsRecoveringHistory,
    settleExtractionStatusAfterHistoryRecovery,
    throwIfAborted,
    tryDeleteBackendVectorHashesForRecovery,
    updateProcessedHistorySnapshot,
    updateStageNotice,
  } = runtime;
  const toastr = runtime.toastr || {};
  const console = runtime.console || globalThis.console;
  let currentGraph = getCurrentGraph();
  if (!currentGraph || getIsRecoveringHistory()) {
    return !getIsRecoveringHistory();
  }

  ensureCurrentGraphRuntimeState();
  currentGraph = getCurrentGraph();
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) return true;
  const renderLimitedGuard = getRenderLimitedHistoryRecoveryGuard(chat);
  if (renderLimitedGuard.blocked) {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "paused",
      {
        fromFloor: currentGraph.historyState?.historyDirtyFrom ?? null,
        path: "render-limit-guard",
        detectionSource:
          currentGraph.historyState?.lastMutationSource || "render-limit-guard",
        reason: renderLimitedGuard.message,
        resultCode: "history.recovery.paused.render-limit",
        chatLength: renderLimitedGuard.chatLength,
        renderLimit: renderLimitedGuard.renderLimit,
        highestProcessedFloor: renderLimitedGuard.highestProcessedFloor,
      },
    );
    notifyRenderLimitedHistoryRecoveryBlocked(renderLimitedGuard, trigger);
    refreshPanelLiveState();
    return false;
  }

  const detection = inspectHistoryMutation(trigger);
  const dirtyFrom = currentGraph?.historyState?.historyDirtyFrom;
  if (!detection.dirty && !Number.isFinite(dirtyFrom)) {
    return true;
  }
  if (isRestoreLockActive()) {
    return false;
  }

  enterRestoreLock("history-recovery", trigger);
  setIsRecoveringHistory(true);
  clearInjectionState();

  const chatId = getCurrentChatId(context);
  const settings = getSettings();
  const initialDirtyFromRaw = Number.isFinite(dirtyFrom)
    ? dirtyFrom
    : detection.earliestAffectedFloor;
  const initialDirtyFrom = clampRecoveryStartFloor(chat, initialDirtyFromRaw);
  let replayedBatches = 0;
  let usedFullRebuild = false;
  let recoveryPath = "full-rebuild";
  let affectedBatchCount = 0;
  const historyController = beginStageAbortController("history");
  const historySignal = historyController.signal;

  updateStageNotice(
    "history",
    "历史恢复中",
    Number.isFinite(initialDirtyFrom)
      ? `受影响起点楼层 ${initialDirtyFrom} · 正在回滚并重放`
      : "正在回滚并重放受影响后缀",
    "running",
    {
      persist: true,
      busy: true,
    },
  );

  try {
    throwIfAborted(historySignal, "历史恢复已终止");
    const recoveryPoint = findJournalRecoveryPoint(
      currentGraph,
      initialDirtyFrom,
    );
    if (recoveryPoint?.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      const config = getEmbeddingConfig();
      const recoveryPlan = buildReverseJournalRecoveryPlan(
        recoveryPoint.affectedJournals,
        initialDirtyFrom,
      );
      if (recoveryPlan?.valid === false) {
        throw new Error(
          `reverse-journal recovery plan invalid: ${
            recoveryPlan.invalidReason || "unknown"
          }`,
        );
      }
      rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
      currentGraph = getCurrentGraph();
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      setCurrentGraph(currentGraph);
      setExtractionCount(currentGraph.historyState.extractionCount || 0);
      applyRecoveryPlanToVectorState(recoveryPlan, initialDirtyFrom);

      if (
        isBackendVectorConfig(config) &&
        recoveryPlan.backendDeleteHashes.length > 0
      ) {
        updateStageNotice(
          "history",
          "历史恢复中",
          `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
          "running",
          {
            persist: true,
            busy: true,
          },
        );
        assertRecoveryChatStillActive(chatId, "pre-backend-delete");
        await tryDeleteBackendVectorHashesForRecovery(
          currentGraph.vectorIndexState.collectionId,
          config,
          recoveryPlan.backendDeleteHashes,
          historySignal,
          {
            source: "history-recovery",
          },
        );
      }
      if (isBackendVectorConfig(config)) {
        updateStageNotice(
          "history",
          "历史恢复中",
          "正在准备向量回放状态",
          "running",
          {
            persist: true,
            busy: true,
          },
        );
      }
      await prepareVectorStateForReplay(false, historySignal, {
        skipBackendPurge: isBackendVectorConfig(config),
      });
    } else if (recoveryPoint?.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      currentGraph = normalizeGraphRuntimeState(
        recoveryPoint.snapshotBefore,
        chatId,
      );
      setCurrentGraph(currentGraph);
      setExtractionCount(currentGraph.historyState.extractionCount || 0);
      await prepareVectorStateForReplay(false, historySignal);
    } else {
      recoveryPath = "full-rebuild";
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      setCurrentGraph(currentGraph);
      usedFullRebuild = true;
      setExtractionCount(0);
      await prepareVectorStateForReplay(true, historySignal);
    }

    assertRecoveryChatStillActive(chatId, "pre-replay");
    replayedBatches = await replayExtractionFromHistory(
      chat,
      settings,
      historySignal,
      chatId,
    );

    clearHistoryDirty(
      currentGraph,
      buildRecoveryResult(usedFullRebuild ? "full-rebuild" : "replayed", {
        fromFloor: initialDirtyFrom,
        batches: replayedBatches,
        path: recoveryPath,
        detectionSource:
          detection.source ||
          currentGraph?.historyState?.lastMutationSource ||
          "hash-recheck",
        affectedBatchCount,
        replayedBatchCount: replayedBatches,
        reason:
          detection.reason ||
          currentGraph?.historyState?.lastMutationReason ||
          trigger,
      }),
    );
    const recoveredLastProcessedFloor = Number.isFinite(
      currentGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? currentGraph.historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      // Recovery replay has rebuilt the graph state; restore processed hashes so
      // the next hash recheck does not immediately trigger another replay loop.
      updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
    }
    saveGraphToChat({ reason: "history-recovery-complete" });
    refreshPanelLiveState();
    settleExtractionStatusAfterHistoryRecovery(
      "提取完成",
      `历史恢复回放 ${replayedBatches} 批`,
      "success",
    );
    updateStageNotice(
      "history",
      usedFullRebuild ? "历史恢复完成（全量重建）" : "历史恢复完成",
      `path ${recoveryPath} · 起点楼层 ${initialDirtyFrom} · 受影响 ${affectedBatchCount} 批 · 回放 ${replayedBatches} 批`,
      usedFullRebuild ? "warning" : "success",
      {
        busy: false,
        persist: false,
      },
    );
    if (usedFullRebuild) {
      toastr.warning("历史变化已触发全量重建");
    }
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("aborted", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: error?.message || "已手动终止当前恢复流程",
          debugReason: `history-recovery-aborted:${recoveryPath}`,
          resultCode: "history.recovery.aborted",
        }),
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      currentGraph.vectorIndexState.lastWarning = "";
      currentGraph.vectorIndexState.pendingRepairFromFloor = null;
      currentGraph.vectorIndexState.replayRequiredNodeIds = [];
      currentGraph.vectorIndexState.dirty = false;
      currentGraph.vectorIndexState.dirtyReason = "";
      settleExtractionStatusAfterHistoryRecovery(
        "提取已终止",
        error?.message || "历史恢复已终止",
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已终止",
        error?.message || "已手动终止当前恢复流程",
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      saveGraphToChat({ reason: "history-recovery-aborted" });
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      setCurrentGraph(currentGraph);
      setExtractionCount(0);
      await prepareVectorStateForReplay(true, historySignal);
      assertRecoveryChatStillActive(chatId, "pre-fallback-replay");
      replayedBatches = await replayExtractionFromHistory(
        chat,
        settings,
        historySignal,
        chatId,
      );
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("full-rebuild", {
          fromFloor: 0,
          batches: replayedBatches,
          path: "full-rebuild",
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: `恢复失败后兜底全量重建: ${error?.message || error}`,
          debugReason: `history-recovery-fallback-full-rebuild:${recoveryPath}`,
          resultCode: "history.recovery.fallback-full-rebuild",
        }),
      );
      const recoveredLastProcessedFloor = Number.isFinite(
        currentGraph?.historyState?.lastProcessedAssistantFloor,
      )
        ? currentGraph.historyState.lastProcessedAssistantFloor
        : -1;
      if (recoveredLastProcessedFloor >= 0) {
        updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
      }
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-fallback-rebuild" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取完成",
        `历史恢复已退化为全量重建，回放 ${replayedBatches} 批`,
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已退化为全量重建",
        `path full-rebuild · 起点楼层 ${initialDirtyFrom} · 回放 ${replayedBatches} 批`,
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.warning("历史恢复已退化为全量重建");
      return true;
    } catch (fallbackError) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "failed",
        {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: String(fallbackError),
          debugReason: `history-recovery-failed:${recoveryPath}`,
          resultCode: "history.recovery.failed",
        },
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-failed" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取失败",
        fallbackError?.message || String(fallbackError),
        "error",
      );
      updateStageNotice(
        "history",
        "历史恢复失败",
        fallbackError?.message || String(fallbackError),
        "error",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.error(`历史恢复失败: ${fallbackError?.message || fallbackError}`);
      return false;
    }
  } finally {
    finishStageAbortController("history", historyController);
    leaveRestoreLock("history-recovery");
    setIsRecoveringHistory(false);
    const enqueueMicrotask =
      typeof runtime.queueMicrotask === "function"
        ? runtime.queueMicrotask
        : typeof globalThis.queueMicrotask === "function"
          ? globalThis.queueMicrotask.bind(globalThis)
          : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction("history-recovery-finished");
      }
    });
  }

}

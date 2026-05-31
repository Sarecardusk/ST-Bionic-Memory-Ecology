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

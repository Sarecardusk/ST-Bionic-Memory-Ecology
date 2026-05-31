// ST-BME history-mutation notice helpers.
//
// Extracted from index.js so the notice wording/contract can be tested by
// direct import instead of slicing index.js. Side effects are delivered through
// an injected updateStageNotice, so this module holds no global state.

/**
 * Emits the "history changed" stage notice (persistent + busy), without a
 * generic warning toast.
 *
 * @param {object} args
 * @param {number} args.dirtyFrom floor index after which recovery will run
 * @param {string} [args.reason] optional human-readable reason
 * @param {(stage: string, title: string, body: string, level: string, opts?: object) => void} args.updateStageNotice
 */
export function notifyHistoryDirtyNotice({ dirtyFrom, reason, updateStageNotice }) {
  if (typeof updateStageNotice !== "function") return;
  updateStageNotice(
    "history",
    "检测到楼层历史变化",
    `将从楼层 ${dirtyFrom} 之后自动恢复${reason ? `\n${reason}` : ""}`,
    "warning",
    {
      persist: true,
      busy: true,
    },
  );
}

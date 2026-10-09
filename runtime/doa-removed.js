export function captureCurrentHostTransactionContextShim() {
  return null;
}

export function deriveAuthorityUpgradeState() {
  return "standalone";
}

export function createDefaultAuthorityCapabilityState() {
  return {
    installed: false,
    healthy: true,
    reason: "tauritavern-native",
    triviumPrimaryReady: true,
    storagePrimaryReady: true,
    sqlPrimaryReady: false,
    jobsReady: false,
    blobReady: false,
    serverPrimaryReady: false,
    lastError: "",
    lastProbeAt: 0,
    missingFeatures: [],
  };
}

export function normalizeAuthoritySettings(settings = {}) {
  return settings && typeof settings === "object" ? settings : {};
}

export function normalizeAuthorityCapabilityState(state = {}, settings = {}) {
  return {
    ...createDefaultAuthorityCapabilityState(),
    ...(state && typeof state === "object" ? state : {}),
    triviumPrimaryReady: true,
    storagePrimaryReady: true,
    sqlPrimaryReady: false,
    jobsReady: false,
    blobReady: false,
  };
}

export async function probeAuthorityCapabilities() {
  return createDefaultAuthorityCapabilityState();
}

export function createAuthorityBrowserState() {
  return { queue: [], lastProbeAt: 0, lastError: "" };
}

export function getAuthorityBrowserStateSnapshot(state = {}) {
  return state && typeof state === "object" ? { ...state } : createAuthorityBrowserState();
}

export function normalizeAuthorityBrowserState(state = {}) {
  return getAuthorityBrowserStateSnapshot(state);
}

export function recordAuthorityAcceptedRevision() {
  return null;
}

export function buildAuthorityJobIdempotencyKey() {
  return "";
}

export function createAuthorityJobAdapter() {
  return {
    async submit() {
      return null;
    },
    async list() {
      return [];
    },
    async requeue() {
      return null;
    },
  };
}

export function mergeAuthorityRecentJobs(jobs = []) {
  return Array.isArray(jobs) ? jobs : [];
}

export function normalizeAuthorityJobConfig() {
  return { enabled: false };
}

export async function trackAuthorityJobUntilTerminal() {
  return { status: "skipped", reason: "tauritavern-native" };
}

export function applyAuthorityCheckpointToStore() {
  return { applied: false, reason: "tauritavern-native" };
}

export function buildAuthorityConsistencyRepairPlan() {
  return { actions: [] };
}

export function buildAuthorityConsistencyAudit() {
  return { ok: true, actions: [], reason: "tauritavern-native" };
}

export function isAuthorityReplicaSyncRepairAction() {
  return false;
}

export function createAuthorityBlobAdapter() {
  return {
    async writeFile() {
      return { ok: false, reason: "tauritavern-native" };
    },
    async readFile() {
      return null;
    },
    async delete() {
      return { ok: false };
    },
  };
}

export function normalizeAuthorityBlobConfig() {
  return { enabled: false };
}

export const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = 12;

export function buildAuthorityDiagnosticsBundle() {
  return { ok: false, reason: "tauritavern-native" };
}

export function buildAuthorityDiagnosticsBundlePath() {
  return "";
}

export function buildAuthorityDiagnosticsManifestPath() {
  return "";
}

export function buildAuthorityPerformanceBaseline() {
  return null;
}

export function buildAuthorityPerformanceBaselineComparison() {
  return null;
}

export async function readAuthorityDiagnosticsManifest() {
  return { entries: [] };
}

export async function removeAuthorityDiagnosticsManifestEntry() {
  return { entries: [] };
}

export async function upsertAuthorityDiagnosticsManifestEntry() {
  return { entries: [] };
}

export async function writeAuthorityDiagnosticsBundle() {
  return { ok: false, reason: "tauritavern-native" };
}

export function createAuthorityUpgradeState() {
  return "standalone";
}

export async function skippedCloudSync(reason = "tt-sync") {
  return { skipped: true, reason };
}

export const autoSyncOnChatChange = skippedCloudSync;
export const autoSyncOnVisibility = skippedCloudSync;
export const backupToServer = skippedCloudSync;
export const restoreFromServer = skippedCloudSync;
export const scheduleUpload = skippedCloudSync;
export const syncNow = skippedCloudSync;
export const deleteRemoteSyncFile = skippedCloudSync;
export const deleteServerBackup = skippedCloudSync;
export const listServerBackups = async () => [];
export const createRestoreSafetySnapshot = skippedCloudSync;
export const rollbackFromRestoreSafetySnapshot = skippedCloudSync;
export const getRestoreSafetySnapshotStatus = () => ({ available: false });
export function buildRestoreSafetyChatId(chatId = "") {
  return String(chatId || "");
}

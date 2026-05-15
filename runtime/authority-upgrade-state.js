export const AUTHORITY_UPGRADE_MODES = Object.freeze({
  STANDALONE: "standalone",
  PROBING: "probing",
  SHADOW: "authority-shadow",
  CANDIDATE: "authority-candidate",
  ENHANCED: "authority-enhanced",
  DEGRADED: "authority-degraded",
});

function normalizeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function createAuthorityUpgradeState(overrides = {}) {
  const mode = normalizeString(overrides.mode, AUTHORITY_UPGRADE_MODES.STANDALONE);
  return {
    mode,
    text: normalizeString(overrides.text, "纯前端模式"),
    meta: normalizeString(overrides.meta, "未检测到可用服务端增强，BME 将继续本地运行"),
    level: normalizeString(overrides.level, "idle"),
    ready: Boolean(overrides.ready),
    reason: normalizeString(overrides.reason, "standalone"),
    serverPrimaryReady: Boolean(overrides.serverPrimaryReady),
    storageReady: Boolean(overrides.storageReady),
    vectorReady: Boolean(overrides.vectorReady),
    jobsReady: Boolean(overrides.jobsReady),
    browserCacheMode: normalizeString(overrides.browserCacheMode, "minimal"),
    updatedAt: normalizeString(overrides.updatedAt, new Date().toISOString()),
  };
}

export function deriveAuthorityUpgradeState({
  settings = {},
  capability = {},
  browserState = {},
  now = Date.now(),
} = {}) {
  const enabledMode = normalizeString(settings.authorityEnabled ?? capability.enabledMode, "auto");
  const primaryWhenAvailable = settings.authorityPrimaryWhenAvailable !== false;
  const storageReady = Boolean(capability.storagePrimaryReady);
  const vectorReady = Boolean(capability.triviumPrimaryReady);
  const serverPrimaryReady = Boolean(capability.serverPrimaryReady || storageReady);
  const jobsReady = Boolean(capability.jobsReady);
  const browserCacheMode = normalizeString(browserState.mode, "minimal");
  const reason = normalizeString(capability.reason || capability.lastError, "standalone");
  const updatedAt = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();

  if (enabledMode === "off" || enabledMode === "false") {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.STANDALONE,
      text: "纯前端模式",
      meta: "服务端增强已关闭，BME 将继续本地运行",
      level: "idle",
      reason: "authority-disabled",
      browserCacheMode,
      updatedAt,
    });
  }

  if (!capability.installed) {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.STANDALONE,
      text: "纯前端模式",
      meta: "未检测到 DOA/Authority，已自动使用本地稳定路径",
      level: "idle",
      reason,
      browserCacheMode,
      updatedAt,
    });
  }

  if (!capability.healthy || !capability.sessionReady || !capability.permissionReady) {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.DEGRADED,
      text: "已自动回退",
      meta: `服务端增强暂不可用：${reason}`,
      level: "warning",
      reason,
      browserCacheMode,
      updatedAt,
    });
  }

  if (!primaryWhenAvailable) {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.SHADOW,
      text: "服务端影子同步",
      meta: "DOA/Authority 可用，但当前仍以本地路径为主",
      level: "info",
      reason: "primary-disabled",
      serverPrimaryReady,
      storageReady,
      vectorReady,
      jobsReady,
      browserCacheMode,
      updatedAt,
    });
  }

  if (storageReady && vectorReady) {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.ENHANCED,
      text: "服务端增强已启用",
      meta: jobsReady
        ? "图谱与向量存储已自动升级到 DOA/Authority 增强路径"
        : "图谱与向量存储已增强，服务端后台任务能力暂不可用",
      level: "success",
      ready: true,
      reason: "authority-ready",
      serverPrimaryReady,
      storageReady,
      vectorReady,
      jobsReady,
      browserCacheMode,
      updatedAt,
    });
  }

  if (storageReady || vectorReady) {
    return createAuthorityUpgradeState({
      mode: AUTHORITY_UPGRADE_MODES.CANDIDATE,
      text: "服务端增强准备中",
      meta: storageReady
        ? "图谱服务端存储可用，向量增强仍在等待能力确认"
        : "向量服务端能力可用，图谱服务端存储仍在等待能力确认",
      level: "info",
      reason: "partial-authority-ready",
      serverPrimaryReady,
      storageReady,
      vectorReady,
      jobsReady,
      browserCacheMode,
      updatedAt,
    });
  }

  return createAuthorityUpgradeState({
    mode: AUTHORITY_UPGRADE_MODES.DEGRADED,
    text: "已自动回退",
    meta: `DOA/Authority 已连接，但关键能力未就绪：${reason}`,
    level: "warning",
    reason,
    serverPrimaryReady,
    storageReady,
    vectorReady,
    jobsReady,
    browserCacheMode,
    updatedAt,
  });
}

export function formatAuthorityUpgradeMeta(meta = "", upgradeState = {}) {
  const baseMeta = normalizeString(meta, "准备就绪");
  const text = normalizeString(upgradeState?.text, "");
  if (!text) return baseMeta;
  return `${baseMeta} · ${text}`;
}

export const TAURITAVERN_HOST_MISSING = "tauritavern_host_missing";
export const TAURITAVERN_DB_MISSING = "tauritavern_db_missing";

export function getTauriTavernHost() {
  const host = globalThis.__TAURITAVERN__;
  return host && typeof host === "object" ? host : null;
}

export function isTauriTavernHostAvailable() {
  return Boolean(getTauriTavernHost());
}

export function getTauriTavernDbApi(host = getTauriTavernHost()) {
  const db = host?.api?.db;
  return db && typeof db.open === "function" ? db : null;
}

export async function waitForTauriTavernReady() {
  const host = getTauriTavernHost();
  if (!host) {
    const error = new Error("ST-BME requires TauriTavern");
    error.code = TAURITAVERN_HOST_MISSING;
    throw error;
  }
  const ready = host.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
  if (ready && typeof ready.then === "function") {
    await ready;
  }
  if (!getTauriTavernDbApi(host)) {
    const error = new Error("TauriTavern database API is unavailable");
    error.code = TAURITAVERN_DB_MISSING;
    throw error;
  }
  return host;
}

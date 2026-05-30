// ST-BME restrained rebirth — Phase 4 reroll transaction boundary tests.

import assert from "node:assert/strict";
import {
  consumeRerollRecallReuseMarker,
  createRerollRecallReuseMarker,
} from "../runtime/reroll-transaction-boundary.js";

const hashRecallInput = (text) => `h:${String(text || "").trim()}`;

const prepared = createRerollRecallReuseMarker({
  chatId: "chat-a",
  fromFloor: 4,
  targetUserMessageIndex: 2,
  userText: "  hello\n",
  persistedRecord: {
    injectionText: "memory",
    boundUserFloorText: "hello",
  },
  hashRecallInput,
  now: 1000,
});
assert.equal(prepared.reason, "prepared");
assert.equal(prepared.marker.chatId, "chat-a");
assert.equal(prepared.marker.fromFloor, 4);
assert.equal(prepared.marker.targetUserMessageIndex, 2);
assert.equal(prepared.marker.userHash, "h:hello");

const consumed = consumeRerollRecallReuseMarker({
  marker: prepared.marker,
  activeChatId: "chat-a",
  latestUserMessageIndex: 2,
  currentUserText: "hello",
  hashRecallInput,
  now: 1500,
  ttlMs: 5000,
});
assert.equal(consumed.consumed, true);
assert.equal(consumed.override.rerollRecallReuse, true);
assert.equal(consumed.override.targetUserMessageIndex, 2);

console.log("  ✓ reroll recall reuse marker is one-shot and floor-bound");

assert.equal(
  createRerollRecallReuseMarker({
    userText: "changed",
    persistedRecord: { injectionText: "memory", boundUserFloorText: "original" },
  }).reason,
  "bound-user-floor-mismatch",
);
assert.equal(
  createRerollRecallReuseMarker({
    userText: "hello",
    persistedRecord: { injectionText: "" },
  }).reason,
  "missing-persisted-recall",
);

for (const [caseName, options, reason] of [
  ["chat", { activeChatId: "other-chat" }, "chat-mismatch"],
  ["ttl", { now: 7001, ttlMs: 5000 }, "expired"],
  ["floor", { latestUserMessageIndex: 3 }, "target-user-floor-changed"],
  ["text", { currentUserText: "changed" }, "user-text-changed"],
]) {
  const result = consumeRerollRecallReuseMarker({
    marker: prepared.marker,
    activeChatId: "chat-a",
    latestUserMessageIndex: 2,
    currentUserText: "hello",
    hashRecallInput,
    now: 1500,
    ttlMs: 5000,
    ...options,
  });
  assert.equal(result.consumed, false, `${caseName} mismatch must reject reuse`);
  assert.equal(result.reason, reason);
  assert.equal(result.marker, null, `${caseName} mismatch must clear marker`);
}

console.log("  ✓ reroll marker rejects stale, cross-chat, changed-floor, changed-text reuse");
console.log("reroll-transaction-boundary tests passed");

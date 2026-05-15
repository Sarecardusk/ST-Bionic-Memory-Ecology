# Temporary Vector Dimension Stability Plan

This is a temporary implementation checklist. It must be deleted after the phases complete.

## Invariants

- BME must work without DOA/Authority.
- DOA is an automatic enhancement layer, not a required mode.
- Default embedding execution stays client-side and supports custom OpenAI-compatible URL/API key.
- Never query an index with a vector from a different vector space.
- Dimension equality is necessary but not sufficient: provider/source URL/model changes create a new vector space even if dimensions match.
- Raw embedding API keys must not be written to manifests, vector-space IDs, logs, or DOA payloads.
- Embedding/vector failures fail open to graph/lexical fallback and must not delete the memory graph.

## Phase 0 — Plan file

- Commit this temporary plan file to `dev`.
- Use it as the cross-repo implementation checklist.

## Phase 1 — BME vector-space identity

- Add a small vector-space helper module.
- Derive stable `vectorSpaceId` from provider/source URL/model/mode/observed dimension.
- Do not include raw API keys.
- Add focused unit tests.
- Push BME `dev`.

## Phase 2 — BME local vector manifest and search gate

- Extend runtime vector state with a local vector manifest.
- Record observed dimension and vectorSpaceId after successful sync.
- Mark stale on model/source/dimension changes.
- Gate local vector search on manifest compatibility.
- Fall back to graph/lexical instead of mixing vectors.
- Push BME `dev`.

## Phase 3 — BME diagnostics/UI

- Surface concise vector-space and rebuild/degraded status in diagnostics/UI.
- Keep messages non-blocking and user friendly.
- Push BME `dev`.

## Phase 4 — DOA apply/manifest validation

- Enhance BME vector apply payload/contracts with vectorSpaceId and observedDim.
- DOA rejects mixed dimensions and vector-space mismatches.
- DOA must not promote manifest-like clean state on invalid batches.
- Push DOA `dev`.

## Phase 5 — BME DOA vector apply metadata

- Send vectorSpaceId/observedDim in BME `/bme/vector-apply` calls when available.
- If DOA rejects dimension/vector-space mismatch, mark vector degraded and fall back.
- Push BME `dev`.

## Phase 6 — Cleanup

- Delete this temporary plan file.
- Run final validation for both repositories.
- Push cleanup.

# Product contract for the core refactor

This contract protects the complete ST-BME product while its internals are replaced. It describes externally observable behavior, not the current module layout. A phase is not complete when code merely builds; every applicable contract below must still pass.

## Product surfaces

| Area | Contract |
| --- | --- |
| Entrances | The SillyTavern options entry, extensions-menu entry, and floating action button all open the same full panel. |
| Panel | Dashboard, Tasks, Actions, Config, Graph, Cognition, and Summary remain available on desktop and mobile. Existing element IDs and action semantics stay stable until a separately approved UI redesign. |
| Recall card | A user message can display its recalled memory and ENA plot, edit or delete the record, rerun recall, and open referenced graph content. |
| Settings | Workflow/Agent mode, memory, retrieval, extraction, maintenance, prompt profiles, ENA, TT-Sync guidance, diagnostics, native acceleration, and Luker tools remain accessible. Selecting Agent mode must not remove or hide the workflow capability controls. |

## Runtime modes

- `workflow` is the default and remains the complete existing product.
- `agent` changes decision and scheduling behavior only. Both modes read and write the same per-chat graph, processed history, recall records, and replication state.
- Existing Workflow controls remain available. Fixed cadence, surprise triggering, and one-turn delay schedule Workflow mode; every other toggle and parameter remains an Agent capability permission or boundary, and Agent cannot enable a capability the user disabled.
- Recall Agent failure falls back to deterministic retrieval. A Background Steward provider failure or missing disposition falls back to the full enabled workflow. A mutating disposition that already started is never invoked a second time after failure; its batch remains pending. Neither path may silently discard a memory task.
- Switching mode does not migrate or copy data. A task already waiting across an async boundary must revalidate its chat lease and history fingerprint before any mutation.
- Agent calls use the BME model configuration.

## Conversation and generation

- Memory belongs to a chat record, never to the whole character card.
- A generation captures its chat and user floor. A late result cannot mutate the active state, prompt, or UI of another chat.
- `GENERATION_AFTER_COMMANDS` and `GENERATE_BEFORE_COMBINE_PROMPTS` keep their first-listener behavior on vanilla SillyTavern. `MESSAGE_SENT` may bind a recall produced before the new user message entered the host chat.
- `MESSAGE_UPDATED` remains a lightweight UI refresh. Edit, delete, swipe, branch, and reroll use their dedicated history semantics.
- MVU analysis guards, TavernHelper Prompt Viewer bypass, Regex integration, Worldbook capability fallback, group-chat targets, and Luker-specific hooks remain product behavior.

## Recall, history, and ENA

- The user turn owns `message.extra.bme_recall`; ENA planning output uses `message.extra.st_bme_plot`.
- A valid reroll reuses the parent user turn's recall after validating its bound input and history fingerprint. Reroll does not execute ENA again.
- Replacing or deleting an assistant turn reverses that turn's graph effects before the replacement is committed. Failure leaves a durable dirty checkpoint and must not acknowledge success.
- Recall, extraction, and recovery operate on frozen chat/graph snapshots. Switching chats or changing the same chat across an async boundary aborts the stale transaction. Foreground recall never waits for an in-flight Steward and never mixes nodes from both sides of its commit boundary.
- An overswipe placeholder is persisted as awaiting replacement; it is never extracted as an empty assistant turn.
- ENA is explicitly enabled. It plans only fresh user sends from the raw user input, augments rather than replaces that input, and cannot suppress normal recall when planner recall is empty.
- ENA planning is leased to one conversation and one unchanged input. Chat switches cancel it; ordinary planner failures fail open by sending the original text. Reroll never reads or consumes a pending planner turn.
- One planner turn handoff carries optional recall and plot data. The normal generation validates it before reuse, and `MESSAGE_SENT` persists both records to the new user floor even when ST Regex or macro expansion transformed the stored message text.

## Persistence and replication

- ST-BME runs as a TauriTavern native extension. The durable graph primary is the host TriviumDB namespace for the current chat. Missing host, a closed/busy database, or a payload over the 7MiB budget fails closed instead of writing IndexedDB, OPFS, or Luker as a substitute primary.
- A successful save means the Trivium namespace accepted the revision and flushed. Caches, metadata, and diagnostics do not turn a failed primary commit into success.
- Cross-device replication is host TT-Sync `extensions.databases`. Each chat is one namespace; sync replaces the whole database and does not merge records. Databases are off in the default sync dataset and must be enabled in Full. After a received sync the database handle is closed; BME reopens it and does not treat an in-flight write as accepted.
- IndexedDB / OPFS snapshots are imported once into an empty namespace, then abandoned as primaries.

## Verification gates

Run `npm run test:product-contract` for the focused contract suite and `npm run test:stable` for the full stable suite. Browser verification uses TauriTavern, not a personal SillyTavern instance.

# Storage & sync

[中文](storage-and-sync.md) · **English**

This page is split out from the [README](../../README.en.md) with ST-BME data storage, host sync, and persistent recall card notes; durable snapshot contract and forward-compat details are in the [storage and formats architecture doc](../architecture/storage-and-formats.md).

### Local primary storage

- The durable primary is the TauriTavern TriviumDB namespace for the current chat. Graph nodes, edges, and vectors share that database.
- Data is isolated per chat; namespaces look like `stbme-{chatHash}-d{dim}`.
- The hot path commits WAL-sharded deltas so a whole-graph snapshot never becomes one payload. The host hard-rejects payloads over 8MiB; the extension keeps a 7MiB budget.
- On load, the graph is restored from that namespace. Missing host or an unavailable database fails closed.

### TT-Sync

Cross-device replication uses host TT-Sync `extensions.databases`, not a separate Cloud Sync replica.

- Each chat is one namespace. Sync replaces the whole database with Exact or PreferNewer; records are not merged.
- Databases are off in the default sync dataset and must be enabled in Full.
- A successful commit `flush()`es so file mtimes reflect that revision.
- A received sync closes the database handle. Writes that see "not open" or "busy" fail and reopen; they are not reported as accepted.
- Concurrent edits to the same chat keep the winning whole database.

The first time an empty namespace opens, an IndexedDB `STBME_{chatId}` or OPFS snapshot still in the WebView is imported once. Graphs that lived only on old Authority SQL with no local copy need a manual export first.

### Compatibility and fallback

- Old `chat_metadata.st_bme_graph` is only used as a migration and fallback source.
- shadow snapshot and metadata-full are recoverable anchors, not the preferred primary storage.
- tombstone is used to sync deletion state and prevent old data from coming back.
- Plugin settings are stored in SillyTavern's `extension_settings.st_bme`.
- Message-level recall is stored in the corresponding user message's `message.extra.bme_recall`.

### Persistent recall cards

A user message with a valid `message.extra.bme_recall` shows a recall card:

- Expand to read the recall text.
- Inspect the recalled subgraph.
- Click a node for details.
- Edit the injected text.
- Delete the persistent recall.
- Rerun recall and overwrite the record.

Priority:

1. A successful new recall this turn is written back to the target user floor.
2. If this turn has no new recall, the current generation's user floor persistent recall is the fallback.
3. If neither exists, injection is cleared.

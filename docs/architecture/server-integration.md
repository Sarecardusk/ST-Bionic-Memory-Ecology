# 宿主集成（TauriTavern / TriviumDB）

ST-BME 只作为 TauriTavern 原生扩展运行。图谱和向量共用 `window.__TAURITAVERN__.api.db`（TriviumDB 0.8.8）。没有这个宿主就停住，不再探测 Authority，也不再把 IndexedDB、OPFS 或 Luker 当成可接受的主存储。

## 核心原则

1. **init 必须等到 `window.__TAURITAVERN__.ready`。** 缺少宿主或 `api.db` 时扩展不启动。
2. **第三方自定义 URL embedding 仍是主流路径。** OpenAI 兼容 `/v1/embeddings`、one-api、new-api、litellm、vLLM、llama.cpp、Ollama 桥接等，都是一等公民。embedding 默认在客户端执行（`embeddingTransportMode` 默认 `"direct"`）。
3. **跨设备同步只走宿主 TT-Sync。** 扩展改不了用户的数据集勾选；面板说明必须在 Full 范围勾选 `extensions.databases`。

## 数据库入口

公开的 `open()` 只有 `dim`、`storageMode`、`syncMode`、`loadTextIndex`、`autoBuildQuiver`、`memoryLimitMb`。宿主用 `..Config::default()` 打开，扩展改不了：

- 单条 payload 上限 `payload_cache_entry_bytes = 8MiB`。超过即 `PayloadTooLarge`，写入直接失败。
- 解析缓存总量 64MiB，只影响缓存，不是这条硬拒绝。

同步单位是整个 namespace 目录，不合并记录。`link()` 只有 label 和 weight，没有边 metadata。

每个聊天一个 namespace：`stbme-` + chatId 的 sha256 前 32 位 hex + `-d` + 向量维度。字符集满足 `[a-z0-9_-]{1,128}`。换嵌入模型就换库。

## 提交与 8MiB

客户端把单条 payload 和单次 invoke JSON 控制在 7MiB 以下。`commitDelta` 先写 WAL 分片，完整 WAL 才重放；meta revision 翻转是对外接受点，然后 `flush()`。单条记忆过大时把正文切成同 namespace 的 `payload-shard` 节点，不写到另一份 `api.extension.store` 同步数据集。

## 向量

向量写在同一图谱节点上，检索走同一个 handle 的 `search` / `updateVector`。嵌入仍由 `vector/embedding.js` 生成。重建索引进扩展内分块跑，不再提交 Authority job。

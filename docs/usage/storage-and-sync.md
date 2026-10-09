# 数据存储与同步

**中文** · [English](storage-and-sync.en.md)

本文从 [README](../../README.md) 拆出 ST-BME 的数据存储、宿主同步与持久召回卡片说明；durable snapshot contract 和 forward-compat 细节见 [存储与格式架构文档](../architecture/storage-and-formats.md)。

### 本地主存储

- 主存储是 TauriTavern 为当前聊天打开的 TriviumDB namespace。图谱节点、边和向量写在同一库里。
- 数据按聊天隔离；namespace 形如 `stbme-{chatHash}-d{dim}`。
- 热路径使用 WAL 分片增量提交，避免把整图塞进一条 payload。宿主单条 payload 上限是 8MiB，扩展把预算收在 7MiB。
- 加载时从该 namespace 恢复图谱。没有宿主或数据库不可用时启动失败。

### TT-Sync

跨设备复制走宿主 TT-Sync 的 `extensions.databases`，不是扩展自己的 Cloud Sync。

- 每个聊天一个 namespace；同步按整库 Exact / PreferNewer 替换，不合并记录。
- 默认同步范围不含数据库，需要在 Full 中勾选 `extensions.databases`。
- 每次接受提交后 `flush()`，让文件 mtime 反映这次提交。
- 接收同步时宿主会关掉数据库。扩展遇到未打开或 busy 就失败并重新打开，不会把进行中的写入报成功。
- 两台设备同时改同一聊天时，整库取胜的一方保留。

首次打开空 namespace 时，如果 WebView 里还有这个聊天的 IndexedDB `STBME_{chatId}` 或 OPFS 快照，会导入一次。只活在旧 Authority SQL 上、本地没有副本的图谱需要自己先导出。

### 兼容与兜底

- 旧版 `chat_metadata.st_bme_graph` 仅作为迁移和兜底来源。
- shadow snapshot 和 metadata-full 是 recoverable 锚点，不是首选主存储。
- tombstone 用于同步删除状态，避免旧数据复活。
- 插件设置存放在 SillyTavern 的 `extension_settings.st_bme`。
- 消息级召回存放在对应用户消息的 `message.extra.bme_recall`。

### 持久召回卡片

带有有效 `message.extra.bme_recall` 的用户消息会显示召回卡片：

- 展开后可查看召回文本。
- 可查看召回子图。
- 可点击节点查看详情。
- 可编辑注入文本。
- 可删除持久召回。
- 可重新召回并覆盖记录。

优先级：

1. 本轮有新召回成功时，使用新召回并写回目标用户楼层。
2. 本轮无新召回时，从当前生成对应用户楼层读取持久召回作为回退。
3. 两者都没有时，清空注入。

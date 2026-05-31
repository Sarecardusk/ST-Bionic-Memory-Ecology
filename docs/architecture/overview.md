# 架构总览

ST-BME 是一个 SillyTavern 第三方前端扩展：在聊天进行时，把对话提炼成一张**记忆图谱**（节点 + 关系），并在生成前把相关记忆召回、注入回提示词。

`manifest.json` 指向 `index.js`（主入口/编排层）和 `style.css`。

## 子系统地图

```
index.js              主入口：事件钩子、设置管理、流程调度、依赖注入组合根
│
├── graph/            记忆图谱数据结构、节点/关系 schema、快照、认知/区域/时间线状态
├── maintenance/      写入链路：提取、整合、压缩、分层总结、智能触发
├── retrieval/        读取链路：混合检索、图扩散、评分、增强、注入格式化
├── vector/           向量索引、直连 embedding、向量空间身份、维度门禁
├── sync/             持久化与同步：IndexedDB/OPFS 存储、快照契约、控制平面模块
├── prompting/        提示词构建、任务预设、正则/世界书/EJS 任务模式
├── llm/              LLM 请求封装
├── runtime/          运行时状态、设置默认值、身份解析、注入式控制器/工厂
├── host/             SillyTavern 宿主适配（事件绑定、上下文、原生渲染）
├── ui/               面板、图谱渲染、消息级 UI、召回卡片
├── ena-planner/      ENA Planner（独立规划子系统）
└── native/           Native/WASM 加速（灰度，fail-open 回退 JS）
```

`index.js` 在这次重构后正在收敛成**组合根（composition root）**：它持有少数模块级运行时状态，并通过 `create*Runtime()` 把依赖显式注入给抽出的控制器模块。详见 [`control-plane.md`](control-plane.md) 和 [`../contributing/conventions.md`](../contributing/conventions.md)。

## 三条数据路径

ST-BME 的运行可以归纳为三条相对独立的链路。

### 写入链路（对话 → 记忆图谱）

助手回复落地后触发，把新对话提炼进图谱。

```
助手消息落层
  → 自动提取计划（够不够触发？智能触发？）
  → 构建结构化提取输入（过滤 think/analysis 等）
  → LLM 提取 → 规范化操作（create/update/delete/link）
  → 写入图谱节点与关系（含时序边）
  → 后处理：整合去重 → 分层总结 → 反思 → 睡眠遗忘 → 压缩
  → 向量同步（为新节点生成 embedding）
  → 持久化到耐久存储层
```

算法细节见 [`../algorithms/extraction.md`](../algorithms/extraction.md) 和 [`../algorithms/consolidation-and-compression.md`](../algorithms/consolidation-and-compression.md)。

### 读取链路（用户输入 → 注入提示词）

生成前触发，把相关记忆召回并注入。

```
解析召回输入（override / 发送意图 / 聊天尾部用户楼层）
  → 可复用的持久召回记录？命中则跳过新检索
  → 向量预筛（多意图拆分 + 多查询）
  → 图扩散（PEDSA 扩散激活）
  → 混合评分（图 + 向量 + 词法 + 重要度 × 时间衰减）
  → 认知边界过滤 + 可选 DPP 多样性 + 可选残差召回
  → 可选 LLM 精排
  → 访问强化 + 可选概率召回
  → 注入格式化（按 POV/区域分桶成表格）
```

算法细节见 [`../algorithms/retrieval.md`](../algorithms/retrieval.md) 和 [`../algorithms/diffusion-and-dynamics.md`](../algorithms/diffusion-and-dynamics.md)。

### 安全链路（保护已有记忆不被误删/误覆盖）

横跨写入和读取，确保宿主的各种异常状态（只渲染最近 N 条、reroll、切换聊天、历史被编辑）不会误清空或覆盖记忆图谱。

```
历史变动检测 → 必要时历史恢复（replay 或全量重建）
渲染切片识别 → 暂停破坏性恢复
Restore Lock → 恢复期间阻断图谱变更
持久化身份校验 → 防止把别的聊天身份当成当前聊天
```

细节见 [`control-plane.md`](control-plane.md) 和 [`../features/history-safety.md`](../features/history-safety.md)。

## 控制平面 vs 数据平面

这次重构的核心理念是把**"做决定"（控制平面）和"执行副作用"（数据平面）分开**：

- **控制平面**：身份解析、持久化确认状态机、图谱可写性门禁、向量门禁、reroll 边界。这些是纯逻辑/策略，已抽成可独立测试的注入式模块。
- **数据平面**：实际的 IndexedDB/OPFS/Authority/Luker 读写。仍在编排层，由控制平面的决定驱动。

这条分界是过去大量 bug（陈旧 pending、未进入聊天、reroll 乱召回、一致性漂移）的修复基础。详见 [`control-plane.md`](control-plane.md)。

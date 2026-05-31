# 持久召回卡片

召回卡片是挂在聊天消息上的 UI 元素，显示"这条消息生成时召回了哪些记忆"。它既是用户可见的透明度功能，也是 reroll 复用的存储载体。

实现：`ui/recall-message-ui.js`、`ui/recall-message-ui-controller.js`、`retrieval/recall-persistence.js`。

## 做什么

每次生成前召回发生时，召回结果（选中的节点、注入文本、输入指纹）被持久化并绑定到对应的用户楼层。卡片把这个记录渲染在消息旁，用户可以看到、展开。

## 为什么持久化

两个目的：

1. **透明度**：用户能看到记忆系统在每轮"想起了什么"。
2. **reroll 复用**：reroll 助手楼层时，如果上方用户楼层没变，已持久化的召回记录可以直接复用，跳过新检索。详见 [`../architecture/control-plane.md`](../architecture/control-plane.md) 的 reroll 不变量和 [`../algorithms/retrieval.md`](../algorithms/retrieval.md) 的持久复用。

## 控制器封装

`ui/recall-message-ui-controller.js` 是一个工厂，封装了卡片挂载/刷新所需的全部状态（定时器、MutationObserver、session、诊断 Map）。这是 VM 测试税重构的产物——这些有状态的 UI 逻辑从 `index.js` 抽出，状态不再泄漏到模块级全局。

## 边界

> 如果第三方主题移除了标准消息 DOM 或楼层索引属性，卡片可能跳过挂载。这是已知限制——卡片依赖宿主的消息 DOM 结构和楼层索引。

MutationObserver 用于在消息 DOM 变动时重新挂载卡片，节流处理避免频繁触发。

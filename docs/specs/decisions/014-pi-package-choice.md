# 014：引擎用 pi-coding-agent，非 agent 的模型调用用 pi-ai

- **状态**：已确认
- **日期**：2026-11-09
- **相关**：001 ／ design.md 第 2 节 ／ tasks.md T1、T6

> 本记录确认后不再修改正文。改变决定时，新写一份记录，并把本记录的状态改为"已被 NNN 取代"。

## 背景

001 决定复用 pi 作为 Harness，但 pi 仓库是多个包组成的，需要明确接入哪一层：

```
pi-coding-agent   内置 read/bash/edit/write、会话、压缩、skill、AGENTS.md、扩展与钩子、MCP（pi-mcp）、SDK/RPC
      ↑
pi-agent-core     通用 agent loop、工具调用、事件流、状态管理、改写上下文的钩子
      ↑
pi-ai             统一的模型 API
```

（依据：各包的 package.json，2026-11-09 查看。）

此外，编排层（工单理解）与记忆服务（前置过滤、召回精选）也需要调用模型，但只是"一次请求、一个答案"，不需要 agent。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 引擎用 pi-coding-agent | 规范依赖的能力（扩展拦截、会话文件、压缩、skill、`resourceLoader`、MCP、`models.json`、SDK）都在这一层 | 默认会自动加载仓库内容，需要关闭（已在 008 处理） |
| B. 引擎用 pi-agent-core | 更轻、控制更多 | 编码工具、会话、压缩、skill、MCP 都要自己写，等于回到自研 Harness，违反 001 |
| C. 只用 pi-ai | — | 连 agent loop 都要自己写 |

非 agent 的模型调用：

| 方案 | 说明 |
|---|---|
| 自己写 HTTP 请求 | 流式、重试、超时都要自己处理 |
| OpenAI SDK | 本地推理服务兼容 OpenAI 接口，可直接用 |
| **pi-ai** | pi 内部使用的模型层，支持多家模型与 OpenAI 兼容的本地服务 |

## pi 的做法

pi-coding-agent 建在 pi-agent-core 之上，pi-agent-core 建在 pi-ai 之上；pi 内部所有模型调用都经过 pi-ai。

## 决定

- 引擎使用 **pi-coding-agent** 的 SDK（方案 A）。
- 编排层与记忆服务等非 agent 的模型调用统一使用 **pi-ai**。

## 理由

- 规范依赖的 pi 能力几乎全部在 pi-coding-agent 层；下层方案等于自研 Harness。
- 全项目只有一种调用模型的方式：模型配置、切换本地推理服务、用量与花费统计口径一致；pi-ai 已随 pi 引入，不增加依赖。

## 后果

- 编排层与记忆服务也受 pi-ai 版本影响；版本锁定，影响面限于模型调用。
- T1 使用 pi-coding-agent 的 SDK；T6 通过 pi-ai 调用本地小模型。

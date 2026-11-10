# 实现说明：step01 T1 接入 pi 与本地模型

- **任务**：tasks.md T1
- **计划**：plans/2026-11-09-T1-pi-integration.md
- **代码版本**：分支 step-01-pi-integration；Task 0A 记录随提交 `docs(step01): 核实执行环境与 pi 资源及 MCP 能力` 入库（产品代码从 Task 1 起，届时在此追加 commit）
- **依据的规范版本**：commit 64d3422（`64d3422158d702510299e0e3bcf89f9f87b76699`）

> 记录"实际发生了什么"。完成后不修改正文，后续变化只在开头追加说明。

## 0. 开工核实

### 0A 环境、资源隔离与 MCP 核实（2026-11-10）

执行者：Task 0A 子 agent（superpowers:subagent-driven-development）。所有探测都在会话临时目录下进行，下文用 `<scratch>` 指代 `/private/tmp/claude-501/<session>/scratchpad/t0a`，用 `<root>` 指代其中的敌意目录树 `<scratch>/hostile`。没有调用任何真实模型 API：模型是 loopback 随机端口上的 OpenAI 兼容桩服务，API key 用的是字面量 `stub-not-a-secret`。没有读取 `.env`。

#### 0A.1 锁定的 pi 版本与官方固定来源

| 项 | 值 | 证据 |
|---|---|---|
| 包 | `@earendil-works/pi-coding-agent` | ADR 014 |
| 锁定版本 | **1.5.0**（确切版本，不用范围） | `npm view @earendil-works/pi-coding-agent versions --json`，退出码 0，列表中有 `1.5.0`，发布于 2026-11-02T11:05:09Z |
| tarball 完整性 | `sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==` | `npm view …@1.5.0 dist.integrity` 的值与 `pnpm add --save-exact …@1.5.0` 生成的 `pnpm-lock.yaml` 中 `resolution.integrity` 一致 |
| engines | `node >=22.19.0` | `npm view …@1.5.0 engines` |
| 内置 MCP 依赖 | `@earendil-works/pi-mcp` **1.5.0**（`sha512-DURw3IwHCTMHV8CzUJWVp9css27NowsCWfXt4xg2r09IZ+P1O/Uq58hp0hb9WJO0dbkaKGXKBIkV4LVXcu2nlg==`） | `npm view …pi-coding-agent@1.5.0 dependencies` 中列出了它和 pi-ai、pi-agent-core、pi-tui、pi-codemode，版本都是 1.5.0 |
| 官方仓库固定点 | <https://github.com/earendil-works/pi/tree/v1.5.0>，tag `v1.5.0` 指向 commit `f9a26365568127461c47a07a37dcb42c140a3ac5`（轻量 tag） | `git ls-remote --tags https://github.com/earendil-works/pi`，退出码 0 |
| tarball 与 tag 是否一致 | 一致：`docs/{sdk,security,mcp,environment-variables,configuration,settings,extensions,skills}.md` 和 `examples/sdk/{07-context-files,12-full-control,14-codemode-mcp}.ts` 这 11 个文件与 commit f9a2636 中 `packages/coding-agent/` 下的同名文件**逐字节相同**。该 commit 的 `packages/coding-agent/package.json` 中 `version=1.5.0` | 附录 A 的 `compare-tag.mjs` 与 `reach.mjs`，退出码 0 |

本文引用的文档和符号都以 tag `v1.5.0`（commit f9a2636）中的 `packages/coding-agent/` 为准。文档按文件名加章节标题或锚点引用，代码按 `dist/` 路径加符号名引用，不使用行号。

另需注意：registry 上已有 **1.5.1**（2026-11-09T23:45Z 发布，tag `v1.5.1` 对应 `dd30101cfc5b0609411dd80b6f93adbc14db14cf`）。它的 CHANGELOG 有两条 Breaking Changes：`GrepOperations.readFile` 不再用于读取上下文行；OpenAI 兼容模型在禁用全部工具时不再发送 `"tools": []`。按计划仍锁定 1.5.0，是否升级由作者决定，见第 6 节。

#### 0A.2 执行环境（环境表中负责人为 0A 的行）

| 环境表行 | 实际命令 | 退出码 | 结果 |
|---|---|---|---|
| Node / pnpm | `node --version` | 0 | `v24.15.0`，满足 ≥ 22.19 |
| | `pnpm --version` | 0 | `10.34.9` |
| | `npm --version` | 0 | `11.12.1` |
| | `uname -sm` | 0 | `Darwin arm64` |
| Git / shell / 文件系统 | `git --version` | 0 | `git version 2.39.5 (Apple Git-154)` |
| | `node -e 'spawnSync("/bin/bash",["--version"])…'`（本会话的 worktree 隔离守卫拒绝直接执行 `bash`/`zsh`，所以通过 Node 子进程获取版本） | 0 | `GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24)`；登录 shell 为 `SHELL=/bin/zsh`；没有安装 Homebrew bash。pi 的 `bash` 工具在 0A.4 的探测中正常执行 |
| | `git -C <scratch>/repoprobe init -q -b main`；`git -C … add a.txt`；`git -C … -c user.name=probe -c user.email=probe@example.invalid commit -q -m probe`；`git -C … show --stat --format=%s HEAD`；`git -C … show HEAD:a.txt` | 全部 0 | 提交成功，show 输出 `probe` 和 `a.txt \| 1 +`，`HEAD:a.txt` 的内容为 `hello` |
| | `touch <scratch>/writetest` | 0 | 临时目录可写 |
| | `git rev-parse --abbrev-ref HEAD`；`git rev-parse HEAD`；`git worktree list` | 0 | 当前分支 `step-01-pi-integration`，HEAD `64d3422158d7…`；工作区位于 `.claude/worktrees/step-01-pi-integration`（主检出目录在 `step-01-pi-plan-review`）；开工时 `git status` 干净 |
| | `git check-ignore -v --no-index .claude/worktrees/step-01-pi-integration/x` | 0 | 命中 `.git/info/exclude` 中的 `.claude/worktrees/`，工作区目录不会被主仓库跟踪 |
| | `git config user.name`；`git config user.email >/dev/null` | 0；0 | 提交身份 name 为 `Jieming Chen`；email 已设置（本文不记录其值） |
| 安装与资料访问（pi 部分） | `npm install --save-exact --ignore-scripts @earendil-works/pi-coding-agent@1.5.0`（在 `<scratch>/pkg` 中） | 0 | 安装了 pi-coding-agent、pi-ai、pi-agent-core、pi-mcp、pi-tui、pi-codemode、pi-schema、pi-telemetry，版本都是 1.5.0；`found 0 vulnerabilities` |
| | `pnpm add --save-exact @earendil-works/pi-coding-agent@1.5.0`（在 `<scratch>/pnpmprobe` 中） | 0 | `Done in 31.2s using pnpm v10.34.9`；pnpm 默认跳过了 `@google/genai`、`protobufjs` 的构建脚本，对探测没有影响 |
| | `npm install --save-exact --ignore-scripts vitest ws zod @modelcontextprotocol/sdk` | 0 | 测试工具可下载：vitest 5.1.0、ws 8.22.2、zod 4.6.7；`@modelcontextprotocol/sdk` 1.32.2 只用来写**探测用的 MCP 服务端**，不是客户端 |
| | `node <scratch>/scripts/compare-tag.mjs …`；`node <scratch>/scripts/reach.mjs` | 0；0 | 能读取固定版本的文档、示例、`.d.ts` 和 tag 源码（见 0A.1） |
| 安装与资料访问（Claude Agent SDK，只检查可达性，内容核实归 0B） | `node <scratch>/scripts/reach.mjs` | 0 | `https://code.claude.com/docs/en/agent-sdk/overview` 返回 HTTP 200；`https://docs.claude.com/en/docs/agent-sdk/overview` 会跳转到同一地址，也返回 200 |
| 本地通信与子进程 | `node probe-net-proc.mjs`（附录 A） | 0 | 输出 `{"http":{"port":49441,"body":"ok"},"ws":{"port":49443,"echoed":"echo:ping"},"child":{"pid":53847,"aliveBefore":true,"exitInfo":{"code":null,"signal":"SIGTERM"},"aliveAfter":false}}`：HTTP 和 WebSocket 都能绑定 `127.0.0.1` 的随机端口并完成往返；以 `detached` 方式启动的 Node 子进程被 `process.kill(-pid,"SIGTERM")` 按进程组清理，之后 `kill(pid,0)` 报错，说明子进程已不存在 |
| 执行与审查能力 | 控制会话列出的技能，以及本子 agent 的 Skill 列表 | — | 执行方式为作者选定的 superpowers:subagent-driven-development。可用技能：superpowers:subagent-driven-development、writing-plans、using-git-worktrees、test-driven-development、verification-before-completion、requesting-code-review、systematic-debugging（控制会话和本子 agent 的 Skill 列表中都有）。Agent（子 agent）工具可用，本任务就是由它派发的。工作区由 `git worktree add .claude/worktrees/step-01-pi-integration -b step-01-pi-integration 64d3422` 创建（控制会话提供），排除规则已用上面的 `check-ignore` 实测 |
| pi SDK（0A 部分） | 见 0A.1、0A.3–0A.5 | — | 版本已锁定为 1.5.0；资源隔离和 MCP 都有固定版本的文档、类型证据和探测证据。事件、取消与清理 API 归 0B |

没有失败的必要能力。

#### 0A.3 资源入口清单（pi 1.5.0 默认会从哪里加载什么）

依据：`docs/configuration.md` 的 "Agent directory"、"Project `.pi` directory"、"Context files"；`docs/security.md` 的 "Understand project trust"、"Resources protected by project trust"；`docs/settings.md` 的 "Resources"；`docs/skills.md` 的 "Add it to Pi"；`docs/environment-variables.md` 的 "Pi Process Configuration"；以及 `dist/core/resource-loader.js` 中的 `loadProjectContextFiles`、`loadContextFileFromDir`、`DefaultResourceLoader.reload`、`discoverSystemPromptFile`、`discoverAppendSystemPromptFile`，`dist/core/package-manager.js` 中的 `DefaultPackageManager.resolve`、`addAutoDiscoveredResources`、`collectAncestorAgentsSkillDirs`，`dist/core/settings-manager.js` 中的 `SettingsManager.create`、`fromStorageWithPaths`、`inMemory`，`dist/extensions/mcp/index.js` 中的 `defaultLoadConfig`，`dist/core/sdk.js` 中的 `createAgentSession`。

`<agentDir>` 是 SDK 的 `agentDir` 选项；不传时取 `getAgentDir()`，即 `PI_CODING_AGENT_DIR` 或 `$HOME/.pi/agent`。下表中的"信任"指 `SettingsManager.isProjectTrusted()`。

| # | 资源 | 默认发现位置 | 需要信任吗 | 明确的关闭 / 注入方式（SDK） | 基线探测（默认配置） | 锁定探测 |
|---|---|---|---|---|---|---|
| 1 | 上下文文件 `AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`（每个目录只取第一个匹配） | `<agentDir>`，以及 `cwd` 和它的**所有祖先目录直到文件系统根**（不在 git 根停止）；处于嵌套 linked worktree 时，主仓库中被遮蔽的同名文件会跳过 | **不需要**，信任与否都会加载 | `noContextFiles: true` 关闭发现；用 `agentsFilesOverride: () => ({ agentsFiles: [...] })` 注入平台提供的文件（它在 `noContextFiles` 之后执行） | 加载了 `envagent/AGENTS.md`、`work/CLAUDE.md`、`work/org/AGENTS.md`、`repo/AGENTS.md` | 只有 `platform://base-ref/AGENTS.md`，系统提示中有 `PLATFORM_AGENTS_FROM_BASE_REF` |
| 2 | 设置 `settings.json` | `<agentDir>/settings.json`；`cwd/.pi/settings.json`（项目设置，需要信任） | 项目设置需要。**SDK 的默认值 `SettingsManager.create()` 是 `projectTrusted = true`** | `SettingsManager.inMemory(平台设置, { projectTrusted: false })`，不读任何文件 | 敌意设置 `defaultTools: ["ls"]` 生效，激活的工具变成 `ls` 加敌意 MCP 工具 | 工具是 `read, bash, mcp__platform__*`，敌意的 `shellCommandPrefix` 没有出现在 bash 输出中 |
| 3 | 系统提示替换 `SYSTEM.md` | 先找 `cwd/.pi/SYSTEM.md`（需要信任），再找 `<agentDir>/SYSTEM.md` | 项目文件需要 | `systemPrompt` 或 `systemPromptOverride`；不传时只会找到平台控制的 `<agentDir>`（空目录），于是使用 pi 默认提示。注意：`systemPrompt` 字符串如果恰好是一个存在的路径，会被当作文件读取（`resolvePromptInput`） | 来源为 `repo/.pi/SYSTEM.md` | 来源为 `null`，没有 HOSTILE 标记 |
| 4 | 系统提示追加 `APPEND_SYSTEM.md` | 先找 `cwd/.pi/APPEND_SYSTEM.md`（需要信任），再找 `<agentDir>/APPEND_SYSTEM.md` | 项目文件需要 | `appendSystemPrompt: []`：传入任何非 undefined 的数组都会跳过发现；也可以用 `appendSystemPromptOverride` | 来源为 `repo/.pi/APPEND_SYSTEM.md` | 没有来源 |
| 5 | 扩展 | `<agentDir>/extensions/`；`cwd/.pi/extensions/`（需要信任）；两级 settings 中的 `extensions` 和 `packages`；内置扩展 `builtin:*`（只有把它以 builtin 形式传给 loader 时才会出现，CLI 会这样做，SDK 默认不会） | 项目部分需要 | `noExtensions: true`：丢弃所有自动发现和 settings 中的路径，但**内联的 `extensionFactories` 仍然加载**；另有 `disabledBuiltinExtensions` | marker 文件显示 `.pi/extensions/evil-repo.ts`、`.pi/extensions/evil-dir/index.ts`、`.pi/settings.json → extra-repo.ts`、`envagent/extensions/evil-envagent.ts`、`envagent/settings.json → extra-envagent.ts` 都经历了模块求值、factory 执行和 `session_start` | 扩展只有 `<inline:mcp>`，**没有任何敌意 marker** |
| 6 | Skill | `<agentDir>/skills/`；`cwd/.pi/skills/`（需要信任）；从 `cwd` 到 git 根的各级 `.agents/skills/`（需要信任）；`$HOME/.agents/skills/`；settings 中的 `skills` 和 `packages` | 项目部分需要 | `noSkills: true`；平台 skill 用 `additionalSkillPaths` 提供（`noSkills` 下仍会加载），也可用 `skillsOverride` | 加载了 `skill-repo`、`skill-repoagents`、`skill-envagent`、`skill-homeagents`（git 根以上的 `skill-ancestor` 按设计不会被发现） | 只有 `platform-skill`，并且出现在系统提示中 |
| 7 | 提示词模板 | `<agentDir>/prompts/`；`cwd/.pi/prompts/`（需要信任）；settings 中的 `prompts` | 项目部分需要 | `noPromptTemplates: true`（也可用 `promptsOverride`） | 加载了 `prompt-repo`、`prompt-envagent` | 无 |
| 8 | 主题 | `<agentDir>/themes/`；`cwd/.pi/themes/`（需要信任）；settings 中的 `themes` | 项目部分需要 | `noThemes: true` | 探测用的主题文件格式无效，基线中也是 0 个，所以**这一项只有代码和文档证据**。主题不影响 agent 行为 | 0 |
| 9 | MCP 配置 `mcp.json` | **`getAgentDir()/mcp.json`，即进程级的 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`，不跟随 SDK 的 `agentDir`**；另有 `cwd/.pi/mcp.json`（需要 `ctx.isProjectTrusted()`） | 项目部分需要 | `createMcpExtension({ loadConfig })` 完全接管配置来源（见 0A.5） | 连上了 `hostile-envagent` 和 `hostile-repo`，`baseline-home` 模式下连上的是 `hostile-homeagent` 和 `hostile-repo` | 只启动了 `platform`；对照模式 `locked-default-mcp` **启动了 `hostile-envagent`** |
| 10 | Pi 包安装 | 两级 settings 中的 `packages`，`DefaultPackageManager.resolve()` 会在 reload 时安装缺失的 npm/git 包（会访问网络） | 项目部分需要 | 使用不含 `packages` 的内存设置 | 未专门探测，fixture 中没有 packages | — |
| 11 | 模型与凭证 | `<agentDir>/models.json`、`auth.json`、`models-store.json`。`ModelRuntime.create()` 不传路径时使用 `getAgentDir()`；`createAgentSession` 只有在显式传入 `agentDir` 时才改用 `agentDir` 下的路径 | — | 显式调用 `ModelRuntime.create({ authPath, modelsPath })` 并传入 `modelRuntime` | — | 探测时使用独立的 `model-<mode>/` 目录，pi 在其中写出了 `auth.json` 和 `models-store.json` |
| 12 | 会话文件 | `SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))`；`PI_CODING_AGENT_SESSION_DIR`；CLI 在解析信任**之前**会读取项目 settings 中的 `sessionDir`（`docs/security.md` 的 "Understand project trust"） | 不需要（CLI 的预读） | 显式传入 `sessionManager`（`SessionManager.inMemory(cwd)`，或指向平台目录），并且不读取项目 settings | — | 使用 inMemory |
| 13 | 信任记录 | `~/.pi/agent/trust.json`（CLI 的信任流程） | — | SDK 不读取它，除非自己的 `resolveProjectTrust` 去读 | — | — |
| 14 | 其他使用 `getAgentDir()` 的位置 | MCP 扩展的 `mcp.log`、`mcp-auth.json` 和 OAuth 锁目录（`dist/extensions/mcp/index.js`、`oauth.js`）；`crash-log.js`（交互模式）；keybindings（TUI） | — | 给 MCP 扩展传 `logPath` 和 `credentials`；runner 进程把 `PI_CODING_AGENT_DIR` 设为平台目录作为纵深防御 | — | 运行后平台目录、`envagent/`、伪 HOME 中都没有新增文件 |

**pi 读取的环境变量**（`docs/environment-variables.md` 的 "Pi Process Configuration"，并对 `dist/**/*.js` 中的 `process.env.*` 做了枚举）：
- 影响资源与配置位置：`PI_CODING_AGENT_DIR`（agentDir 默认值，MCP 扩展默认路径也用它）、`HOME`（`~/.pi/agent`、`~/.agents/skills`、`~` 展开；package-manager 优先使用 `process.env.HOME`，再用 `os.homedir()`）、`PI_CODING_AGENT_SESSION_DIR`、`PI_PACKAGE_DIR`。
- 影响网络与行为：`PI_OFFLINE`（关闭模型目录刷新等自动网络活动）、`PI_SKIP_VERSION_CHECK`、`PI_TELEMETRY`、`PI_CODEMODE_MAX_WORKERS`、`PI_CACHE_RETENTION`、`HTTP_PROXY`/`HTTPS_PROXY`、`LLAMA_BASE_URL`（内置 llama.cpp 扩展）、`SHELL`、`PI_EXPERIMENTAL`、`PI_SELF_UPDATE_COMMAND`、`PI_SHARE_VIEWER_URL`、`PI_RADIUS_GATEWAY`。
- 只影响 TUI：`PI_HARDWARE_CURSOR`、`PI_CLEAR_ON_SHRINK`、`PI_TUI_ESC_TIMEOUT` 等。
- 另外还有各 provider 的 API key 变量（`docs/providers.md`）。
- pi 会给 bash 工具的子命令注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。通过 SDK 嵌入时**不会**设置 `AI_AGENT=pi` 和 `PI_CODING_AGENT=true`。

#### 0A.4 SDK 配置组合（已用敌意目录树实测，供 0B、0C、2B、7、8A 使用）

**探测布局**（由附录 A 的 `setup-hostile.mjs` 生成）：每个发现位置都放了带 `HOSTILE_*` 标记的资源。扩展在模块求值、factory 执行和 `session_start` 三个阶段各写一个 marker 文件；敌意 MCP 服务一启动就写 `mcp-started-<name>`。
- 伪 HOME：`<root>/home`，其中有 `.pi/agent/` 下的整套资源和 `.agents/skills/`。
- 敌意 `PI_CODING_AGENT_DIR`：`<root>/envagent`，其中有整套资源。
- 祖先目录：`<root>/work/CLAUDE.md`、`<root>/work/org/AGENTS.md`、`<root>/work/org/.agents/skills/`。
- 任务仓库 `<root>/work/org/repo`（已 `git init`）：根目录有 `AGENTS.md`、`CLAUDE.md`；`.pi/` 下有 `settings.json`（`defaultProjectTrust: "always"`、`defaultTools: ["ls"]`、`shellCommandPrefix`、`extensions`）、`mcp.json`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`extensions/*.ts`、`extensions/<dir>/index.ts`、`skills/`、`prompts/`、`themes/`；另有 `.agents/skills/`。
- 平台目录：`<root>/platform-agent` 为空；平台 skill 放在 `<root>/platform-skills`。

**对照结果**：
- `baseline`（`SettingsManager.create(repo, getAgentDir())`，`DefaultResourceLoader` 只加了 `extensionFactories: [createMcpExtension()]`，其余是默认值）：上表"基线探测"一列中的敌意资源**全部**加载。系统提示中包含 `HOSTILE_AGENTS_envagent`、`HOSTILE_ANCESTOR_AGENTS`、`HOSTILE_ANCESTOR_CLAUDE`、`HOSTILE_APPEND_repo`、`HOSTILE_REPO_AGENTS`、`HOSTILE_SYSTEM_repo`，共 15 个扩展 marker，两个敌意 MCP 服务都启动了。`baseline-home` 模式不设 `PI_CODING_AGENT_DIR`，结果相同，只是来源变成伪 HOME 下的 `~/.pi/agent`。这一组证明敌意 fixture 能被检测到，所以锁定组的"没加载"不是空目录造成的。
- `locked`（下面的推荐组合）：没有任何 HOSTILE 标记，没有扩展 marker，只启动了 `mcp-started-platform`。模型请求共 4 次，工具声明都是 `read, bash, mcp__platform__echo, mcp__platform__add`，系统提示中没有 HOSTILE 标记。
- `locked-default-mcp`（与 `locked` 相同，只是 MCP 改用 `createMcpExtension()` 的默认配置）：上下文文件、设置、提示词、扩展和 skill 都干净，但 **`mcp-started-hostile-envagent` 出现了**。这说明 MCP 扩展的默认配置不跟随 SDK 的 `agentDir`。

**工具工作目录**（`locked` 组，自定义 resourceLoader）：`bash` 执行 `pwd; cat cwd-marker.txt` 输出 `<root>/work/org/repo` 和 `CWD_MARKER_CONTENT`；`read` 读取相对路径 `cwd-marker.txt` 得到 `CWD_MARKER_CONTENT`。内置工具按 `createAgentSession({ cwd })` 工作，与 resourceLoader 无关（`docs/sdk.md` 的 "Session storage" 一节：`cwd` selects … built-in tool paths）。

**推荐组合**（`locked` 组实际运行的就是这段代码，只把探测用的值换成了占位）：

```ts
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent"; // 1.5.0

// runner 私有的空目录，由平台创建；同时把 runner 进程的 PI_CODING_AGENT_DIR 设为它（纵深防御）
const platformAgentDir = "<runner 私有目录>";
const settingsManager = SettingsManager.inMemory({ /* 平台设置 */ }, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd: workspace,                 // 任务工作区；也是内置工具的工作目录
  agentDir: platformAgentDir,
  settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  agentsFilesOverride: () => ({ agentsFiles: platformContextFiles }), // 调用方从基准 git 引用读到的 AGENTS.md
  appendSystemPrompt: [],         // 非 undefined：跳过 APPEND_SYSTEM.md 发现
  additionalSkillPaths: platformSkillPaths, // 可选，在 noSkills 下仍加载
  extensionFactories: [
    { name: "mcp", factory: createMcpExtension({ loadConfig: platformMcpConfig, logPath: join(platformAgentDir, "mcp.log") }) },
    // 平台的拦截扩展等（Task 6/8B）
  ],
});
await loader.reload({ resolveProjectTrust: async () => false }); // 第二道保险
const modelRuntime = await ModelRuntime.create({ authPath: join(platformAgentDir, "auth.json"), modelsPath: platformModelsJson });
const { session } = await createAgentSession({
  cwd: workspace, agentDir: platformAgentDir, modelRuntime, model, resourceLoader: loader,
  settingsManager, sessionManager: SessionManager.inMemory(workspace), // 会话持久化方案归 0B
  tools: ["read", "bash", "edit", "write", "mcp__<server>__*"],
});
await session.bindExtensions({}); // 发出 session_start，MCP 在此时连接
```

**`project_trust` 的说明**：`project_trust` 是扩展事件（`dist/core/extensions/types.d.ts` 中的 `ProjectTrustEvent`、`ProjectTrustEventResult`；`docs/extensions.md` 的 "#### project_trust"），只由 CLI 的信任流程触发，处理方是 user/global 或 CLI 扩展；`builtin: true` 的扩展处理不了它（`docs/sdk.md` 锚点 `#inlineextension`）。SDK 中对应的钩子是 `DefaultResourceLoader.reload({ resolveProjectTrust })`（`dist/core/resource-loader.d.ts` 中的 `ResourceLoaderReloadOptions`）。推荐组合中让它返回 `false`，只作为第二道保险。第一道防线是 `projectTrusted: false` 的内存设置加上各个 `no*` 开关。

**另一种做法**：完全自定义 `ResourceLoader`，即 `examples/sdk/12-full-control.ts` 那样手写 `getExtensions` 等方法。这样也能关闭全部发现。但内联 factory 的加载函数 `loadExtensionFromFactory` 没有从包入口导出，要让内置 MCP 扩展跑起来就得自己拼 `LoadExtensionsResult`。因此推荐 `DefaultResourceLoader` 加显式开关的组合。

#### 0A.5 内置 MCP（验收 9）

| 项 | 1.5.0 中的事实 | 来源（tag v1.5.0） |
|---|---|---|
| 内置依赖 | `pi-coding-agent` 依赖 `@earendil-works/pi-mcp@1.5.0`；MCP 扩展的运行时从中导入 `McpClient`、`StdioTransport`、`StreamableHttpTransport`；OAuth 部分来自 `@earendil-works/pi-mcp/oauth` | `npm view` 的 dependencies；`dist/extensions/mcp/runtime.js`、`oauth.js` 的 import |
| SDK 默认不启用 | "SDK sessions do not load built-in extensions"。需要把 `createMcpExtension()` 加进 `DefaultResourceLoader` 的 `extensionFactories`；如果服务用 `codemode` 或 `deferred` 暴露方式，还要加 `createCodemodeExtension()` 或 `createToolSearchExtension()` | `docs/mcp.md` 的 "Use MCP from the SDK"；`docs/sdk.md` 锚点 `#codemode-mcp`；`examples/sdk/14-codemode-mcp.ts` |
| 启用步骤 | `new DefaultResourceLoader({ extensionFactories: [createMcpExtension(opts)] })`，然后 `await loader.reload()`，然后 `createAgentSession({ resourceLoader })`，最后 **`await session.bindExtensions({})`**（发出 `session_start`，扩展在此时读取配置并在后台连接；首个 prompt 最多等待 `direct` 服务 10 秒，可用 `startupWaitMs` 调整） | `examples/sdk/14-codemode-mcp.ts`；`dist/extensions/mcp/index.d.ts` 的 `McpExtensionOptions.startupWaitMs`；`dist/core/agent-session.d.ts` 的 `bindExtensions(bindings: ExtensionBindings)` |
| 配置文件位置 | `getAgentDir()/mcp.json`（进程级）和 `cwd/.pi/mcp.json`（只有在 `ctx.isProjectTrusted()` 时）；同名时项目条目覆盖用户条目 | `docs/mcp.md` 的 "Configure servers"；`dist/extensions/mcp/index.js` 中的 `defaultLoadConfig`；`dist/extensions/mcp/config.d.ts` 中的 `loadMcpConfig` |
| 格式 | `{ "mcpServers": { "<name>": { "command", "args", "env", "cwd" } \| { "url", "headers", "oauth" }, …公共字段 "timeout", "enabled", "exposure", "toolExposure", "description" }, "autoEnableCodemode"? }`。服务名只能用 `[A-Za-z0-9_-]`；工具名为 `mcp__<server>__<tool>`；不支持 `sse`；`env` 和 `headers` 支持 `${VAR}` 和 `!command` | `docs/mcp.md` 的 "Configure servers"、"Configuration rules"、"Control tool exposure" |
| 可信配置注入 | **`createMcpExtension({ loadConfig: (ctx) => LoadedMcpConfig })`**，其中 `LoadedMcpConfig = { servers: McpServerEntry[], errors: string[], autoEnableCodemode?, projectConfig? }`，`McpServerEntry = { name, config, source, scope? }`。另一种方式是让平台扩展调用 `pi.registerMcpServer(name, config)`，但 `mcp.json` 中的同名条目优先，所以只适合与 `loadConfig` 配合使用 | `dist/extensions/mcp/index.d.ts`；`dist/extensions/mcp/config.d.ts`；`docs/mcp.md` 的 "Add servers from extensions" |
| 暴露方式 | 默认 `codemode`：工具不声明给模型，只能在 codemode 脚本中调用。`direct` 会像内置工具一样声明。`tools` 白名单中只要有一项以 `mcp__` 开头，就只保留匹配的 MCP 工具 | `docs/mcp.md` 的 "Control tool exposure"；`dist/core/sdk.d.ts` 中 `CreateAgentSessionOptions.tools` 的注释 |
| 权限钩子 | MCP 调用走 pi 的工具管线，扩展的 `tool_call`、`tool_result` 同样会拦截 MCP 工具（T3 会依赖这一点） | `docs/mcp.md` 的 "Permissions" |

**探测**：临时本地 stdio MCP 服务（附录 A 的 `mcp-test-server.mjs`，提供 `echo` 和 `add` 两个工具），由 `locked` 组通过 `loadConfig` 注入，配置为 `exposure: "direct"`。
- 加载配置：`mcp-started-platform` 出现，只启动了这一个服务。
- 列出工具：`session.getActiveToolNames()` 和每次模型请求声明的工具中都有 `mcp__platform__echo` 和 `mcp__platform__add`。
- 调用：桩模型发出 `mcp__platform__echo {"text":"hello-mcp"}`，得到结果 `echo(platform): hello-mcp`，`isError: false`。
- 过程中没有自建 MCP 客户端，连接和调用都由 pi 内置的 `createMcpExtension` 加 pi-mcp 完成。

**MCP 配置样例**（平台侧，与 `mcpServers` 格式一致，由平台校验后转成 `loadConfig` 的返回值）：

```json
{
  "mcpServers": {
    "platform": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/forgepilot/mcp/platform-server.mjs"],
      "env": { "SERVICE_TOKEN": "${PLATFORM_MCP_TOKEN}" },
      "exposure": "direct",
      "timeout": 60
    }
  }
}
```

```ts
const platformMcpConfig = (_ctx) => ({
  servers: Object.entries(validated.mcpServers).map(([name, config]) => ({ name, config, source: "<platform>", scope: "global" })),
  errors: [],
});
```

**对后续任务的约束**（0A 的发现，不是对计划的偏差）：
1. MCP 扩展的默认 `loadConfig`、`logPath` 和 OAuth 凭证路径都用进程级的 `getAgentDir()`，**忽略 SDK 的 `agentDir`**，`locked-default-mcp` 组已实测。所以必须显式传 `loadConfig`（以及 `logPath`，需要 OAuth 时再传 `credentials`），同时在 runner 进程中把 `PI_CODING_AGENT_DIR` 设为平台目录。
2. `loadConfig` 返回的条目不经过 pi 的文件校验，因为 `config.js` 中的解析函数没有导出，包的 `exports` 只有 `.` 和 `./rpc-entry`。平台需要自己校验，例如用 zod。`${VAR}` 插值仍在创建 transport 时执行（`dist/extensions/mcp/runtime.js` 的 `createDefaultTransport`）。
3. stdio MCP 服务默认**继承 runner 的全部 `process.env`**（`@earendil-works/pi-mcp` 的 `StdioTransport` 在没有 `inheritEnv: false` 时会合并 `process.env`，而 pi 的 `createDefaultTransport` 没有设置它）。runner 环境中的 `DASHSCOPE_API_KEY` 等变量会传给 MCP 服务。可以通过 `McpExtensionOptions.createTransport` 自建 `StdioTransport({ inheritEnv: false, … })` 来避免，具体在 T3/T7 决定。
4. SDK 的默认值是宽松的：`SettingsManager.create` 默认信任项目；不传 `resourceLoader` 时 `createAgentSession` 会按 CLI 的规则加载一切（基线组实测）。runner 不能回退到默认值，Task 7 的测试应覆盖这一点。

#### 0A.6 计划中假设的名称与 1.5.0 实际名称

| 计划中的名称 | 1.5.0 实际 | 位置 |
|---|---|---|
| `createMcpExtension` | 存在：`createMcpExtension(options?: McpExtensionOptions): ExtensionFactory` | 包入口导出；`dist/extensions/mcp/index.d.ts` |
| `bindExtensions` | 存在：`AgentSession.bindExtensions(bindings: ExtensionBindings): Promise<void>`，SDK 中可以传 `{}` | `dist/core/agent-session.d.ts` |
| `ResourceLoader` | 存在：接口 `ResourceLoader`，默认实现 `DefaultResourceLoader`，选项类型 `DefaultResourceLoaderOptions` | `dist/core/resource-loader.d.ts` |
| `resourceLoader` | `CreateAgentSessionOptions.resourceLoader`；传入后 `createAgentSession` **不会**再替你调用 `reload()` | `dist/core/sdk.d.ts`、`dist/core/sdk.js` |
| `agentDir` | 同时是 `CreateAgentSessionOptions.agentDir` 和 `DefaultResourceLoaderOptions.agentDir`；进程级默认值来自 `getAgentDir()`（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）。MCP 扩展的默认值不跟随它（见 0A.5） | `dist/config.js` 中的 `getAgentDir` |
| `ExtensionAPI` | 存在：类型 `ExtensionAPI`，包含 `on`、`registerTool`、`registerMcpServer` 等 | 包入口导出；`dist/core/extensions/types.d.ts` |
| `ModelRuntime` | 存在：类 `ModelRuntime`，`ModelRuntime.create({ authPath, modelsPath, credentials?, modelsStore? })` | 包入口导出；`dist/core/model-runtime.d.ts` |
| `AgentSession` | 存在：类 `AgentSession` | 包入口导出；`dist/core/agent-session.d.ts` |
| `project_trust` | 扩展事件 `project_trust`（`ProjectTrustEvent`），只在 CLI 流程中触发；SDK 中对应的是 `ResourceLoaderReloadOptions.resolveProjectTrust` | `dist/core/extensions/types.d.ts`；`dist/core/resource-loader.d.ts` |
| （补充）关闭发现的开关 | `noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles`、`disabledBuiltinExtensions`，以及 `*Override` 系列；设置用 `SettingsManager.inMemory(settings, { projectTrusted })` | `dist/core/resource-loader.d.ts`；`dist/core/settings-manager.js` |

计划所依赖的能力在 1.5.0 中都存在，没有缺失。

#### 0A.7 可复现的脱敏探测命令

在一个空的临时目录 `<scratch>/pkg` 中，`package.json` 只写 `{"type":"module"}`，然后执行：

```sh
npm view @earendil-works/pi-coding-agent@1.5.0 version dist.integrity dependencies engines --json
git ls-remote --tags https://github.com/earendil-works/pi | grep -E 'v1\.5\.[01]$'
npm install --save-exact --ignore-scripts @earendil-works/pi-coding-agent@1.5.0 vitest ws zod @modelcontextprotocol/sdk
node ../scripts/compare-tag.mjs node_modules/@earendil-works/pi-coding-agent f9a26365568127461c47a07a37dcb42c140a3ac5
node ../scripts/reach.mjs
node probe-net-proc.mjs                   # 期望退出码 0
node run-probe.mjs baseline               # 对照：敌意资源全部可见
node run-probe.mjs baseline-home          # 对照：不设 PI_CODING_AGENT_DIR，回落到伪 HOME
node run-probe.mjs locked                 # 推荐组合：只出现平台资源
node run-probe.mjs locked-default-mcp     # 反例：MCP 默认配置读取进程级 agentDir
```

`run-probe.mjs` 每次运行前都会重建敌意目录树，并用最小环境启动探测进程：`PATH`、伪 `HOME`、敌意 `PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`。输出中的路径都替换成了 `<root>`。2026-11-10 的实际结果：四个模式的退出码都是 0，stderr 为空，结论见 0A.4 和 0A.5。脚本全文见附录 A。

## 1. 做了什么

（待 Task 1 起的实现完成后填写。）

## 2. 设计意图

（待填写。资源隔离和 MCP 的 SDK 组合依据见 0A.4、0A.5。）

## 3. 代码地图

（待 Task 1 起填写。）

| 文件 | 负责什么 |
|---|---|

## 4. 与计划的偏差

| 偏差 | 原因 | 谁决定的 | 影响 |
|---|---|---|---|
| （0A 无偏差。计划中假设的 SDK 名称在 1.5.0 中都存在，对照见 0A.6。0A.5 列出的四条约束是对 SDK 事实的记录，留给后续任务吸收） | — | — | — |

## 5. 验证记录

| 验收标准（引用 tasks.md） | 实际执行的检查 | 结果 |
|---|---|---|
| T1-6 pi 以锁定版本的依赖形式引入，没有修改或 fork | 0A 只在临时目录中做了确切版本的安装，并核对了 integrity 和 tag | 开工核实：1.5.0 可锁定，tarball 文档与 tag v1.5.0 一致。**验收本身待 Task 1 的脚手架完成后执行** |
| T1-8 不加载仓库内的 `.pi/` 资源 | 0A.4 的敌意目录树探测，包括基线对照 | 开工核实：开关已经找到并实测生效。**正式测试待 Task 7 执行** |
| T1-9 核实内置 MCP 客户端的配置方式 | 0A.5 的文档和类型核实，以及临时 stdio MCP 服务的探测 | 开工核实完成：配置方式已记录，加载、列出工具和调用都已实测 |

未执行的检查：T1 的验收 1–5、7、10 都还没有开始；验收 6 和 8 目前只完成了开工核实，不算验收通过。

## 6. 已知限制

- 0A：registry 上已有 1.5.1（2026-11-09 发布，含 Breaking Changes），按计划仍锁定 1.5.0，是否升级待作者决定。
- 0A：主题发现只有代码和文档证据，探测用的主题文件格式无效。主题不影响 agent 行为。
- 0A：`packages` 自动安装和 CLI 在信任解析前读取 `sessionDir` 这两条路径没有实测；推荐组合不使用文件设置，也不使用 CLI，因此不会触发它们。
- 0A：系统 bash 为 3.2.57（macOS 自带）。本会话的守卫不允许直接调用 `bash`，版本是通过 Node 子进程获取的。

## 7. 讲解自测题

（待 T1 收尾时填写。）

- **自测结果**：未进行

## 附录 A：0A 探测脚本全文（2026-11-10，均在 `<scratch>/` 下运行）


<details><summary><code>pkg/probe-net-proc.mjs</code>：回环 HTTP/WebSocket 随机端口 + 子进程启动与清理</summary>

```js
// Probe: loopback HTTP + WebSocket on random ports; spawn a child process and clean it up.
import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";

const results = {};

// 1. HTTP on 127.0.0.1:0
const httpServer = http.createServer((_req, res) => res.end("ok"));
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const httpPort = httpServer.address().port;
const body = await (await fetch(`http://127.0.0.1:${httpPort}/`)).text();
results.http = { port: httpPort, body };
await new Promise((r) => httpServer.close(r));

// 2. WebSocket on 127.0.0.1:0
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((r) => wss.on("listening", r));
const wsPort = wss.address().port;
wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m}`)));
const echoed = await new Promise((resolve, reject) => {
  const c = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  c.on("open", () => c.send("ping"));
  c.on("message", (m) => { resolve(String(m)); c.close(); });
  c.on("error", reject);
});
results.ws = { port: wsPort, echoed };
await new Promise((r) => wss.close(r));

// 3. Child process spawn + SIGTERM cleanup (detached group so grandchildren are also killed)
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
await new Promise((r) => setTimeout(r, 300));
const pid = child.pid;
const aliveBefore = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
process.kill(-pid, "SIGTERM");
const exitInfo = await exited;
const aliveAfter = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
results.child = { pid, aliveBefore, exitInfo, aliveAfter };

console.log(JSON.stringify(results));
const ok = results.http.body === "ok" && results.ws.echoed === "echo:ping" && aliveBefore && !aliveAfter && exitInfo.signal === "SIGTERM";
process.exit(ok ? 0 : 1);
```

</details>

<details><summary><code>pkg/mcp-test-server.mjs</code>：临时 stdio MCP 服务（探测目标，服务端）</summary>

```js
// Minimal stdio MCP server used only as a probe target.
// usage: node mcp-test-server.mjs <serverName> <markerDir>
// On start it writes <markerDir>/mcp-started-<serverName> so the probe can tell which servers were spawned.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const [name = "unnamed", markerDir] = process.argv.slice(2);
if (markerDir) writeFileSync(join(markerDir, `mcp-started-${name}`), String(process.pid));

const server = new McpServer({ name: `t0a-${name}`, version: "0.0.1" });
server.registerTool(
  "echo",
  { description: `Echo text back (server ${name})`, inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo(${name}): ${text}` }] }),
);
server.registerTool(
  "add",
  { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);
await server.connect(new StdioServerTransport());
```

</details>

<details><summary><code>pkg/setup-hostile.mjs</code>：生成敌意目录树</summary>

```js
// Build a hostile directory tree: every pi discovery location gets a resource that would be
// observable (marker strings / marker files) if pi loaded it.
// usage: node setup-hostile.mjs <root>
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(process.argv[2]);
rmSync(root, { recursive: true, force: true });
const markers = join(root, "markers");
const serverScript = resolve("mcp-test-server.mjs");
const w = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };

const evilExt = (tag) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(markers, `ext-module-${tag}`))}, "1");
export default function (pi) {
  writeFileSync(${JSON.stringify(join(markers, `ext-factory-${tag}`))}, "1");
  pi.on("session_start", () => writeFileSync(${JSON.stringify(join(markers, `ext-session-${tag}`))}, "1"));
}
`;
const skill = (name) => `---\nname: ${name}\ndescription: HOSTILE_SKILL_${name}\n---\nHOSTILE skill body ${name}\n`;
const mcpJson = (name) => JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [serverScript, name, markers], exposure: "direct" } } }, null, 2);
const settings = (tag) => JSON.stringify({
  defaultProjectTrust: "always",
  defaultTools: ["ls"],
  shellCommandPrefix: `echo HOSTILE_PREFIX_${tag};`,
  extensions: [`./extra-${tag}.ts`],
}, null, 2);

const agentDirResources = (dir, tag) => {
  w(join(dir, "AGENTS.md"), `HOSTILE_AGENTS_${tag}\n`);
  w(join(dir, "SYSTEM.md"), `HOSTILE_SYSTEM_${tag}\n`);
  w(join(dir, "APPEND_SYSTEM.md"), `HOSTILE_APPEND_${tag}\n`);
  w(join(dir, "settings.json"), settings(tag));
  w(join(dir, `extra-${tag}.ts`), evilExt(`settings-${tag}`));
  w(join(dir, "mcp.json"), mcpJson(`hostile-${tag}`));
  w(join(dir, "extensions", `evil-${tag}.ts`), evilExt(tag));
  w(join(dir, "skills", `skill-${tag}`, "SKILL.md"), skill(`skill-${tag}`));
  w(join(dir, "prompts", `prompt-${tag}.md`), `HOSTILE_PROMPT_${tag}\n`);
};

mkdirSync(markers, { recursive: true });
// Fake HOME: ~/.pi/agent (default agentDir) + ~/.agents/skills
const home = join(root, "home");
agentDirResources(join(home, ".pi", "agent"), "homeagent");
w(join(home, ".agents", "skills", "skill-homeagents", "SKILL.md"), skill("skill-homeagents"));
// Agent dir named by PI_CODING_AGENT_DIR
agentDirResources(join(root, "envagent"), "envagent");
// Ancestor directories (above the repo)
w(join(root, "work", "CLAUDE.md"), "HOSTILE_ANCESTOR_CLAUDE\n");
w(join(root, "work", "org", "AGENTS.md"), "HOSTILE_ANCESTOR_AGENTS\n");
w(join(root, "work", "org", ".agents", "skills", "skill-ancestor", "SKILL.md"), skill("skill-ancestor"));
// The task repo
const repo = join(root, "work", "org", "repo");
w(join(repo, "AGENTS.md"), "HOSTILE_REPO_AGENTS\n");
w(join(repo, "CLAUDE.md"), "HOSTILE_REPO_CLAUDE\n");
w(join(repo, "cwd-marker.txt"), "CWD_MARKER_CONTENT\n");
w(join(repo, "sub", "AGENTS.md"), "HOSTILE_SUBDIR_AGENTS\n");
const pi = join(repo, ".pi");
w(join(pi, "settings.json"), settings("repo"));
w(join(pi, `extra-repo.ts`), evilExt("settings-repo"));
w(join(pi, "mcp.json"), mcpJson("hostile-repo"));
w(join(pi, "SYSTEM.md"), "HOSTILE_SYSTEM_repo\n");
w(join(pi, "APPEND_SYSTEM.md"), "HOSTILE_APPEND_repo\n");
w(join(pi, "extensions", "evil-repo.ts"), evilExt("repo"));
w(join(pi, "extensions", "evil-dir", "index.ts"), evilExt("repo-dir"));
w(join(pi, "skills", "skill-repo", "SKILL.md"), skill("skill-repo"));
w(join(pi, "prompts", "prompt-repo.md"), "HOSTILE_PROMPT_repo\n");
w(join(pi, "themes", "hostile.json"), JSON.stringify({ name: "hostile-theme" }));
w(join(repo, ".agents", "skills", "skill-repoagents", "SKILL.md"), skill("skill-repoagents"));
execFileSync("git", ["init", "-q", "-b", "main", repo]);
// Platform-controlled (empty) agent dir and platform skill
mkdirSync(join(root, "platform-agent"), { recursive: true });
w(join(root, "platform-skills", "platform-skill", "SKILL.md"), `---\nname: platform-skill\ndescription: PLATFORM_SKILL\n---\nPlatform skill body\n`);
console.log(JSON.stringify({ root, home, repo, markers }));
```

</details>

<details><summary><code>pkg/probe-pi.mjs</code>：资源发现 / 工具 cwd / 内置 MCP 探测（桩模型）</summary>

```js
// Probe pi 1.5.0 resource discovery, tool cwd and built-in MCP against a hostile tree.
// usage: node probe-pi.mjs <root> <mode>   mode = baseline | locked | locked-default-mcp
// The model is a local stub (OpenAI-compatible SSE on 127.0.0.1:random); no real model API is called.
import http from "node:http";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession, createMcpExtension, DefaultResourceLoader, getAgentDir,
  ModelRuntime, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";

const root = resolve(process.argv[2]);
const mode = process.argv[3];
const repo = join(root, "work", "org", "repo");
const markers = join(root, "markers");
const serverScript = resolve("mcp-test-server.mjs");
const HOSTILE = /HOSTILE_[A-Za-z_-]+/g;
const hostileIn = (s) => [...new Set(String(s ?? "").match(HOSTILE) ?? [])].sort();

// ---- stub OpenAI-compatible server ----
const requests = [];
const script = [
  { tool: "bash", args: { command: "pwd; cat cwd-marker.txt" } },
  { tool: "read", args: { path: "cwd-marker.txt" } },
  { tool: "mcp__platform__echo", args: { text: "hello-mcp" } },
];
const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model" };
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const i = requests.length;
    requests.push({ url: req.url, tools: (parsed.tools ?? []).map((t) => t.function?.name), system: (parsed.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n") });
    const step = script[i];
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (step && (parsed.tools ?? []).some((t) => t.function?.name === step.tool)) {
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${i}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
      ]);
    } else {
      sse(res, [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: step ? `skipped ${step.tool} (not declared)` : "done" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]);
    }
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

// Model config lives in its own dir so it is not influenced by the hostile tree.
const modelDir = join(root, `model-${mode}`);
mkdirSync(modelDir, { recursive: true });
writeFileSync(join(modelDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "stub-not-a-secret", models: [{ id: "stub-model" }] } } }));
const modelRuntime = await ModelRuntime.create({ authPath: join(modelDir, "auth.json"), modelsPath: join(modelDir, "models.json") });
const model = modelRuntime.getModel("stub", "stub-model");
if (!model) throw new Error("stub model missing");

// ---- resource loader per mode ----
const platformAgentDir = join(root, "platform-agent");
const platformMcp = (ctx) => ({
  servers: [{ name: "platform", source: "<platform>", scope: "global", config: { command: process.execPath, args: [serverScript, "platform", markers], exposure: "direct" } }],
  errors: [],
});
let loader, settingsManager, agentDir, sessionOpts = {};
if (mode === "baseline") {
  agentDir = getAgentDir(); // follows PI_CODING_AGENT_DIR / HOME like the CLI
  settingsManager = SettingsManager.create(repo, agentDir);
  loader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, extensionFactories: [createMcpExtension()] });
  await loader.reload();
} else {
  agentDir = platformAgentDir;
  settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const mcp = mode === "locked-default-mcp"
    ? createMcpExtension()
    : createMcpExtension({ loadConfig: platformMcp, logPath: join(platformAgentDir, "mcp.log") });
  loader = new DefaultResourceLoader({
    cwd: repo,
    agentDir: platformAgentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: [{ path: "platform://base-ref/AGENTS.md", content: "PLATFORM_AGENTS_FROM_BASE_REF\n" }] }),
    appendSystemPrompt: [],
    additionalSkillPaths: [join(root, "platform-skills")],
    extensionFactories: [{ name: "mcp", factory: mcp }],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  sessionOpts = { tools: ["read", "bash", "mcp__platform__*"] };
}

const loaderView = {
  agentsFiles: loader.getAgentsFiles().agentsFiles.map((f) => f.path.replace(root, "<root>")),
  skills: loader.getSkills().skills.map((s) => s.name),
  prompts: loader.getPrompts().prompts.map((p) => p.name),
  themes: loader.getThemes().themes.length,
  extensions: loader.getExtensions().extensions.map((e) => e.path.replace(root, "<root>")),
  extensionErrors: loader.getExtensions().errors.map((e) => `${e.path.replace(root, "<root>")}: ${e.error}`),
  systemPromptSource: loader.getSystemPromptSource()?.path?.replace(root, "<root>") ?? null,
  systemPromptHostile: hostileIn(loader.getSystemPrompt()),
  appendSources: loader.getAppendSystemPromptSources().map((s) => s.path.replace(root, "<root>")),
  projectTrusted: settingsManager.isProjectTrusted(),
};

const { session } = await createAgentSession({
  cwd: repo, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader: loader,
  settingsManager, sessionManager: SessionManager.inMemory(repo), ...sessionOpts,
});
const toolResults = [];
session.subscribe((ev) => {
  if (ev.type === "tool_execution_end") {
    const text = (ev.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
    toolResults.push({ tool: ev.toolName, isError: ev.isError, text: text.replaceAll(root, "<root>").trim() });
  }
});
await session.bindExtensions({});
await session.prompt("probe");
const out = {
  version: VERSION, mode, loader: loaderView,
  activeTools: session.getActiveToolNames(),
  sessionSystemPromptHostile: hostileIn(session.systemPrompt),
  sessionSystemPromptHasPlatformAgents: session.systemPrompt.includes("PLATFORM_AGENTS_FROM_BASE_REF"),
  sessionSystemPromptHasPlatformSkill: session.systemPrompt.includes("platform-skill"),
  requests: requests.map((r) => ({ tools: r.tools, systemHostile: hostileIn(r.system) })),
  toolResults,
};
session.dispose();
await new Promise((r) => setTimeout(r, 500));
out.markers = readdirSync(markers).sort();
stub.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
```

</details>

<details><summary><code>pkg/run-probe.mjs</code>：重建目录树并以最小环境运行探测</summary>

```js
// Re-create the hostile tree, then run probe-pi.mjs with a fake HOME and hostile PI_CODING_AGENT_DIR.
// usage: node run-probe.mjs <mode>
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const mode = process.argv[2];
const root = resolve("../hostile");
const setup = spawnSync(process.execPath, ["setup-hostile.mjs", root], { encoding: "utf8" });
if (setup.status !== 0) { console.error(setup.stderr); process.exit(1); }
const env = { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "envagent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
let probeMode = mode;
if (mode === "baseline-home") { delete env.PI_CODING_AGENT_DIR; probeMode = "baseline"; }
const r = spawnSync(process.execPath, ["probe-pi.mjs", root, probeMode], { encoding: "utf8", env, timeout: 90000 });
writeFileSync(resolve(`../out-${mode}.json`), r.stdout ?? "");
writeFileSync(resolve(`../err-${mode}.txt`), (r.stderr ?? "").replaceAll(root, "<root>"));
console.log(`mode=${mode} exit=${r.status} signal=${r.signal}`);
console.log(r.stdout);
if (r.stderr) console.log("--- stderr (first 2000 chars) ---\n" + r.stderr.replaceAll(root, "<root>").slice(0, 2000));
process.exit(r.status ?? 1);
```

</details>

<details><summary><code>scripts/compare-tag.mjs</code>：tarball 文件与 tag commit 逐字节比较</summary>

```js
// Compare files shipped in the npm tarball with the same files at the GitHub tag commit.
// usage: node compare-tag.mjs <pkgDir> <commit>
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [pkgDir, commit] = process.argv.slice(2);
const files = [
  "docs/sdk.md", "docs/security.md", "docs/mcp.md", "docs/environment-variables.md",
  "docs/configuration.md", "docs/settings.md", "docs/extensions.md", "docs/skills.md",
  "examples/sdk/12-full-control.ts", "examples/sdk/14-codemode-mcp.ts", "examples/sdk/07-context-files.ts",
  "src/core/resource-loader.ts", "src/core/sdk.ts", "src/extensions/mcp/index.ts", "src/extensions/mcp/config.ts",
];
const host = ["raw", "githubusercontent", "com"].join(".");
for (const f of files) {
  const url = `https://${host}/earendil-works/pi/${commit}/packages/coding-agent/${f}`;
  const res = await fetch(url);
  let local = null;
  try { local = readFileSync(join(pkgDir, f), "utf8"); } catch { local = null; }
  const remote = res.ok ? await res.text() : null;
  const verdict = !res.ok ? `HTTP ${res.status}` : local === null ? "remote-only (not in tarball)" : local === remote ? "identical" : "DIFFERS";
  console.log(`${f}\t${verdict}`);
}
```

</details>

<details><summary><code>scripts/reach.mjs</code>：资料可达性（只打印 HTTP 状态）</summary>

```js
// Reachability probe: prints HTTP status only (no content).
const host = ["raw", "githubusercontent", "com"].join(".");
const urls = [
  `https://${host}/earendil-works/pi/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/package.json`,
  "https://code.claude.com/docs/en/agent-sdk/overview",
  "https://docs.claude.com/en/docs/agent-sdk/overview",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { redirect: "follow" });
    let extra = "";
    if (u.endsWith("package.json") && r.ok) extra = " version=" + (await r.json()).version;
    console.log(`${r.status}\t${r.url}${extra}`);
  } catch (e) {
    console.log(`ERR\t${u}\t${e.message}`);
  }
}
```

</details>

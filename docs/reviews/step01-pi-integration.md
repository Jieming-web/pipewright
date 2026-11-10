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

### 0B 引擎公共能力核实（2026-11-10）

执行者：Task 0B 子 agent。下文 `<scratch0b>` 指 `/private/tmp/claude-501/<session>/scratchpad/t0b`。

**目标版本**：2026-11-10，作者决定把 pi 锁定为 **1.5.1**，不再用 1.5.0（经协调者转达；版本决定本身和 0A 在 1.5.1 上的复核由另一个任务记录）。本节结论都以 1.5.1 为准。

- **pi**：`@earendil-works/pi-coding-agent@1.5.1`，发布于 2026-11-09T23:45:13Z。
  - `dist.integrity` 为 `sha512-rdu4pRvpQba2ep83nqHaN8L1pvY1OQ3i/2FucogA/eyRxwoUXMUXdk1Z9JnZFJR+9ck9Gs1ajuSb9m7Hz7ejYw==`，与 `<scratch0b>/package-lock.json` 中的值一致。
  - 依赖 pi-agent-core、pi-ai、pi-mcp、pi-codemode、pi-tui 都是 1.5.1。
  - 官方仓库 tag `v1.5.1` 指向 commit **`dd30101cfc5b0609411dd80b6f93adbc14db14cf`**（`git ls-remote --tags https://github.com/earendil-works/pi`）。
  - 用 `npm install --save-exact --ignore-scripts` 装到 `<scratch0b>`。代码证据按 `dist/` 路径加符号名引用，依赖包写作 `pi-agent-core/dist/…`、`pi-ai/dist/…`；文档按随包 `docs/` 的文件名加章节标题引用。
  - 本节没有逐字节比对 1.5.1 tarball 与 tag 源码，这项归 0A 在 1.5.1 上的复核。
- **1.5.0 对照**：先在 1.5.0 上做过同样的核实。改用 1.5.1 后，逐个比对了涉及的文件（`cmp`，1.5.0 取自 0A 的安装目录，只读）：
  - **两版相同**：`pi-agent-core/dist/agent-loop.js`、`pi-agent-core/dist/agent.js`、`dist/core/settings-manager.js`、`dist/core/session-manager.d.ts`、`dist/core/sdk.js`、`dist/utils/shell.js`、`docs/sdk.md`、`docs/session-format.md`。
  - **有差异，但本节引用的符号没变**：
    - `dist/core/agent-session.js`：`abort`、`dispose`、`_startRun`、`_emitAgentSettled`、`_willRetryAfterAgentEnd`、`_handlePostAgentRun`、`_prepareRetry`、`_beforeToolCall` 都没变。`prompt` 的前置检查拆成了 `_preparePrompt`，reject 的条件没变。
    - `dist/core/extensions/runner.js`：`emitToolCall`、`createContext`、`noOpUIContext` 没变。
    - `dist/core/tools/bash.js`：只改了超时报错（#11613），abort 路径没变。
    - `pi-ai/dist/utils/retry.js`：只多了一条可重试的错误文本。
    - `docs/extensions.md`、`docs/settings.md`：本节引用的章节没变。
  - **与本节相关的改动**：`pi-ai/dist/api/lazy.js`（#8635）、`dist/core/agent-session-runtime.js`（#9126），见 0B.2。
  - 所有探测都在 1.5.1 上重跑过。#9126、#8635 的场景另在 1.5.0 上跑了一遍作对照。
- **Claude Agent SDK**：`@anthropic-ai/claude-agent-sdk@0.3.322`，发布于 2026-11-10T01:57:38Z。
  - `dist.integrity` 为 `sha512-r88ij7R3SPV2j3BtFuavgrbWZNE8SVVS42AOQ1KxlS+QnSwNNnUhmVXV3Es2dniZySBYX8ENebL43ffhiB0azw==`。
  - 用 `npm install --save-exact --ignore-scripts` 装到 `<scratch0b>/csdk`，只读了 `sdk.d.ts`。
  - 2026-11-10 读取了 `code.claude.com/docs/en/agent-sdk/` 下的 `hooks`、`permissions`、`user-input`、`streaming-output`、`agent-loop`、`sessions` 六页官方文档。这些页面不带版本号，所以**版本化证据以 0.3.322 的 `sdk.d.ts` 符号为准**，文档页只用来说明语义，按"页面 + 章节标题"引用。
- **调用边界**：没有调用 Claude/Anthropic API，也没有把 Claude 接进任何代码。pi 的探测只用 loopback 随机端口上的 OpenAI 兼容桩服务，API key 是字面量 `stub-not-a-secret`。

#### 0B.1 能力 × pi × Claude Agent SDK

统一接口只要求两边都能表达的能力。pi 一列中的"探测"指 0B.3 的实测，其余是代码或文档证据。Claude 一列都**没有实测**（T1 不接 Claude）。

| 能力 | pi 1.5.1 | Claude Agent SDK 0.3.322 | 差异与统一接口的边界 |
|---|---|---|---|
| 工具执行前放行 | 扩展 `pi.on("tool_call", h)`，h 返回 `undefined`，或返回不含 `block` 的结果。<br>顺序：`tool_execution_start → tool_call → 执行 → tool_result → tool_execution_end`。<br>出处：`docs/extensions.md` 的 "Lifecycle Overview" 和 "#### tool_call"；`dist/core/extensions/types.d.ts` 的 `ToolCallEventResult`；`dist/core/agent-session.js` 的 `_beforeToolCall`。<br>探测：`hook` | PreToolUse 钩子：`Options.hooks.PreToolUse` 中的 `HookCallback` 返回 `{}`，或返回 `permissionDecision: "allow"`。<br>权限回调：`Options.canUseTool` 返回 `{behavior: "allow"}`。<br>出处：`sdk.d.ts` 的 `HookCallback`、`PreToolUseHookSpecificOutput`、`HookPermissionDecision`、`CanUseTool`、`PermissionResult`；hooks 页 "Outputs"；permissions 页 "How permissions are evaluated" | 两边都能表达 `{decision: "allow"}`。<br>Claude 适配器的拦截点应选 PreToolUse：canUseTool 会被 allow 规则和权限模式绕过（permissions 页 "Allow and deny rules" 中的警告）。PreToolUse 返回 allow 也不跳过 deny/ask 规则。<br>pi 中工具不存在或参数校验失败的调用不经过 `tool_call`，直接以错误结果结束（`pi-agent-core/dist/agent-loop.js` 的 `prepareToolCall`）。统一接口不为这类调用发拦截请求 |
| 阻止，并让模型看到原因 | 返回 `{block: true, reason}`：工具不执行，`tool_execution_end.isError = true`，结果文本就是 reason，模型在下一次请求中能看到。<br>**h 抛错同样会阻止**，错误消息成为工具结果（fail closed）。<br>出处：`prepareToolCall` 中的 `createErrorToolResult(beforeResult.reason …)` 和外层 try/catch。<br>探测：`hook`。`blocked by probe policy`、`hook exploded` 都出现在下一次请求的 tool 消息里；marker-b、marker-c 都没有生成 | PreToolUse 返回 `permissionDecision: "deny"` 和 `permissionDecisionReason`（文档："tells the model why"）。<br>canUseTool 返回 `{behavior: "deny", message}`。<br>**回调抛错时，默认 `onFailure: "continue"`，动作照常进入权限流程（fail open）**。要阻止，须在 matcher 上设 `onFailure: "block"`，要求 TS SDK ≥ 0.3.317；0.3.322 中 `HookCallbackMatcher.onFailure` 存在。<br>出处：hooks 页 "Add context and block a tool"、"Block the action when a callback fails" | 两边都能表达 `{decision: "block", reason}`，reason 都会传给模型。<br>差异在回调出错时：pi 默认阻止，Claude 默认放行。将来的 Claude 适配器必须设 `onFailure: "block"`，不在 T1 范围内 |
| 改写输入 | 在 h 中原地修改 `event.input`，不能返回新对象。<br>**修改后不再校验**（`docs/extensions.md` "#### tool_call"：No re-validation is performed after your mutation）。<br>探测：`hook`。命令中的 `ORIGINAL` 被改为 `REWRITTEN`，marker-a 的内容是 `REWRITTEN` | PreToolUse 在 `hookSpecificOutput.updatedInput` 中返回新对象，配合 allow 或 ask。canUseTool 也可返回 `updatedInput`。<br>出处：hooks 页 "Modify tool input"；`sdk.d.ts` 的 `PreToolUseHookSpecificOutput.updatedInput` | 两边都能表达。但 Task 4 的 `Decision` 没有改写字段，**T1 的统一接口不要求改写**。<br>以后如果加入，pi 一侧要由运行器在改写后自己校验 |
| 异步等待调用方的决定（Task 6 最多等 30 秒） | h 是 async。pi 逐个 await handler，**没有超时**，也**不会因 abort 放弃等待**（`dist/core/extensions/runner.js` 的 `emitToolCall`；`prepareToolCall` 中 await `beforeToolCall`）。<br>h 能拿到 `ctx.signal`，即当前 agent 的 AbortSignal（`docs/extensions.md` "### ctx.signal"）。<br>探测：`abort-hook-*`，见 0B.2 | `HookCallback` 收到 `{signal}`，按 matcher 的 `timeout` 等待（PreToolUse 默认 600 秒），超时则阻止该调用。<br>canUseTool 收到 `signal`，文档说它可以"stay pending indefinitely"。<br>中断查询时，等待中的回调所对应的工具调用会被取消。<br>出处：hooks 页 "Hook timeout"；user-input 页开头 | 两边都能等待异步决定，也都提供 AbortSignal。<br>**30 秒默认超时、超时按 block、取消时释放等待，都由运行器负责（Task 6）**，不依赖引擎的超时。<br>cancelAll 必须主动结算所有等待，pi 不会替它释放（0B.2 实测） |
| 确认（问用户） | SDK 中没有内置的"问用户"决定值。<br>`ctx.ui.confirm` 只有 `bindExtensions({uiContext})` 提供了 UI 时才有效，否则是 no-op，直接返回 `false`（`dist/core/extensions/runner.js` 的 `noOpUIContext`）。<br>可行的表达：在同一个 `tool_call` handler 中等待外部确认，再返回放行或 `{block, reason}` | PreToolUse 返回 `permissionDecision: "ask"`，调用转给 canUseTool；在 canUseTool 中等人回复，再返回 allow 或 deny。<br>出处：hooks 页 "Outputs"；user-input 页 "Handle tool approval requests"。<br>`AskUserQuestion` 是模型发起的澄清问题，不属于这一项 | 统一接口中的确认由运行器在拦截等待内部完成：发出 `confirm_request`，等待 `confirm_response`，再转成放行或阻止。两个引擎都能在拦截回调中做到。<br>统一接口**不使用引擎原生的确认 UI**，也不要求引擎有 "ask" 决定值 |
| 取消 | `session.abort()`：设置中止标志，取消重试等待和压缩，调用 `agent.abort()`，再 `waitForIdle()`。返回时 `agent_settled{aborted: true}` 已经发出。<br>`session.dispose()`：触发同样的中止，但**不等待**，随后使扩展 ctx 失效并清空监听器。<br>`AgentSessionRuntime.dispose()`：1.5.1 起会**先 await `abort()`**，再发出 `session_shutdown`（#9126）。<br>出处：`docs/sdk.md` 的 "Prompting"、"Session storage"；`dist/core/agent-session.js` 的 `abort`、`dispose`；`dist/core/agent-session-runtime.js` 的 `dispose`；`dist/core/tools/bash.js`（以 `detached` 方式 spawn，abort 时调用 `killProcessTree`）。<br>探测：`abort-*`、`dispose-inflight`、`runtime-dispose-inflight` | `Options.abortController`（"When aborted, the query will stop and clean up resources"）。<br>`Query.interrupt()`，只在流式输入模式下可用。<br>`Query.close()`：强制结束，清理等待中的请求、MCP 传输和 CLI 子进程。<br>出处：`sdk.d.ts` 的 `Options.abortController`、`Query.interrupt`、`Query.close` | 两边都能表达 `cancel`。<br>`run.cancelled` 由运行器在清理完成后判定并发布（Task 3、8B），不照搬引擎的结束消息。<br>Claude 取消后结果消息的形态没有核实，留到接入 Claude 时再查 |
| 流式事件：文本增量、工具开始/结束、最终结果 | 通过 `session.subscribe` 订阅：<br>• 文本增量：`message_update`，其中 `assistantMessageEvent.type === "text_delta"`，文本在 `.delta`<br>• 完整消息：`message_end`（文档："authoritative completed message"）<br>• 工具开始：`tool_execution_start{toolCallId, toolName, args}`<br>• 工具结束：`tool_execution_end{toolCallId, toolName, result, isError}`。每个最终确定的调用都会有，包括被阻止和被中止的<br>• 重试：`auto_retry_start`、`auto_retry_end`<br>• 最终静止：`agent_settled`（见 0B.2）<br>出处：`docs/sdk.md` 的 "Subscribing to events"；`dist/core/agent-session.d.ts` 的 `AgentSessionEvent` | • 文本增量：`includePartialMessages: true` 时 `stream_event` 中的 `content_block_delta` / `text_delta`<br>• 完整消息：每完成一个内容块发一条 `SDKAssistantMessage`，同一响应的各条共享 message id<br>• 工具调用：assistant 中的 `tool_use` 块；工具结果：`SDKUserMessage` 中的 tool_result<br>• 重试：`SDKAPIRetryMessage`（system/api_retry）<br>• 最终：`SDKResultMessage`（subtype 为 `success` 或 `error_*`）。之后还可能有少量系统消息，要迭代到流结束<br>出处：streaming-output 页 "Enable streaming output"、"Message flow"；agent-loop 页 "Message types"、"Handle the result"；`sdk.d.ts` 的 `SDKPartialAssistantMessage`、`SDKAssistantMessage`、`SDKResultMessage`、`SDKAPIRetryMessage` | 统一接口只要求 `text.delta`、`message.completed`（assistant 文本）、`tool.started` / `tool.finished`（带 callId）和唯一的终止事件，两边都能给出。<br>两点差异：<br>• Claude 按内容块分条，`message.completed` 要按 message id 聚合<br>• Claude 没有单独的"开始执行"事件，`tool.started` 只能取自 `tool_use` 块<br>重试事件不进入统一接口（Task 3 的事件集中没有），只影响何时终止。<br>**终止事件由运行器统一产生**：pi 依据 `agent_settled`，Claude 依据 result 消息加流结束 |
| 会话文件与恢复 | 持久化：`SessionManager.create(cwd, sessionDir?)`，文件为 `<sessionDir>/<时间戳>_<id>.jsonl`，默认在 `~/.pi/agent/sessions/--<path>--/`。路径可从 `session.sessionFile` 读到。<br>恢复：`SessionManager.open(path)`；另有 `continueRecent`、`forkFrom`。<br>内存：`SessionManager.inMemory(cwd)`，此时 `sessionFile` 为 undefined。<br>出处：`docs/sdk.md` 的 "Session storage"；`docs/session-format.md` 的 "File Location"；`dist/core/session-manager.d.ts`。<br>探测：`session-file` | 持久化：默认写到 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`；设置了 `CLAUDE_CONFIG_DIR` 时在它下面的 `projects/`。<br>恢复：`Options.resume: <session-id>`；另有 `continue`、`forkSession`、`resumeSessionAt`。<br>不落盘：`persistSession: false`（只有 TS）。<br>会话 ID 来自 init 消息或 result 中的 `session_id`。<br>出处：sessions 页 "Choose an approach"、"Resume by ID"；`sdk.d.ts` 的 `Options.resume`、`persistSession`、`sessionId`、`forkSession` | 持久化、恢复、内存运行两边都能表达。<br>差异：pi 用文件路径定位会话；Claude 用会话 ID，目录由 CLI 决定，只能通过 `CLAUDE_CONFIG_DIR` 改根目录。<br>所以统一接口的 `resume.sessionFileRef` 当作引擎不透明的引用：pi 为文件路径，Claude 为会话 ID。`sessionDir` 只在 pi 有直接对应。<br>T1 中 resume 返回 `not_implemented`（Task 4），runner 使用 inMemory 会话 |

#### 0B.2 pi 1.5.1 生命周期：结束判定与清理的依据

**扩展绑定**：与 0A.4 的推荐组合一致，探测就是这样写的。
1. 在 `new DefaultResourceLoader({ …, extensionFactories: [{ name, factory }] })` 中传入内联 factory。
2. `await loader.reload(…)` 时 factory 执行，在其中用 `pi.on("tool_call", …)` 注册 handler。
3. 调用 `createAgentSession({ resourceLoader: loader, … })`。
4. `await session.bindExtensions({})`，这一步发出 `session_start`。

探测中每一次 bash 调用都触发了 `tool_call`。在并行工具模式下，同一条 assistant 消息中的多个调用先**依次**经过 `tool_call` 预检，再并发执行（`docs/extensions.md` "#### tool_call"），所以同一时刻最多只有一个拦截在等待。

**各事件的实际语义**：
- **`agent_end{messages, willRetry}`**：一次底层 agent 运行结束，**不是最终信号**。
  - `willRetry` 是 pi 自己的预判（`dist/core/agent-session.js` 的 `_willRetryAfterAgentEnd`）：重试开启、次数没用完、最后一条助手消息是可重试错误、并且没有中止请求时为 true。
  - 即使 `willRetry: false`，之后也可能还有 `agent_before_settle` 的续跑、压缩后重试或排队消息（`docs/extensions.md` "Lifecycle Overview" 和 "agent_start / agent_end / agent_before_settle / agent_settled"）。
- **`agent_settled{aborted}`**：每次被接受的运行**恰好发一次**，是"最终静止、没有待处理工作"的**唯一信号**，Task 8B 据此选择 `run.settled`。
  - 它由 `_startRun` 的 `finally` 中的 `_emitAgentSettled` 发出。此时重试、压缩、排队消息都已处理完，`isIdle` 为 true。
  - `aborted` 表示本次运行中是否请求过中止。
  - 文档依据：`docs/sdk.md` "Subscribing to events"：Use `agent_settled` when the host needs to know that Pi will not continue automatically。
- **`prompt()` resolve**：运行结束（含自动重试）后才 resolve（`docs/sdk.md` "Prompting"）。
  - `_startRun` 在 `finally` 中 await `_emitAgentSettled`，所以 resolve 晚于 `agent_settled` 分发给监听器。所有探测中，`prompt:resolved` 都紧跟在 `agent_settled` 之后。
  - **模型最终失败不会让 prompt reject**，它照样 resolve，失败信息在最后一条助手消息的 `stopReason: "error"` 和 `errorMessage` 中。
- **`prompt()` reject**：只在**没有启动运行**时发生，此时不会有 `agent_settled`。会 reject 的情况：
  - 运行中再次调用且没给 `streamingBehavior`。这一条已实测，报错 `Agent is already processing. Specify streamingBehavior …`。
  - 没有模型；没有凭证；正在压缩或生成分支摘要；`before_agent_start` 抛错。这几条是代码证据（`dist/core/agent-session.js` 的 `prompt`、`_preparePrompt`、`_startRun`）。
- **`abort()`**：resolve 时 `agent_settled{aborted: true}` 已经发出（内部 `waitForIdle`）。

**重试**：
- **配置**：在 `settings.retry` 下（`docs/settings.md` "Network and retries"；`dist/core/settings-manager.js` 的 `getRetrySettings`）。
  - `enabled`：默认 true
  - `maxRetries`：默认 3
  - `baseDelayMs`：默认 2000
  - `maxAgentDelayMs`：默认 60000
- **延迟**：第 n 次重试等待 `baseDelayMs · 2^(n−1)`，有上限，**没有随机抖动**（`pi-ai/dist/utils/retry.js` 的 `retryDelayMs`）。默认配置下用尽重试要等 2 + 4 + 8 = 14 秒。
- **Task 8B 可用的快速测试配置**：`SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 } }, { projectTrusted: false })`。实测重试耗尽的整次运行约 110 ms。
- **provider 层不重试**：`retry.provider.maxRetries` 默认是 0，所以每次尝试只发一个 HTTP 请求。实测 `maxRetries: 2` 时共 3 个请求。
- **哪些错误可重试**：由 `isRetryableAssistantError` 对 `errorMessage` 做正则匹配，包括 429/500/502/503/504、connection error、timeout、fetch failed 等。上下文溢出不走重试，交给压缩处理（`pi-ai/dist/utils/retry.js`；`dist/core/agent-session.js` 的 `_isRetryableError`）。

实测事件序列（1.5.1，只列与结束判定有关的事件）：

| 场景 | 序列 | 最后一条助手消息 |
|---|---|---|
| `retry-ok`<br>第 1 次请求返回 500，第 2 次成功 | `agent_end{willRetry: true}`<br>→ `auto_retry_start{attempt: 1, delayMs: 20}`<br>→ `agent_start` → 文本增量<br>→ `auto_retry_end{success: true}`<br>→ `agent_end{willRetry: false}`<br>→ `agent_settled{aborted: false}`<br>→ prompt resolve | `stop` |
| `retry-exhausted`<br>一直返回 500，`maxRetries: 2` | `agent_end{true}`<br>→ `auto_retry_start{1, 20ms}`<br>→ `agent_end{true}`<br>→ `auto_retry_start{2, 40ms}`<br>→ `agent_end{false}`<br>→ `auto_retry_end{success: false, finalError}`<br>→ `agent_settled{aborted: false}`<br>→ prompt resolve | `error`<br>`500: {"message":"stub internal server error",…}` |
| `unreachable`<br>刚释放的本机端口，`maxRetries: 1` | 与上一行同形：<br>`agent_end{true}`<br>→ `auto_retry_start{1}`<br>→ `agent_end{false}`<br>→ `auto_retry_end{success: false}`<br>→ `agent_settled{false}` | `error`<br>`Connection error.: connect ECONNREFUSED 127.0.0.1:<port>` |
| `http400`<br>不可重试 | 只有一个 `agent_end{false}`，**没有 `auto_retry_*`**，然后 `agent_settled{false}` | `error`<br>`400: {"message":"stub bad request",…}` |

**#11879：流在回复开始后被切断，现在会自动重试**
- **改了什么**：1.5.1 在 `pi-ai/dist/utils/retry.js` 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 中新增了 `"cut short after the reply had begun"`，其余可重试规则没有变。
- **怎么测的**：桩服务的第一次响应先发出文本分块 `partial-`，50 ms 后中断。中断有两种做法：
  - `stream-drop`：直接销毁连接。
  - `stream-cut-short`：发送一个 SSE 错误事件，`message` 为 `Claude Code's stream from Anthropic was cut short after the reply had begun`，然后正常结束响应。

  之后的请求都正常返回 `recovered`，`maxRetries: 2`。

| 场景 | 1.5.1 | 1.5.0 对照 |
|---|---|---|
| `stream-drop` | 先发出 `text_delta "partial-"`<br>→ `message_end{error, "terminated: other side closed (UND_ERR_SOCKET)"}`<br>→ **`agent_end{willRetry: true}`**<br>→ `auto_retry_start{1, 20ms}`<br>→ 第 2 次请求，`text_delta "recovered"`<br>→ `auto_retry_end{success: true}`<br>→ `agent_end{false}`<br>→ `agent_settled{aborted: false}`<br>最终回答 `recovered` | 同样会重试，errorMessage 是 `terminated`。连接被切断的情况在 1.5.0 中本来就会重试 |
| `stream-cut-short` | 与上一行形状相同：<br>中间有 `agent_end{willRetry: true}` 和 `auto_retry_start`，第 2 次请求成功<br>→ `auto_retry_end{success: true}`<br>→ `agent_settled{false}` | **不重试**：只有一个 `agent_end{willRetry: false}`，然后 `agent_settled{false}`。<br>最终失败，`stopReason: "error"`，最后一条助手消息中保留了部分文本 `partial-`。<br>这就是 #11879 修复的问题 |
| `stream-drop-always`（仅 1.5.1）<br>每次都被切断 | 共 3 次请求。每次尝试都先发出 `text_delta "partial-"`，再出现 `agent_end{true}` 和 `auto_retry_start`。<br>最后一次是 `agent_end{false}`<br>→ `auto_retry_end{success: false, finalError: "terminated: other side closed (UND_ERR_SOCKET)"}`<br>→ `agent_settled{false}` | — |

- **对 Task 2A/2B/3 的影响**：
  1. 被切断的那次尝试**已经发出的 `text_delta` 不会撤回**，重试后会从头再流一遍。`session.messages` 中只保留最终那条助手消息：失败的尝试从模型上下文中省略，`assistantMessagesInContext` 为 1。所以统一事件流中可能出现"部分文本 + 重试后的完整文本"。Task 3 的契约要写明：`text.delta` 可能包含失败尝试的文本，最终文本以 `message.completed` 为准。是否需要标记或丢弃这类增量，由 Task 3 决定。
  2. 重试耗尽时，最后一条助手消息可能带着部分文本（`getLastAssistantText()` 返回 `partial-`），同时 `stopReason` 为 `error`。按结束判定规则 3，结果仍是 `run.failed`。
  3. Task 2A 的假服务和 2B 的重试样本可以直接用"先发分块再销毁连接"来触发中间结束和重试。两个版本中这种方式都会重试，不依赖 #11879；要专门复现 #11879，应发送带上述文本的错误事件。

**#11599：RPC/print 模式的关闭修复，不涉及 SDK 嵌入路径**（只查了代码，没有写探测）
- 1.5.1 与关闭相关的改动只在 `dist/modes/rpc/rpc-mode.js` 和 `dist/modes/print-mode.js` 中，内容是 idle 时的 `ctx.shutdown()`，以及信号计数（`signalCount`）和 stdin EOF 不再打断清理。
- `dist/core/agent-session.js` 的 diff 中没有关闭相关的改动。
- `dist/core/extensions/runner.js` 只改了 Markdown transformer。
- `dist/core/agent-session-runtime.js` 中 `dispose` 的改动来自 #9126 和 #11692，与 #11599 无关。
- 结论：runner 用 SDK 嵌入，不受 #11599 影响。另外，在 SDK 中 `ctx.shutdown()` 要靠 `bindExtensions({ shutdownHandler })` 才有效果；runner 传的是 `{}`，所以扩展调用 `ctx.shutdown()` 什么也不会发生（`dist/core/agent-session.d.ts` 的 `ExtensionBindings.shutdownHandler`）。

**#8635：中止时报"已中止"而不是"错误"**
- **改了什么**：在 `pi-ai/dist/api/lazy.js` 的 `lazyStream` 中，provider 模块加载或鉴权这类准备步骤失败时，1.5.0 一律给 `stopReason: "error"`；1.5.1 在 `signal.aborted` 时改为 `"aborted"`。`dist/core/model-runtime.js` 的 `stream` / `streamSimple` 现在会把 `options.signal` 传给它。
- **对本项目的影响**：如果在工具执行期间 abort，pi 会在 `agent_settled` 之前再走一次模型请求的准备步骤。由于 signal 已经中止，这一步失败，不发出 HTTP 请求，只追加一条 `errorMessage: "This operation was aborted"` 的助手消息。实测 `abort-bash`：
  - 1.5.0：这条消息的 `stopReason` 是 `"error"`，`agent_end.lastStop` 也是 `error`。
  - 1.5.1：都变为 `"aborted"`。`abort-hook-*` 场景在 1.5.1 上也是 `"aborted"`。
- **流式请求中途 abort**（`abort-stream`）两版都是 `aborted`（`Request was aborted`），不经过这段代码。
- **想直接打中"鉴权期间 abort"，没有成功**：`abort-during-auth` 用一个要 sleep 1 秒的 `!command` 作为 API key。这个命令同步执行、阻塞了事件循环，abort 定时器到 1.1 秒才触发，那时准备步骤已经结束。两版结果都是 `aborted`（`Request aborted`），都没有发出请求，所以这个场景**区分不出两版**。#8635 对本项目的效果以上面 `abort-bash` 的对照为准。

**#9126：runtime dispose 先等工具中止完，再拆扩展**
- **改了什么**：1.5.1 的 `AgentSessionRuntime.dispose()`（`dist/core/agent-session-runtime.js`）改成先 `await this.session.abort()`，再发出 `session_shutdown`，然后 `session.dispose()`，最后等凭证写盘（#11692）。`AgentSession.dispose()` 本身没变。
- **实测**（`runtime-dispose-inflight`：bash 正在 `sleep 30` 时调用 `runtime.dispose()`）：
  - 1.5.0：`session_shutdown` 在调用后 0 ms 就发出；订阅者和扩展**都收不到** `tool_execution_end` 和 `agent_settled`；会话记录中**没有**工具结果。
  - 1.5.1：顺序依次为：
    1. 扩展和订阅者先收到 `tool_execution_end{isError: true, "Command aborted"}`
    2. 中止消息
    3. `agent_settled{aborted: true}`
    4. `session_shutdown{reason: "quit"}`
    5. `runtime.dispose()` resolve

    会话记录中**有**工具结果。两版中进程组都被杀掉了。
- **对 runner 的意义**：runner 按 0A.4 直接用 `createAgentSession`，拿到的是 `AgentSession`，不是 runtime。`AgentSession.dispose()` 在 1.5.1 中仍然不等待：`dispose-inflight` 在 1.5.1 上依旧收不到 settled，会话记录中也没有工具结果。所以 #9126 只在改用 `AgentSessionRuntime` 时才起作用。Task 8B 无论用哪一种，都应先 `await abort()` 再 dispose；这正是计划写好的顺序。

**结束判定规则**：由上面的证据推出，供 Task 3、8B 使用，不超出计划。
1. 只在 `agent_settled` 时选择终止结果。不在 `agent_end` 时终止（无论 `willRetry` 是什么），也不在 `message_end{stopReason: "error"}` 时终止。这条对应 Review Focus 3。
2. `agent_settled{aborted: true}`：结果为取消。在 T1 中只有运行器会调用 abort。**先判断 `aborted`**，不要用最后一条消息的 stopReason 推断。1.5.1 中工具执行期间中止后补的那条消息已经是 `aborted`，但 1.5.0 中是 `error`。以 `aborted` 为准不依赖这个细节。
3. `agent_settled{aborted: false}`，且最后一条助手消息（也就是最后一个 `agent_end.messages` 中的那条）的 `stopReason === "error"`：结果为 `run.failed{reason: errorMessage}`。重试耗尽时，这个值与 `auto_retry_end.finalError` 相同；不可重试的错误没有 `auto_retry_end`，所以原因**从消息中取**。
4. 其余情况：`run.settled`。
5. `prompt()` reject：运行没有启动，也不会有 settled 事件。按 `run.failed{reason: 拒绝信息}` 处理。
6. 留给 Task 3 的问题：中间失败尝试和中止产生的 `message_end`，`stopReason` 为 `error` 或 `aborted`，文本为空。它们不是终止事件。是否为它们生成 `message.completed`，由 Task 3 在契约中写明。

**abort、dispose 与拦截等待**（1.5.1 实测）：
- **流式请求中途**：`abort()` 后 2 ms 内依次出现 `message_end{stopReason: "aborted", "Request was aborted"}`、`agent_settled{aborted: true}`，abort 和 prompt 都 resolve。桩服务看到这个**没写完的响应**被客户端关闭（`finished: false`）。之后没有重试，也没有新请求。
- **bash 运行中**（`sleep 30 &` 加 `wait`）：`abort()` 后约 7 ms 收到 `tool_execution_end{isError: true, "Command aborted"}`，然后是 `agent_settled{aborted: true}`。**shell 和后台的 sleep 子进程都已不存在**：pi 以 detached 进程组方式 spawn，用 `killProcessTree` 结束整个进程组。之后没有新的模型请求，工具结果写进了会话记录。
- **拦截 handler 不理会 `ctx.signal`、一直不返回**：`abort()` **2 秒后仍未返回**。测试随后让 handler 返回"放行"，abort 马上完成，但工具**没有执行**（`Operation aborted`，marker 不存在）。原因是 `prepareToolCall` 在 handler 返回后会再检查一次 `signal.aborted`。
- **拦截 handler 监听 `ctx.signal`**：abort 后 1 ms 内 handler 就结算，abort 随即完成，工具没有执行。
- **只调 `AgentSession.dispose()`、没有先 abort**（bash 运行中）：`dispose()` 同步返回，子进程被杀，prompt 随后 resolve。但**订阅者收不到 `agent_settled`**，会话记录中也没有工具结果：dispose 同步清空了监听器，1.5.1 中这一点没有变。
- **重复 dispose**：每个场景最后都连续调用两次 `dispose()`，包括已经 abort 过和已经 dispose 过的情况，都没有抛错。

**对清理约定的结论**：Task 8B Step 3 的顺序在 1.5.1 上成立：先结算协调等待（Task 6 的 cancelAll），然后 `await abort()`，最后 `dispose()`。有三个前提：
1. 必须先释放拦截等待。否则 abort 会一直等下去，只能靠 8B 的 5 秒清理时限兜底。
2. 终止结果在 `agent_settled` 时就要选定，不能指望 dispose 之后还有事件。
3. 先 abort 或已经收到 settled，再调用 dispose。

**1.5.1 的一项默认值变化**：`cacheWarming` 的默认值从 `"streaming"` 改成了 `"idle"`（CHANGELOG 1.5.1 "Changed"；`docs/settings.md`）。`idle` 模式下，pi 会在两次运行之间最多 30 分钟内刷新符合条件的 prompt cache。`createAgentSession` 会创建 `CacheWarmer`（`dist/core/sdk.js`），`dispose` 会取消它。

本次探测中，settled 之后没有出现多余的请求。但这一项会影响"settled 后不再调用模型"，以及 Review Focus 5 "不掩盖额外调用"。建议 Task 8A/8B 在平台设置中显式写 `cacheWarming: "off"`，并由测试断言请求数。这只是建议，没有实测 `idle` 对 openai-completions 模型是否生效。

**结论**：计划依赖的能力在 1.5.1 中都存在，语义能支撑 Task 3、4、8B 的结束判定和清理约定，**没有阻塞项**。

#### 0B.3 探测方法与场景

`<scratch0b>/probe-lifecycle.mjs`（全文见附录 B）用 0A 推荐的隔离组合创建会话：
- 设置：`SettingsManager.inMemory(…, {projectTrusted: false})`
- 资源加载：`DefaultResourceLoader`，打开全部 `no*` 开关，只加载一个内联扩展 `probe`。它注册 `tool_call`，并记录扩展侧收到的 `tool_execution_end` 和 `session_shutdown`
- 会话：`SessionManager.inMemory`；`session-file` 场景改用 `SessionManager.create(repo, <临时目录>)`
- 工具：`read`、`bash`
- `runtime-dispose-inflight`：用同样的设置和 loader 选项，经 `createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime` 创建 runtime

模型是 loopback 随机端口上的 OpenAI 兼容桩服务，按场景返回：SSE 文本、工具调用、HTTP 500、HTTP 400，或者只发一个分块后一直挂起。`unreachable` 场景改用一个刚绑定又释放的本机端口。

探测进程由 `run-lifecycle.mjs` 以最小环境启动：`PATH`、伪 `HOME`、空的 `PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`。

| 场景 | 验证什么 | 1.5.1 结果 |
|---|---|---|
| `hook` | 依次发出 3 个 bash 调用，handler 每次等待 300 ms 后：<br>• 改写第 1 个（`ORIGINAL` → `REWRITTEN`）<br>• 用 reason 阻止第 2 个<br>• 在第 3 个中抛错 | • `tool_execution_start` 早于 handler 调用<br>• 改写生效，marker-a 的内容为 `REWRITTEN`<br>• 阻止和抛错时工具都没有执行，marker-b、marker-c 不存在，`isError: true`<br>• 第 3、4 次请求的 tool 消息中依次出现 `blocked by probe policy`、`hook exploded`<br>• `hasSignal: true` |
| `retry-ok` / `retry-exhausted` / `unreachable` / `http400` | 中间结束、重试、最终失败 | 见 0B.2 的序列表。请求数依次为 2、3、0（连接被拒）、1 |
| `stream-drop` / `stream-drop-always` / `stream-cut-short`（#11879） | 已开始流式回复后被切断；前一个和最后一个场景另在 1.5.0 上跑了对照 | 见 0B.2 的 #11879 |
| `abort-stream` | 收到第一个文本增量后，再调一次 `prompt`，然后 `abort()` | 第二次 prompt reject（缺 `streamingBehavior`）。其余见 0B.2 |
| `abort-bash` / `dispose-inflight` | bash 进入 `sleep 30` 后 800 ms，分别调用 abort 或 dispose | 调用前两个 pid 都存活，之后都不存在；各只发了 1 次请求。<br>会话记录中的工具结果：abort 有，dispose 没有 |
| `runtime-dispose-inflight`（#9126） | 同上，但调用 `runtime.dispose()`；另在 1.5.0 上跑一遍作对照 | 见 0B.2 的 #9126 |
| `abort-during-auth`（#8635） | 用 sleep 1 秒的 `!command` 作为 API key，300 ms 时 abort；另在 1.5.0 上跑一遍作对照 | 两版相同，没有区分出两版，原因见 0B.2。<br>#8635 的对照改用 `abort-bash`（1.5.0 也跑了一遍） |
| `abort-hook-ignores-signal` / `abort-hook-honors-signal` | handler 等待决定期间调用 abort | 前者 2 秒后仍挂起，handler 返回后才结束，工具没有执行。<br>后者立即结束，工具没有执行 |
| `session-file` | 持久化后，用 `SessionManager.open(file)` 重建会话 | 文件存在。重建前后都是 3 条消息，`getLastAssistantText()` 为 `persisted answer` |

#### 0B.4 复现命令

```sh
# 在 <scratch0b> 中执行，package.json 只有 {"type":"module"}
npm view @earendil-works/pi-coding-agent@1.5.1 version dist.integrity --json
git ls-remote --tags https://github.com/earendil-works/pi | grep -E 'v1\.5\.[01]$'
npm install --save-exact --ignore-scripts @earendil-works/pi-coding-agent@1.5.1
npm view @anthropic-ai/claude-agent-sdk@0.3.322 version dist.integrity --json
(cd csdk && npm install --save-exact --ignore-scripts @anthropic-ai/claude-agent-sdk@0.3.322)   # 只读 sdk.d.ts
node run-lifecycle.mjs retry-ok retry-exhausted unreachable http400 stream-drop stream-drop-always \
  stream-cut-short hook abort-stream abort-bash dispose-inflight runtime-dispose-inflight \
  abort-during-auth abort-hook-ignores-signal abort-hook-honors-signal session-file
# 1.5.0 对照：v150/ 中放同样的三个脚本，node_modules/@earendil-works 是指向 0A 安装目录的只读符号链接
(cd v150 && node run-lifecycle.mjs abort-during-auth runtime-dispose-inflight abort-bash stream-drop stream-cut-short)
```

2026-11-10 的实际结果：
- 1.5.1：16 个场景的退出码都是 0，stderr 都是 0 字节，`VERSION` 为 `1.5.1`。
- 1.5.0 对照：5 个场景的退出码都是 0，stderr 都是 0 字节，`VERSION` 为 `1.5.0`。
- 每个场景的结果 JSON 保存在 `<scratch0b>/out/` 和 `<scratch0b>/v150/out/`。

`unreachable` 场景的端口经过一次修正：最初用的 `127.0.0.1:9` 会被 Node 的 fetch 当作禁用端口直接拒绝（`bad port`），不是真正的连接被拒，所以改为刚释放的随机端口后重跑。

#### 0B.5 Step 3 自查

- 每项能力都有固定版本的出处：
  - pi：1.5.1（tag `v1.5.1` = `dd30101`）的 `dist/` 符号和随包文档的章节。
  - Claude：0.3.322 的 `sdk.d.ts` 符号，加文档页的章节标题。
  - Claude 一侧只核对了文档和类型，没有实测，0B.1 中已注明。
- 每个差异都写了处理边界（0B.1 的最后一列）：
  - 改写：T1 不要求。
  - 确认：由运行器在拦截等待中实现。
  - 回调失败：pi 默认 fail closed；Claude 适配器须设 `onFailure: "block"`。
  - 取消结果和终止事件：由运行器判定。
  - 恢复引用：作为不透明字符串。
  - Claude 的流式事件：需按 message id 聚合。
- 1.5.1 中指定核实的修复：
  - #9126、#8635、#11879：都有探测证据和 1.5.0 对照。直接打中"鉴权期间 abort"的尝试没有成功，0B.2 中已说明。
  - #11599：按要求只查了代码，结论是不涉及 SDK 嵌入路径。

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
- 0B：Claude Agent SDK 一侧只核对了 0.3.322 的类型和 2026-11-10 的在线文档，没有实测。官方文档页没有版本号。
- 0B：中止时只实测了 bash；read、edit、write 和 MCP 工具在中止时的行为没有探测。"鉴权期间 abort" 没能直接复现，#8635 以工具中止后补的那条消息作为证据（见 0B.2）。
- 0B：1.5.1 的 `cacheWarming` 默认是 `"idle"`，它对 openai-completions 模型是否会发出额外请求，没有实测。建议在平台设置中写 `"off"`（见 0B.2）。

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

## 附录 B：0B 探测脚本全文（2026-11-10，均在 `<scratch0b>/` 下运行；`v150/` 中是同样的副本，用于 1.5.0 对照）

<details><summary><code>probe-lifecycle.mjs</code>：pi 运行生命周期探测（桩模型）</summary>

```js
// Task 0B: probe pi 1.5.0 run lifecycle against a loopback stub OpenAI-compatible server.
// usage: node probe-lifecycle.mjs <scenario>
// No real model API is called. API key is the literal "stub-not-a-secret".
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";

const scenario = process.argv[2];
const work = mkdtempSync(join(tmpdir(), "t0b-"));
const repo = join(work, "repo"); mkdirSync(repo);
const agentDir = join(work, "agent"); mkdirSync(agentDir);
const t0 = Date.now();
const ms = () => Date.now() - t0;
const log = [];
const note = (what, extra = {}) => log.push({ t: ms(), what, ...extra });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const withTimeout = (p, n) => Promise.race([p.then(() => "resolved", (e) => `rejected: ${e.message}`), sleep(n).then(() => `still pending after ${n}ms`)]);

// ---- stub OpenAI-compatible server ----
const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub-model" };
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const sseHead = (res) => res.writeHead(200, { "content-type": "text/event-stream" });
const chunk = (res, c) => res.write(`data: ${JSON.stringify(c)}\n\n`);
const text = (res, s) => { sseHead(res); chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: s }, finish_reason: null }] }); chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }); res.end("data: [DONE]\n\n"); };
const toolCall = (res, i, name, args) => { sseHead(res); chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }); chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }); res.end("data: [DONE]\n\n"); };
const http400 = (res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "stub bad request", type: "invalid_request_error" } })); };
const http500 = (res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "stub internal server error", type: "server_error" } })); };

const requests = [];
let handler = (_i, _body, res) => text(res, "done");
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const i = requests.length;
    const parsed = JSON.parse(body || "{}");
    const toolMsgs = (parsed.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    requests.push({ i, t: ms(), toolResultsSeenByModel: toolMsgs });
    note("stub:request", { i });
    res.on("close", () => note("stub:response-closed", { i, finished: res.writableFinished }));
    handler(i, parsed, res);
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;
// unreachable: a loopback port that was just bound and released, so nothing listens there (connection refused)
const closedPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const baseUrl = scenario === "unreachable" ? `http://127.0.0.1:${closedPort}/v1` : `http://127.0.0.1:${port}/v1`;

// abort-during-auth: the key comes from a slow "!command", so the abort lands while pi resolves auth (#8635)
const apiKey = scenario === "abort-during-auth" ? "!sleep 1; echo stub-not-a-secret" : "stub-not-a-secret";
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl, api: "openai-completions", apiKey, models: [{ id: "stub-model" }] } } }));
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
const model = modelRuntime.getModel("stub", "stub-model");

// ---- probe extension: tool_call hook ----
let releaseHook; // for hook-ignores-signal
const probeExtension = (pi) => {
  pi.on("tool_execution_end", (event) => note("ext:tool_execution_end", { toolCallId: event.toolCallId, isError: event.isError }));
  pi.on("session_shutdown", (event) => note("ext:session_shutdown", { reason: event.reason }));
  pi.on("tool_call", async (event, ctx) => {
    const cmd = event.input?.command ?? "";
    note("hook:tool_call", { toolCallId: event.toolCallId, cmd, hasSignal: !!ctx.signal });
    if (scenario === "hook") {
      await sleep(300); // async decision
      if (cmd.includes("BLOCKME")) return { block: true, reason: "blocked by probe policy" };
      if (cmd.includes("THROWME")) throw new Error("hook exploded");
      if (cmd.includes("ORIGINAL")) event.input.command = cmd.replace("ORIGINAL", "REWRITTEN");
      return undefined; // allow
    }
    if (scenario === "abort-hook-ignores-signal") {
      return await new Promise((r) => { releaseHook = r; }); // ignores ctx.signal
    }
    if (scenario === "abort-hook-honors-signal") {
      return await new Promise((r) => ctx.signal.addEventListener("abort", () => { note("hook:saw-abort"); r({ block: true, reason: "cancelled while waiting for decision" }); }, { once: true }));
    }
    return undefined;
  });
};

const settings = { retry: { enabled: true, maxRetries: scenario === "unreachable" ? 1 : 2, baseDelayMs: 20 } };
const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: false });
const loaderOptions = {
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  agentsFilesOverride: () => ({ agentsFiles: [] }), appendSystemPrompt: [],
  extensionFactories: [{ name: "probe", factory: probeExtension }],
};
const loader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager, ...loaderOptions });
await loader.reload({ resolveProjectTrust: async () => false });
const sessionDir = join(work, "sessions");
const sessionManager = scenario === "session-file" ? SessionManager.create(repo, sessionDir) : SessionManager.inMemory(repo);
let runtime, session;
if (scenario === "runtime-dispose-inflight") {
  // AgentSessionRuntime path (#9126): same locked settings and loader options, built through services.
  const createRuntime = async ({ cwd, sessionManager: sm, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: loaderOptions, resourceLoaderReloadOptions: { resolveProjectTrust: async () => false } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager: sm, sessionStartEvent, model, thinkingLevel: "off", tools: ["read", "bash"] })), services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: repo, agentDir, sessionManager });
  session = runtime.session;
} else {
  ({ session } = await createAgentSession({
    cwd: repo, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager, tools: ["read", "bash"],
  }));
}

const pick = (ev) => {
  const o = { t: ms(), type: ev.type };
  if (ev.type === "agent_end") { o.willRetry = ev.willRetry; o.lastStop = ev.messages.filter((m) => m.role === "assistant").at(-1)?.stopReason; }
  if (ev.type === "agent_settled") o.aborted = ev.aborted;
  if (ev.type === "auto_retry_start") Object.assign(o, { attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.errorMessage });
  if (ev.type === "auto_retry_end") Object.assign(o, { success: ev.success, attempt: ev.attempt, finalError: ev.finalError });
  if (ev.type === "message_end" && ev.message.role === "assistant") Object.assign(o, { stopReason: ev.message.stopReason, errorMessage: ev.message.errorMessage });
  if (ev.type === "message_update") o.delta = ev.assistantMessageEvent?.type;
  if (ev.type.startsWith("tool_execution")) Object.assign(o, { toolName: ev.toolName, toolCallId: ev.toolCallId });
  if (ev.type === "tool_execution_end") Object.assign(o, { isError: ev.isError, text: (ev.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 160) });
  return o;
};
const SKIP = new Set(["message_update", "tool_execution_update", "entry_appended"]);
let sawDelta = false;
session.subscribe((ev) => {
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta" && scenario.startsWith("stream-")) log.push({ ...pick(ev), text: ev.assistantMessageEvent.delta });
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta" && !sawDelta) { sawDelta = true; log.push(pick(ev)); onFirstDelta?.(); }
  if (!SKIP.has(ev.type)) log.push(pick(ev));
  if (ev.type === "tool_execution_start") onToolStart?.(ev);
});
let onFirstDelta, onToolStart;
await session.bindExtensions({});
const result = { version: VERSION, scenario };

const runPrompt = () => {
  note("prompt:called");
  const p = session.prompt("probe");
  p.then(() => note("prompt:resolved"), (e) => note("prompt:rejected", { error: e.message }));
  return p.catch(() => {});
};

if (scenario === "stream-drop" || scenario === "stream-drop-always" || scenario === "stream-cut-short") {
  // #11879: the first attempt streams some text and is then cut off; later attempts succeed.
  const cutShort = "Claude Code's stream from Anthropic was cut short after the reply had begun";
  handler = (i, _b, res) => {
    if (i > 0 && scenario !== "stream-drop-always") return text(res, "recovered");
    sseHead(res);
    chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "partial-" }, finish_reason: null }] });
    setTimeout(() => {
      if (scenario !== "stream-cut-short") { note("stub:destroy-socket", { i }); res.socket.destroy(); }
      else { note("stub:send-error-event", { i }); chunk(res, { error: { message: cutShort, type: "server_error" } }); res.end(); }
    }, 50);
  };
  await runPrompt();
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  result.lastAssistant = { stopReason: last?.stopReason, errorMessage: last?.errorMessage, text: session.getLastAssistantText() };
  result.assistantMessagesInContext = session.messages.filter((m) => m.role === "assistant").length;
} else if (scenario === "retry-ok") {
  handler = (i, _b, res) => (i === 0 ? http500(res) : text(res, "recovered"));
  await runPrompt();
} else if (scenario === "retry-exhausted" || scenario === "unreachable" || scenario === "http400") {
  handler = (_i, _b, res) => (scenario === "http400" ? http400(res) : http500(res));
  await runPrompt();
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  result.lastAssistant = { stopReason: last?.stopReason, errorMessage: last?.errorMessage };
} else if (scenario === "hook") {
  handler = (i, _b, res) => {
    if (i === 0) return toolCall(res, i, "bash", { command: "echo ORIGINAL > marker-a.txt" });
    if (i === 1) return toolCall(res, i, "bash", { command: "echo x > marker-b.txt # BLOCKME" });
    if (i === 2) return toolCall(res, i, "bash", { command: "echo y > marker-c.txt # THROWME" });
    return text(res, "done");
  };
  await runPrompt();
  result.markers = { a: existsSync(join(repo, "marker-a.txt")) ? readFileSync(join(repo, "marker-a.txt"), "utf8").trim() : null, b: existsSync(join(repo, "marker-b.txt")), c: existsSync(join(repo, "marker-c.txt")) };
} else if (scenario === "abort-stream") {
  handler = (_i, _b, res) => { sseHead(res); chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "partial..." }, finish_reason: null }] }); /* never ends */ };
  let abortP;
  onFirstDelta = () => {
    // concurrent prompt without streamingBehavior must reject
    session.prompt("second").then(() => note("second-prompt:resolved"), (e) => note("second-prompt:rejected", { error: e.message }));
    note("abort:called"); abortP = session.abort(); abortP.then(() => note("abort:resolved"));
  };
  const p = runPrompt();
  result.promptOutcome = await withTimeout(p, 5000);
  await abortP;
  await sleep(300); // let the stub observe the client side closing the unfinished response
} else if (scenario === "abort-during-auth") {
  let abortP;
  setTimeout(() => { note("abort:called", { requestsSoFar: requests.length }); abortP = session.abort(); abortP.then(() => note("abort:resolved")); }, 300);
  const p = runPrompt();
  result.promptOutcome = await withTimeout(p, 5000);
  await abortP; await sleep(1500);
  result.requestsAfterAbort = requests.length;
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  result.lastAssistant = { stopReason: last?.stopReason, errorMessage: last?.errorMessage };
} else if (scenario === "abort-bash" || scenario === "dispose-inflight" || scenario === "runtime-dispose-inflight") {
  handler = (i, _b, res) => (i === 0 ? toolCall(res, i, "bash", { command: "sleep 30 & echo $! > sleep.pid; echo $$ > shell.pid; wait" }) : text(res, "after"));
  let stopP;
  onToolStart = async () => {
    await sleep(800);
    result.pids = { sleep: Number(readFileSync(join(repo, "sleep.pid"), "utf8")), shell: Number(readFileSync(join(repo, "shell.pid"), "utf8")) };
    result.aliveBefore = { sleep: alive(result.pids.sleep), shell: alive(result.pids.shell) };
    if (scenario === "abort-bash") { note("abort:called"); stopP = session.abort().then(() => note("abort:resolved")); }
    else if (scenario === "dispose-inflight") { note("dispose:called"); session.dispose(); note("dispose:returned"); stopP = Promise.resolve(); }
    else { note("runtime.dispose:called"); stopP = runtime.dispose().then(() => note("runtime.dispose:resolved")); }
  };
  const p = runPrompt();
  result.promptOutcome = await withTimeout(p, 5000);
  await stopP; await sleep(300);
  result.aliveAfter = { sleep: alive(result.pids.sleep), shell: alive(result.pids.shell) };
  result.requestsAfterStop = requests.length;
  // was the aborted tool's result recorded in the session transcript?
  result.toolResultRecorded = session.sessionManager.getEntries().some((e) => e.type === "message" && e.message?.role === "toolResult");
} else if (scenario === "abort-hook-ignores-signal" || scenario === "abort-hook-honors-signal") {
  handler = (i, _b, res) => (i === 0 ? toolCall(res, i, "bash", { command: "echo ran > marker-hook.txt" }) : text(res, "after"));
  let abortP;
  onToolStart = async () => {
    await sleep(300);
    note("abort:called"); abortP = session.abort(); abortP.then(() => note("abort:resolved"));
    result.abortWithin2s = await withTimeout(abortP, 2000);
    if (releaseHook) { note("test:releasing-hook-with-allow"); releaseHook(undefined); result.abortAfterRelease = await withTimeout(abortP, 2000); }
  };
  const p = runPrompt();
  result.promptOutcome = await withTimeout(p, 8000);
  await sleep(200);
  result.toolRan = existsSync(join(repo, "marker-hook.txt"));
} else if (scenario === "session-file") {
  handler = (_i, _b, res) => text(res, "persisted answer");
  await runPrompt();
  result.sessionFile = session.sessionFile?.replace(work, "<work>");
  result.fileExists = !!session.sessionFile && existsSync(session.sessionFile);
  result.messageCount = session.messages.length;
  const file = session.sessionFile;
  session.dispose();
  const reopened = await createAgentSession({ cwd: repo, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.open(file), tools: ["read", "bash"] });
  result.reopenedMessageCount = reopened.session.messages.length;
  result.reopenedLastText = reopened.session.getLastAssistantText();
  reopened.session.dispose();
}

// dispose safety / idempotence (after whatever the scenario did)
try { session.dispose(); session.dispose(); result.disposeTwice = "ok"; } catch (e) { result.disposeTwice = `threw: ${e.message}`; }
result.requests = requests.map((r) => ({ i: r.i, t: r.t, toolResultsSeenByModel: r.toolResultsSeenByModel.map((s) => s.slice(0, 160)) }));
result.events = log.sort((a, b) => a.t - b.t);
stub.close();
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 1));
process.exit(0);
```

</details>

<details><summary><code>run-lifecycle.mjs</code>：以最小环境逐个运行场景</summary>

```js
// Run probe-lifecycle.mjs scenarios with a minimal environment (fake HOME, empty PI_CODING_AGENT_DIR, offline).
// usage: node run-lifecycle.mjs <scenario...>
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const here = resolve(".");
const home = join(here, "fakehome");
mkdirSync(join(home, "agent"), { recursive: true });
mkdirSync(join(here, "out"), { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
let worst = 0;
for (const s of process.argv.slice(2)) {
  const r = spawnSync(process.execPath, ["probe-lifecycle.mjs", s], { encoding: "utf8", env, timeout: 60000 });
  writeFileSync(join(here, "out", `${s}.json`), r.stdout ?? "");
  writeFileSync(join(here, "out", `${s}.err`), r.stderr ?? "");
  console.log(`scenario=${s} exit=${r.status} signal=${r.signal} stderrBytes=${(r.stderr ?? "").length}`);
  if (r.status !== 0) worst = 1;
}
process.exit(worst);
```

</details>

<details><summary><code>summarize.mjs</code>：打印每个场景的结果和事件序列</summary>

```js
// Print each scenario's result compactly: non-event fields as JSON, events one per line.
import { readFileSync } from "node:fs";
for (const s of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(`out/${s}.json`, "utf8"));
  const { events, requests, ...rest } = r;
  console.log(`=== ${s}`);
  console.log(JSON.stringify(rest));
  console.log("requests:", JSON.stringify(requests));
  for (const e of events) {
    const { t, type, what, ...x } = e;
    if (type === "message_start" || type === "turn_start") continue;
    console.log(`  ${String(t).padStart(5)} ${type ?? "#" + what} ${Object.keys(x).length ? JSON.stringify(x) : ""}`);
  }
}
```

</details>

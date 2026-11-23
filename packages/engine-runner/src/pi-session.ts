import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager, VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot, StartTask } from "@forgepilot/engine-protocol";
import type { createInterceptCoordinator } from "./intercept-coordinator.js";
import { createInterceptExtension } from "./intercept-extension.js";
import { loadModelRuntime } from "./model-config.js";
import { createRestrictedResourceLoader } from "./restricted-resource-loader.js";

const inside = (root: string, p: string) => { const r = relative(root, p); return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)); };

/** sessionDir 只能是 sessionsRoot 下的相对路径；返回校验后的绝对目录（尚未创建）。 */
function resolveSessionDir(sessionsRoot: string, sessionDir: string): string {
  const fail = (why: string) => new Error(`sessionDir ${why}: ${sessionDir}`);
  if (isAbsolute(sessionDir)) throw fail("must be relative to sessionsRoot");
  mkdirSync(sessionsRoot, { recursive: true });
  const realRoot = realpathSync(sessionsRoot);
  const target = resolve(realRoot, sessionDir);
  if (!inside(realRoot, target)) throw fail("escapes sessionsRoot");
  // 最深的已存在祖先解开软链接后仍须在根内；其下的新目录由我们自己创建，不会再跳出
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!inside(realRoot, realpathSync(existing))) throw fail("escapes sessionsRoot via symlink");
  return target;
}

export async function createPiSession(opts: {
  task: StartTask;
  modelsPath: string;
  workDir: string;
  scratchDir: string;
  sessionsRoot: string;
  decide: ReturnType<typeof createInterceptCoordinator>["decide"];
  signal: AbortSignal;
}): Promise<{ session: AgentSession; snapshot: RunSnapshot }> {
  const { task } = opts;
  const sessionDir = task.sessionDir === undefined ? undefined : resolveSessionDir(opts.sessionsRoot, task.sessionDir);
  const modelRuntime = await loadModelRuntime(opts.modelsPath, opts.scratchDir);
  const model = modelRuntime.getModel(task.model.provider, task.model.id);
  if (!model) throw new Error(`model not found: ${task.model.provider}/${task.model.id}`);
  await modelRuntime.getAuth(model); // 缺少环境变量引用时在这里抛出 pi 的明确错误，而不是等到首个请求

  const restricted = await createRestrictedResourceLoader({
    scratchDir: opts.scratchDir,
    contextFiles: task.contextFiles,
    extensionFactories: [createInterceptExtension(opts.decide, opts.signal)],
  });
  const { session } = await createAgentSession({
    cwd: opts.workDir, // 只决定内置工具的工作目录
    agentDir: opts.scratchDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: restricted.loader,
    settingsManager: restricted.settingsManager, // 必须显式传：缺省会回退到信任项目设置的 SettingsManager.create
    sessionManager: sessionDir ? SessionManager.create(opts.workDir, sessionDir) : SessionManager.inMemory(opts.workDir),
  });
  return {
    session,
    snapshot: { engine: { name: "pi", version: VERSION }, model: { provider: model.provider, id: model.id }, contextFiles: restricted.loadedContextFiles() },
  };
}

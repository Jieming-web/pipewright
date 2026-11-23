import { createHash } from "node:crypto";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ContextFile, RunSnapshot } from "@forgepilot/engine-protocol";

// 0A.4 的 locked 组合：pi 只能看到调用方规则和显式平台扩展，不读仓库/祖先/用户目录里的任何资源。
// cwd 与 agentDir 都是空的 scratchDir；内置工具的 cwd 由 createAgentSession({cwd}) 决定，与这里无关。
export async function createRestrictedResourceLoader(opts: {
  scratchDir: string;
  contextFiles: ContextFile[];
  extensionFactories: ((pi: ExtensionAPI) => void)[];
}): Promise<{ loader: ResourceLoader; settingsManager: SettingsManager; loadedContextFiles(): RunSnapshot["contextFiles"] }> {
  const label = (f: ContextFile) => `/${f.repo}/${f.path}`;
  const labels = opts.contextFiles.map(label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`duplicate context file label: ${dup}`);
  // 会话必须用这同一份：createAgentSession 只读自己拿到的 settingsManager，不传会回退到默认的 projectTrusted=true
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd: opts.scratchDir,
    agentDir: opts.scratchDir,
    settingsManager,
    // noContextFiles 与 projectTrusted:false/resolveProjectTrust 是纵深防御：agentsFilesOverride 本就替换发现结果，reload 的 resolveProjectTrust 本就强制不信任
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "", // 非 nullish 才会跳过 SYSTEM.md 发现（agentDir 级不需要信任）
    appendSystemPrompt: [], // 同理，跳过 APPEND_SYSTEM.md 发现
    agentsFilesOverride: () => ({ agentsFiles: opts.contextFiles.map((f) => ({ path: label(f), content: f.content })) }),
    extensionFactories: opts.extensionFactories,
  });
  await loader.reload({ resolveProjectTrust: async () => false });

  return {
    loader,
    settingsManager,
    // 回读 pi 实际持有的规则；映射不回输入文件就抛错，不编造条目
    loadedContextFiles: () =>
      loader.getAgentsFiles().agentsFiles.map(({ path, content }) => {
        const src = opts.contextFiles.find((f) => label(f) === path);
        if (!src) throw new Error(`pi holds a context file not supplied by the caller: ${path}`);
        return { repo: src.repo, path: src.path, sourceCommit: src.sourceCommit, sha256: createHash("sha256").update(content).digest("hex") };
      }),
  };
}

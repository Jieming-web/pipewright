import { createHash } from "node:crypto";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { ContextFile, RunSnapshot } from "@forgepilot/engine-protocol";

// 0A.4 的 locked 组合：pi 只能看到调用方规则和显式平台扩展，不读仓库/祖先/用户目录里的任何资源。
// cwd 与 agentDir 都是空的 scratchDir；内置工具的 cwd 由 createAgentSession({cwd}) 决定，与这里无关。
export async function createRestrictedResourceLoader(opts: {
  scratchDir: string;
  contextFiles: ContextFile[];
  extensionFactories: ((pi: ExtensionAPI) => void)[];
}): Promise<{ loader: ResourceLoader; loadedContextFiles(): RunSnapshot["contextFiles"] }> {
  const label = (f: ContextFile) => `/${f.repo}/${f.path}`;
  const loader = new DefaultResourceLoader({
    cwd: opts.scratchDir,
    agentDir: opts.scratchDir,
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted: false }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: opts.contextFiles.map((f) => ({ path: label(f), content: f.content })) }),
    appendSystemPrompt: [], // 非 undefined 才会跳过 APPEND_SYSTEM.md 发现
    extensionFactories: opts.extensionFactories,
  });
  await loader.reload({ resolveProjectTrust: async () => false });

  return {
    loader,
    // 回读 pi 实际持有的规则；映射不回输入文件就抛错，不编造条目
    loadedContextFiles: () =>
      loader.getAgentsFiles().agentsFiles.map(({ path, content }) => {
        const src = opts.contextFiles.find((f) => label(f) === path);
        if (!src) throw new Error(`pi holds a context file not supplied by the caller: ${path}`);
        return { repo: src.repo, path: src.path, sourceCommit: src.sourceCommit, sha256: createHash("sha256").update(content).digest("hex") };
      }),
  };
}

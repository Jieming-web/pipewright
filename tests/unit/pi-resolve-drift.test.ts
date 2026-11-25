import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { piResolve } from "../../scripts/t1-real-run.js";

// pi 未导出 path-utils，按文件路径导入（做法同 pi-session.test.ts），防 pi 升级后 piResolve 与工具实际的路径解析漂移
describe("piResolve 与 pi resolveToCwd 一致", () => {
  const cwd = "/tmp/work dir";
  const inputs = [
    "a.py", "./a.py", "/abs/a.py", "~", "~/a.py", "@a.py", "@/abs/a.py", "@~/a.py",
    "my file.py", "a b.py", "a　b.py", "a b.py", "../x", "..", ".", "",
    "file:///abs/a.py", pathToFileURL("/abs/with space/é.py").href,
  ];
  it.each(inputs)("%j", async (input) => {
    const pkg = realpathSync(join(import.meta.dirname, "../../packages/engine-runner/node_modules/@earendil-works/pi-coding-agent"));
    const { resolveToCwd } = await import(join(pkg, "dist/core/tools/path-utils.js"));
    expect(piResolve(input, cwd)).toBe(resolveToCwd(input, cwd));
  });
});

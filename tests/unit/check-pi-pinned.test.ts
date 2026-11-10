import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import { checkPiPinned } from "../../scripts/check-pi-pinned.mjs";

const PI = "@earendil-works/pi-coding-agent";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

type Json = Record<string, unknown>;
interface Opts {
  rootPkg?: Json;
  runnerDeps?: Record<string, string>;
  workspaceYaml?: string;
  lockVersion?: string;
  lockSpecifier?: string;
  lockRaw?: string;
  extraFiles?: Record<string, string>;
}

// 在临时目录里搭一个合法工作区，再按用例覆盖。
function fixture(o: Opts = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pi-pin-"));
  dirs.push(root);
  const w = (p: string, c: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  };
  w("package.json", JSON.stringify(o.rootPkg ?? { name: "root", private: true }));
  w("pnpm-workspace.yaml", o.workspaceYaml ?? "packages:\n  - packages/*\n");
  w("packages/engine-protocol/package.json", JSON.stringify({ name: "@forgepilot/engine-protocol" }));
  w(
    "packages/engine-runner/package.json",
    JSON.stringify({ name: "@forgepilot/engine-runner", dependencies: o.runnerDeps ?? { [PI]: "1.5.1" } }),
  );
  const v = o.lockVersion ?? "1.5.1";
  w(
    "pnpm-lock.yaml",
    o.lockRaw ??
      `lockfileVersion: '9.0'\nimporters:\n  packages/engine-runner:\n    dependencies:\n      '${PI}':\n        specifier: ${o.lockSpecifier ?? "1.5.1"}\n        version: ${v}\n`,
  );
  for (const [p, c] of Object.entries(o.extraFiles ?? {})) w(p, c);
  return root;
}

const problems = (o?: Opts) => checkPiPinned(fixture(o)).problems.join("\n");

describe("checkPiPinned", () => {
  it("合法工作区通过", () => {
    expect(checkPiPinned(fixture())).toEqual({ ok: true, problems: [] });
  });

  it.each(["^1.5.1", "~1.5.1", "1.5.x", "latest", ">=1.5.1", "*"])("非确切版本 %s 失败", (spec) => {
    const r = checkPiPinned(fixture({ runnerDeps: { [PI]: spec } }));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain(PI);
  });

  it("确切但不是 1.5.1 的版本失败", () => {
    expect(problems({ runnerDeps: { [PI]: "1.5.0" } })).toContain("1.5.1");
  });

  it.each([
    "git+https://github.com/earendil-works/pi.git",
    "github:earendil-works/pi",
    "file:../pi",
    "link:../pi",
    "npm:other-pkg@1.5.1",
    "https://example.com/pi.tgz",
    "workspace:*",
  ])("替代源 %s 失败", (spec) => {
    expect(checkPiPinned(fixture({ runnerDeps: { [PI]: spec } })).ok).toBe(false);
  });

  it("根 package.json 的 pnpm.patchedDependencies 针对 pi 失败", () => {
    const p = problems({ rootPkg: { name: "r", pnpm: { patchedDependencies: { [`${PI}@1.5.1`]: "patches/pi.patch" } } } });
    expect(p).toContain("patchedDependencies");
  });

  it("pnpm-workspace.yaml 的 patchedDependencies 失败", () => {
    const p = problems({ workspaceYaml: `packages:\n  - packages/*\npatchedDependencies:\n  '${PI}@1.5.1': patches/pi.patch\n` });
    expect(p).toContain("patchedDependencies");
  });

  it("overrides 重定向 pi 失败（根 pnpm.overrides 与 workspace overrides）", () => {
    expect(problems({ rootPkg: { name: "r", pnpm: { overrides: { [PI]: "file:../pi" } } } })).toContain("overrides");
    expect(problems({ rootPkg: { name: "r", overrides: { [PI]: "1.6.0" } } })).toContain("overrides");
    expect(problems({ workspaceYaml: `packages:\n  - packages/*\noverrides:\n  '${PI}': 1.6.0\n` })).toContain("overrides");
  });

  it("锁文件解析版本不符失败", () => {
    expect(problems({ lockVersion: "1.5.0" })).toContain("pnpm-lock.yaml");
  });

  it("锁文件缺失失败", () => {
    const root = fixture();
    rmSync(join(root, "pnpm-lock.yaml"));
    expect(checkPiPinned(root).ok).toBe(false);
  });

  it("报告已知 vendored pi 路径", () => {
    expect(problems({ extraFiles: { "vendor/pi/package.json": JSON.stringify({ name: PI }) } })).toContain("vendor");
  });

  it("锁文件 runner importer 缺 pi 条目失败", () => {
    const p = problems({ lockRaw: "lockfileVersion: '9.0'\nimporters:\n  packages/engine-runner:\n    dependencies: {}\n" });
    expect(p).toContain("pnpm-lock.yaml");
  });

  it("锁文件缺 importers 失败", () => {
    expect(problems({ lockRaw: "lockfileVersion: '9.0'\n" })).toContain("pnpm-lock.yaml");
  });

  it("锁文件 specifier 与确切版本不符失败", () => {
    expect(problems({ lockSpecifier: "^1.5.1" })).toContain("specifier");
  });

  it.each([`npm:${PI}@1.5.0`, `npm:${PI}@1.5.1`])("别名 key 下引用 pi（%s）失败", (spec) => {
    expect(problems({ runnerDeps: { [PI]: "1.5.1", "pi-alt": spec } })).toContain("pi-alt");
  });

  describe("pi 全部子包（@earendil-works/pi-*）", () => {
    const AI = "@earendil-works/pi-ai";
    const lockWith = (pkgKey: string) =>
      `lockfileVersion: '9.0'\nimporters:\n  packages/engine-runner:\n    dependencies:\n      '${PI}':\n        specifier: 1.5.1\n        version: 1.5.1\npackages:\n  '${pkgKey}':\n    resolution: {integrity: x}\n`;

    it("pnpm.patchedDependencies 针对 pi-agent-core 失败", () => {
      const p = problems({ rootPkg: { name: "r", pnpm: { patchedDependencies: { "@earendil-works/pi-agent-core@1.5.1": "patches/x.patch" } } } });
      expect(p).toContain("patchedDependencies");
    });

    it("pnpm.overrides 重定向 pi-ai 失败", () => {
      expect(problems({ rootPkg: { name: "r", pnpm: { overrides: { [AI]: "file:../my-pi-ai" } } } })).toContain("overrides");
    });

    it("锁文件 packages 中 pi-ai 版本不符失败（含 peer 后缀）", () => {
      expect(problems({ lockRaw: lockWith(`${AI}@1.4.0`) })).toContain("1.4.0");
      expect(problems({ lockRaw: lockWith(`${AI}@1.4.0(zod@3.25.76)`) })).toContain("1.4.0");
    });

    it("锁文件 packages 中 pi-ai@1.5.1（带 peer 后缀）通过", () => {
      expect(checkPiPinned(fixture({ lockRaw: lockWith(`${AI}@1.5.1(zod@3.25.76)`) })).ok).toBe(true);
    });

    it("直接依赖 pi-ai：^1.5.1 失败，1.5.1 通过", () => {
      expect(checkPiPinned(fixture({ runnerDeps: { [PI]: "1.5.1", [AI]: "^1.5.1" } })).ok).toBe(false);
      const lock = `lockfileVersion: '9.0'\nimporters:\n  packages/engine-runner:\n    dependencies:\n      '${PI}':\n        specifier: 1.5.1\n        version: 1.5.1\n      '${AI}':\n        specifier: 1.5.1\n        version: 1.5.1\n`;
      expect(checkPiPinned(fixture({ runnerDeps: { [PI]: "1.5.1", [AI]: "1.5.1" }, lockRaw: lock })).ok).toBe(true);
    });

    it("别名 key 引用 pi-ai 失败", () => {
      expect(problems({ runnerDeps: { [PI]: "1.5.1", x: `npm:${AI}@1.5.0` } })).toContain('"x"');
    });

    it("包名以 @earendil-works/pi- 开头的工作区包视为 vendored", () => {
      const p = problems({ extraFiles: { "packages/fake/package.json": JSON.stringify({ name: AI }) } });
      expect(p).toContain("vendored");
    });
  });

  describe("工作区包路径来自 pnpm-workspace.yaml", () => {
    const app = (spec: string) => ({ "apps/console/package.json": JSON.stringify({ name: "console", dependencies: { [PI]: spec } }) });

    it("apps/* 中的包 pi 版本不符失败", () => {
      const r = checkPiPinned(fixture({ workspaceYaml: "packages:\n  - packages/*\n  - apps/*\n", extraFiles: app("^1.0.0") }));
      expect(r.ok).toBe(false);
      expect(r.problems.join("\n")).toContain("apps/console/package.json");
    });

    it("不含 glob 的精确目录被检查", () => {
      const r = checkPiPinned(fixture({ workspaceYaml: "packages:\n  - packages/*\n  - apps/console\n", extraFiles: app("^1.0.0") }));
      expect(r.problems.join("\n")).toContain("apps/console/package.json");
    });

    it.each(["apps/**", "!apps/x", "apps/{a,b}", "a/*/b"])("不支持的模式 %s 报问题（fail closed）", (pat) => {
      expect(problems({ workspaceYaml: `packages:\n  - packages/*\n  - '${pat}'\n` })).toContain(pat);
    });
  });
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrake, makeRepo, modelEntry, readRules, runAll, toolDecision, TOOLS } from "../../scripts/t1-real-run.js";

// 10A2/10A4 调用方拦截：只放行 read 与 grep，且路径须解析软链接后落在本题副本内、已存在（作者 2026-11-24 决定）
let root: string;
let copy: string;
const p = (...s: string[]) => join(root, ...s);
const read = (path: unknown) => toolDecision({ toolName: "read", input: { path } }, copy);
const grep = (path: unknown) => toolDecision({ toolName: "grep", input: { pattern: "x", path } }, copy);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fp-t1u-")));
  copy = p("copy-1");
  mkdirSync(join(copy, "sub"), { recursive: true });
  writeFileSync(join(copy, "a.py"), "x\n");
  writeFileSync(join(copy, "sub/b.py"), "y\n");
  mkdirSync(p("copy-10"));
  writeFileSync(p("copy-10/a.py"), "secret\n");
  writeFileSync(p("outside.txt"), "secret\n");
  symlinkSync(p("outside.txt"), join(copy, "link.py"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.each([["read", read], ["grep", grep]] as const)("toolDecision：%s 路径", (_tool, decide) => {
  it("副本内正常路径放行（相对、@ 前缀、绝对、子目录）", () => {
    for (const path of ["a.py", "@a.py", join(copy, "a.py"), "sub/b.py", "sub/../a.py", "sub", "."]) expect(decide(path), path).toEqual({ decision: "allow" });
  });
  it.each([
    ["副本外绝对路径", () => p("outside.txt")],
    ["../ 跳出", () => "../outside.txt"],
    ["子目录 ../../ 跳出", () => "sub/../../outside.txt"],
    ["副本内软链接指向副本外", () => "link.py"],
    ["前缀相似的兄弟目录（相对）", () => "../copy-10/a.py"],
    ["前缀相似的兄弟目录（绝对）", () => p("copy-10/a.py")],
    ["~ 展开到家目录", () => "~/.bashrc"],
    ["不存在的文件", () => "nope.py"],
  ])("%s → 拒绝，理由说明只能访问副本内路径并写明 read 与 grep", (_, path) => {
    const d = decide(path());
    expect(d.decision).toBe("block");
    expect(d).toHaveProperty("reason", expect.stringContaining("仓库副本内"));
    expect(d).toHaveProperty("reason", expect.stringMatching(/read.*grep/));
  });
  it("家目录本身与父目录也不放行", () => {
    expect(decide("~").decision).toBe("block");
    expect(decide("..").decision).toBe("block");
  });
  it("副本目录本身经软链接给出也能放行其中文件", () => {
    if (!existsSync(p("copy-alias"))) symlinkSync(copy, p("copy-alias"));
    expect(toolDecision({ toolName: _tool, input: { pattern: "x", path: "a.py" } }, p("copy-alias"))).toEqual({ decision: "allow" });
  });
});

describe("toolDecision：输入形状", () => {
  it("read 的 path 缺失或不是字符串 → 拒绝", () => {
    for (const input of [{}, { path: 1 }, null, "a.py"]) expect(toolDecision({ toolName: "read", input }, copy).decision).toBe("block");
  });
  it("grep 只给 pattern（不给 path）时按 pi 默认的 \".\" 即副本根目录处理 → 放行；path 不是字符串 → 拒绝", () => {
    expect(toolDecision({ toolName: "grep", input: { pattern: "x" } }, copy)).toEqual({ decision: "allow" });
    expect(toolDecision({ toolName: "grep", input: { pattern: "x", path: 1 } }, copy).decision).toBe("block");
  });
  // 拿不准就拒绝：不依赖 pi 在拦截之前的参数校验
  it.each(["read", "grep"])("%s 的输入不是普通对象（null、字符串、数组、数字）→ 拒绝", (toolName) => {
    for (const input of [null, undefined, "a.py", ".", ["a.py"], 1]) expect(toolDecision({ toolName, input }, copy).decision, JSON.stringify(input)).toBe("block");
  });
});

describe("toolDecision：其他工具", () => {
  it("工具清单就是 read 与 grep", () => expect(TOOLS).toEqual(["read", "grep"]));
  it.each(["bash", "edit", "write", "find", "ls", "no_such_tool"])("%s → 拒绝，理由由工具清单生成、写明可用 read 和 grep", (toolName) => {
    expect(toolDecision({ toolName, input: { command: "ls", path: "a.py" } }, copy)).toEqual({
      decision: "block",
      reason: `此任务不提供 ${toolName}，可用工具：read、grep`,
    });
  });
});

describe("createBrake：tool.started 与拦截共用计数，按 callId 去重", () => {
  const brake = (max: number) => {
    const exceeded = vi.fn();
    return { b: createBrake(max, exceeded), exceeded };
  };
  it("同一调用先到事件再到拦截：只计一次，拦截时按它的序号判定", () => {
    const { b, exceeded } = brake(1);
    b.onToolStarted("c1");
    expect(b.onIntercept("c1")).toBe(false);
    b.onToolStarted("c2");
    expect(b.onIntercept("c2")).toBe(true);
    expect(exceeded).toHaveBeenCalledTimes(1);
  });
  it("拦截先到、事件后到：拦截时计数已更新，越限的那次被判越限，不等事件", () => {
    const { b, exceeded } = brake(1);
    expect(b.onIntercept("c1")).toBe(false);
    b.onToolStarted("c1");
    expect(exceeded).not.toHaveBeenCalled();
    expect(b.onIntercept("c2")).toBe(true);
    expect(exceeded).toHaveBeenCalledTimes(1);
    b.onToolStarted("c2");
    expect(exceeded).toHaveBeenCalledTimes(1); // 只通知一次
  });
  it("只有事件（未声明工具）：越限时通知", () => {
    const { b, exceeded } = brake(2);
    for (const id of ["u1", "u2"]) b.onToolStarted(id);
    expect(exceeded).not.toHaveBeenCalled();
    b.onToolStarted("u3");
    expect(exceeded).toHaveBeenCalledTimes(1);
  });
});

describe("规则来源", () => {
  it("AGENTS.md 取自副本的 main 引用，而不是工作区", async () => {
    const sample = p("sample");
    mkdirSync(sample);
    writeFileSync(join(sample, "m.py"), "pass\n");
    writeFileSync(join(sample, "AGENTS.md"), "MAIN-RULES\n");
    const gitDir = p("git");
    const { files, baseCommit } = makeRepo(sample, gitDir, p("work"));
    expect(files).toEqual(["AGENTS.md", "m.py"]);
    writeFileSync(join(gitDir, "AGENTS.md"), "WORKTREE-RULES\n");
    expect(await readRules(gitDir)).toEqual([{ repo: "sample", path: "AGENTS.md", content: "MAIN-RULES\n", sourceCommit: baseCommit }]);
  });
  it("runner 工作目录是导出的纯文件：与提交内容一致，没有 .git 目录或文件", () => {
    const work = p("work");
    expect(readdirSync(work).sort()).toEqual(["AGENTS.md", "m.py"]);
    expect(existsSync(join(work, ".git"))).toBe(false);
  });
});

describe("运行条件：模型配置条目", () => {
  const config = {
    providers: {
      a: { baseUrl: "u", api: "openai-completions", apiKey: "$DASHSCOPE_API_KEY", headers: { "x-k": "secret-h" }, models: [{ id: "m1", maxTokens: 1, headers: { "x-m": "secret-model-h" } }, { id: "m2" }] },
      b: { baseUrl: "u", apiKey: "sk-literal-secret", models: [{ id: "m1" }] },
    },
  };
  it("只取所选模型；apiKey 为 $环境变量名 时保留，provider 与模型条目的 headers 都不进报告", () => {
    const e = modelEntry(config, { provider: "a", id: "m1" });
    expect(e).toEqual({
      provider: { baseUrl: "u", api: "openai-completions", apiKey: "$DASHSCOPE_API_KEY" },
      model: { id: "m1", maxTokens: 1 },
    });
    expect(JSON.stringify(e)).not.toMatch(/secret/);
  });
  it("模型条目里的字面 apiKey 同样不写入报告", () => {
    const e = modelEntry({ providers: { a: { models: [{ id: "m1", apiKey: "sk-model-literal" }] } } }, { provider: "a", id: "m1" });
    expect(e.model).toEqual({ id: "m1", apiKey: "<omitted>" });
  });
  it("samplingParamsByThinkingLevel 或 modelOverrides 中有所选模型：报告不支持，直接报错", () => {
    const byLevel = { providers: { a: { models: [{ id: "m1", samplingParamsByThinkingLevel: { off: { temperature: 0 } } }] } } };
    const override = { providers: { a: { models: [{ id: "m1" }], modelOverrides: { m1: { maxTokens: 2 } } } } };
    expect(() => modelEntry(byLevel, { provider: "a", id: "m1" })).toThrow(/samplingParamsByThinkingLevel/);
    expect(() => modelEntry(override, { provider: "a", id: "m1" })).toThrow(/modelOverrides/);
    // 别的模型的 override 不影响，也不进报告
    const other = { providers: { a: { models: [{ id: "m1" }], modelOverrides: { m9: { headers: { k: "secret-o" } } } } } };
    expect(JSON.stringify(modelEntry(other, { provider: "a", id: "m1" }))).not.toMatch(/secret|m9/);
  });
  it("runAll 在跑题前就因不支持的配置失败", async () => {
    writeFileSync(p("bad-models.json"), JSON.stringify({ providers: { a: { models: [{ id: "m1", samplingParamsByThinkingLevel: {} }] } } }));
    await expect(runAll({ modelsPath: p("bad-models.json"), model: { provider: "a", id: "m1" }, recordDir: p("bad-records") })).rejects.toThrow(/T1 报告不支持/);
  });
  it("apiKey 为字面值时不写入报告", () => {
    const e = modelEntry(config, { provider: "b", id: "m1" });
    expect(e.provider).toEqual({ baseUrl: "u", apiKey: "<omitted>" });
    expect(JSON.stringify(e)).not.toContain("sk-literal-secret");
  });
  it("配置里没有所选模型：条目为 null", () => {
    expect(modelEntry(config, { provider: "a", id: "nope" })).toEqual({ provider: null, model: null });
    expect(modelEntry(config, { provider: "zz", id: "m1" })).toEqual({ provider: null, model: null });
  });
});

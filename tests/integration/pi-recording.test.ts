import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recordPiFixture } from "../../scripts/record-pi-fixtures.js";

const out = mkdtempSync(join(tmpdir(), "fp-rec-test-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const FIXTURES = join(import.meta.dirname, "../fixtures/pi-events");
const FILES = { text: "text-only", tool: "tool-call-then-text", retry: "retry", "retry-drop": "retry-drop" } as const;
type Scenario = keyof typeof FILES;

function load(path: string): any[] {
  const raw = readFileSync(path, "utf8");
  // 脱敏：不得含本机临时目录、家目录或真实时间戳
  expect(raw).not.toContain(tmpdir());
  expect(raw).not.toContain(homedir());
  expect(raw).not.toMatch(/"timestamp":[1-9]/);
  return raw.trimEnd().split("\n").map((l) => JSON.parse(l));
}

const isText = (e: any) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta";
const text = (es: any[]) => es.filter(isText).map((e) => e.assistantMessageEvent.delta).join("");

/** 与结束判定相关的事件骨架；连续的文本增量合并为一个 "text"。 */
function skeleton(es: any[]): string[] {
  const s: string[] = [];
  for (const e of es) {
    const l = isText(e) ? "text"
      : e.type === "message_end" && e.message.stopReason === "error" ? "message_end:error"
      : e.type === "agent_end" ? `agent_end:${e.willRetry}`
      : e.type === "auto_retry_start" ? "auto_retry_start"
      : e.type === "auto_retry_end" ? `auto_retry_end:${e.success}`
      : e.type === "tool_execution_start" || e.type === "tool_execution_end" ? e.type
      : e.type === "agent_settled" ? `agent_settled:${e.aborted}`
      : null;
    if (l && !(l === "text" && s.at(-1) === "text")) s.push(l);
  }
  return s;
}

const checks: Record<Scenario, (es: any[]) => void> = {
  text(es) {
    expect(skeleton(es)).toEqual(["text", "agent_end:false", "agent_settled:false"]);
    expect(text(es)).toBe("Hello, world");
  },
  tool(es) {
    expect(skeleton(es)).toEqual(["tool_execution_start", "tool_execution_end", "text", "agent_end:false", "agent_settled:false"]);
    expect(es.find((e) => e.type === "tool_execution_start")).toMatchObject({ toolName: "read", args: { path: "hello.txt" } });
    const end = es.find((e) => e.type === "tool_execution_end");
    expect(end).toMatchObject({ toolName: "read", isError: false });
    expect(end.result.content[0].text).toBe("hello from fixture\n");
    expect(text(es)).toBe("The file says hello.");
  },
  retry(es) {
    // 0B.2 retry-ok：中间 agent_end{willRetry:true} 之后仍有事件，agent_settled 才是最终信号
    expect(skeleton(es)).toEqual([
      "message_end:error", "agent_end:true", "auto_retry_start", "text", "auto_retry_end:true", "agent_end:false", "agent_settled:false",
    ]);
    expect(es.find((e) => e.type === "auto_retry_start")).toMatchObject({ attempt: 1, delayMs: 20 });
    expect(text(es)).toBe("recovered");
  },
  "retry-drop"(es) {
    // 0B.2 stream-drop：失败尝试已发出的增量不撤回，重试后从头再流一遍
    expect(skeleton(es)).toEqual([
      "text", "message_end:error", "agent_end:true", "auto_retry_start", "text", "auto_retry_end:true", "agent_end:false", "agent_settled:false",
    ]);
    expect(es.find((e) => e.type === "message_end" && e.message.stopReason === "error").message.errorMessage).toMatch(/^terminated/);
    const firstEnd = es.findIndex((e) => e.type === "agent_end");
    expect(text(es.slice(0, firstEnd))).toBe("partial-");
    expect(text(es)).toBe("partial-recovered");
    const last = es.findLast((e) => e.type === "agent_end").messages.at(-1);
    expect(last.content).toEqual([{ type: "text", text: "recovered" }]);
  },
};

describe.each(Object.keys(FILES) as Scenario[])("pi 事件样本：%s", (scenario) => {
  it("现场经真实 pi 录制（假服务无 errors，请求数等于脚本轮数）", async () => {
    const path = join(out, `${scenario}.jsonl`);
    await recordPiFixture(scenario, path); // 内部在 errors 非空或请求数不符时抛错
    checks[scenario](load(path));
  });

  it("仓库中的样本满足同样的断言", () => {
    checks[scenario](load(join(FIXTURES, `${FILES[scenario]}.jsonl`)));
  });
});

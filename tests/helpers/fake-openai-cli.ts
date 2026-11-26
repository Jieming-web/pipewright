// 假模型服务的命令行外壳，给 Python 评测测试（以及容器里的 runner）用。
// 用法：node --import tsx tests/helpers/fake-openai-cli.ts <turns.json> [--host 0.0.0.0] [--requests-out <file>]
// stdout 只打印一行 FAKE_LISTENING <baseUrl>；收到 SIGTERM/SIGINT 时把收到的请求体（JSON 数组）写到 --requests-out，关闭后退出。
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { startFakeOpenAIServer, type ScriptedTurn } from "./fake-openai-server.js";

const { values, positionals } = parseArgs({ options: { host: { type: "string" }, "requests-out": { type: "string" } }, allowPositionals: true });
if (positionals.length !== 1) {
  console.error("usage: fake-openai-cli <turns.json> [--host 0.0.0.0] [--requests-out <file>]");
  process.exit(2);
}
const turns = JSON.parse(readFileSync(positionals[0]!, "utf8")) as ScriptedTurn[];
const server = await startFakeOpenAIServer(turns, values.host);
process.stdout.write(`FAKE_LISTENING ${server.baseUrl}\n`);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => {
  if (values["requests-out"]) writeFileSync(values["requests-out"], JSON.stringify(server.requests));
  void server.close().then(() => process.exit(0));
});

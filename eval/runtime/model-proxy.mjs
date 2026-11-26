// 评测模型代理（T2 计划 Task 7，D1）：任务容器只接 internal 网络，模型请求经本代理转发，API key 只在代理进程里。
//
// 用法：node model-proxy.mjs
// 环境变量：
//   FP_PROXY_ROUTES  JSON：{"<route>": {"base": "https://…/v1", "keyEnv": "DASHSCOPE_API_KEY", "model": "<固定模型 ID>",
//                    "params": {"temperature": 1.0, "top_p": 0.95}}}（params 可选，转发时覆盖请求体里的这两个字段：
//                    pi 1.5.1 不发 top_p，见 T2 计划 Task 7）
//   FP_PROXY_PORT    监听端口，默认 8080（0 为随机端口，测试用）
// 只放行 POST /<route>/chat/completions，其余 404。改写 model，删除联网搜索类参数与非 function 工具，
// 丢弃客户端的 authorization 改用路由的 key；响应按流原样回传，不缓冲。
// stdout 每个请求一行 JSON 日志（不含请求内容与 key）；stderr 只写启动信息与启动错误。
// 无第三方依赖：在 node:24-slim 容器里直接运行。
import { createServer } from "node:http";

const PARAM_FIELDS = ["temperature", "top_p"];
const SEARCH_FIELDS = ["enable_search", "search_options", "web_search"];
const SAMPLING_FIELDS = [
  "temperature", "top_p", "top_k", "min_p", "max_tokens", "max_completion_tokens", "presence_penalty",
  "frequency_penalty", "repetition_penalty", "seed", "enable_thinking", "thinking_budget", "reasoning_effort",
];
// 逐跳头与 fetch 已解压后失效的头，不回传给客户端
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PATH_RE = /^\/([^/]+)\/chat\/completions$/;

function fail(message) {
  process.stderr.write(`model-proxy: ${message}\n`);
  process.exit(2);
}

function loadRoutes() {
  let routes;
  try {
    routes = JSON.parse(process.env.FP_PROXY_ROUTES ?? "");
  } catch {
    fail("FP_PROXY_ROUTES is not valid JSON");
  }
  if (!routes || typeof routes !== "object" || Array.isArray(routes) || Object.keys(routes).length === 0) {
    fail("FP_PROXY_ROUTES must be a non-empty object");
  }
  const out = new Map();
  for (const [name, r] of Object.entries(routes)) {
    if (!r || typeof r.base !== "string" || typeof r.keyEnv !== "string" || typeof r.model !== "string") {
      fail(`route ${name}: base, keyEnv and model must be strings`);
    }
    const params = r.params ?? {};
    if (typeof params !== "object" || Array.isArray(params) || Object.keys(params).some((k) => !PARAM_FIELDS.includes(k))) {
      fail(`route ${name}: params must be an object with only ${PARAM_FIELDS.join(", ")}`);
    }
    const key = process.env[r.keyEnv];
    if (!key) fail(`route ${name}: environment variable ${r.keyEnv} is not set`);
    out.set(name, { url: `${r.base.replace(/\/+$/, "")}/chat/completions`, model: r.model, params, key });
  }
  return out;
}

const routes = loadRoutes();

const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

function sendJson(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error("too large"), { status: 413 }));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 改写请求体：固定 model，用路由的 params 覆盖采样参数，删联网搜索参数，只保留 function 工具（没有剩余时删掉 tools） */
function rewrite(body, model, params) {
  const out = { ...body, ...params, model };
  for (const f of SEARCH_FIELDS) delete out[f];
  if (Array.isArray(out.tools)) {
    const tools = out.tools.filter((t) => t && t.type === "function");
    if (tools.length) out.tools = tools;
    else delete out.tools;
  }
  return out;
}

async function handle(req, res) {
  const path = new URL(req.url ?? "/", "http://proxy").pathname;
  const name = PATH_RE.exec(path)?.[1];
  const route = name !== undefined ? routes.get(name) : undefined;
  const entry = { route: route ? name : null, status: 0 };

  if (!route || req.method !== "POST") {
    req.resume();
    sendJson(res, 404, "not found");
    return log({ ...entry, status: 404 });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    const status = e?.status ?? 400;
    sendJson(res, status, status === 413 ? "request body too large" : "request body must be a JSON object");
    return log({ ...entry, status });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, "request body must be a JSON object");
    return log({ ...entry, status: 400 });
  }

  const forwarded = rewrite(body, route.model, route.params);
  entry.fields = Object.keys(body).sort();
  entry.sampling = Object.fromEntries(SAMPLING_FIELDS.filter((f) => f in forwarded).map((f) => [f, forwarded[f]]));

  // 客户端断开（取消任务）时中止上游请求，避免继续生成与计费
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });

  let upstream;
  try {
    upstream = await fetch(route.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: req.headers.accept ?? "*/*",
        authorization: `Bearer ${route.key}`,
      },
      body: JSON.stringify(forwarded),
      redirect: "manual", // 只转发到配置的上游：3xx 原样回给客户端，不把请求体发到 Location 指向的主机
      signal: ac.signal,
    });
  } catch {
    if (ac.signal.aborted) return log({ ...entry, status: 499 });
    sendJson(res, 502, "upstream unreachable");
    return log({ ...entry, status: 502 });
  }

  const headers = {};
  upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE_HEADERS.has(k)) headers[k] = v; });
  res.writeHead(upstream.status, headers);
  res.flushHeaders();
  log({ ...entry, status: upstream.status });

  try {
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch {
    res.destroy(); // 上游中途断开或已被中止：断开客户端，让它看到不完整的流
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, "proxy error");
    else res.destroy();
  });
});

server.listen(Number(process.env.FP_PROXY_PORT ?? 8080), "0.0.0.0", () => {
  process.stderr.write(`model-proxy listening on ${server.address().port}\n`);
});

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));

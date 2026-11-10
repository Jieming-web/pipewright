// 校验 pi 以未修改的确切版本使用。注意：本脚本不能独自证明 S3（只查已知路径，
// 改名的源码拷贝由收尾代码审查补充）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const PI_PREFIX = "@earendil-works/pi-"; // 约定：所有 pi-* 包都保持未修改
const PI_VERSION = "1.5.1"; // shortcut: assumes all pi packages release in lockstep at one version; switch to a per-package map if they diverge.
const VENDORED = ["vendor/pi", "vendor/pi-mono", "third_party/pi", "external/pi", "pi", "packages/pi", "packages/pi-coding-agent"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readYaml = (p) => (existsSync(p) ? (parse(readFileSync(p, "utf8")) ?? {}) : {});
const hasPi = (obj) => Object.keys(obj ?? {}).some((k) => k.includes(PI_PREFIX));
const GLOB = /[*?{}[\]!()]/;

export function checkPiPinned(rootDir) {
  const problems = [];
  const ws = readYaml(join(rootDir, "pnpm-workspace.yaml"));
  const dirs = new Set(["."]);
  for (const pat of ws.packages ?? []) {
    const m = /^(.+)\/\*$/.exec(pat);
    if (m && !GLOB.test(m[1])) {
      const base = join(rootDir, m[1]);
      if (existsSync(base)) for (const d of readdirSync(base)) if (existsSync(join(base, d, "package.json"))) dirs.add(`${m[1]}/${d}`);
    } else if (!GLOB.test(pat)) {
      dirs.add(pat.replace(/\/$/, ""));
    } else {
      problems.push(`pnpm-workspace.yaml: 不支持的 packages 模式 "${pat}"，无法确认其中不含被改动的 pi`);
    }
  }
  const manifests = [...dirs]
    .filter((d) => existsSync(join(rootDir, d, "package.json")))
    .map((d) => [d === "." ? "package.json" : `${d}/package.json`, join(rootDir, d, "package.json"), d]);

  const declaring = []; // 声明了 pi 的 [label, relDir]，锁文件必须逐一对上
  for (const [label, path, relDir] of manifests) {
    const pkg = readJson(path);
    if (pkg.name?.startsWith(PI_PREFIX)) problems.push(`${label}: 工作区内包名为 ${pkg.name}，疑似 vendored 拷贝`);
    for (const f of DEP_FIELDS) {
      for (const [k, v] of Object.entries(pkg[f] ?? {})) {
        if (!k.startsWith(PI_PREFIX)) {
          if (String(v).includes(PI_PREFIX)) problems.push(`${label}: ${f} 中 "${k}" 以别名引用 pi 包`);
        } else {
          if (v !== PI_VERSION) problems.push(`${label}: ${f} 中 ${k} 必须是确切版本 ${PI_VERSION}，实际为 "${v}"`);
          if (f !== "peerDependencies") declaring.push([label, relDir, k]);
        }
      }
    }
    if (hasPi(pkg.pnpm?.patchedDependencies)) problems.push(`${label}: pnpm.patchedDependencies 不得包含 pi`);
    if (hasPi(pkg.pnpm?.overrides) || hasPi(pkg.overrides)) problems.push(`${label}: overrides 不得重定向 pi`);
  }

  if (hasPi(ws.patchedDependencies)) problems.push("pnpm-workspace.yaml: patchedDependencies 不得包含 pi");
  if (hasPi(ws.overrides)) problems.push("pnpm-workspace.yaml: overrides 不得重定向 pi");

  const lockPath = join(rootDir, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    problems.push("pnpm-lock.yaml 缺失");
  } else {
    const lock = readYaml(lockPath);
    if (hasPi(lock.patchedDependencies)) problems.push("pnpm-lock.yaml: patchedDependencies 含 pi");
    if (hasPi(lock.overrides)) problems.push("pnpm-lock.yaml: overrides 含 pi");
    const importers = lock.importers ?? {};
    for (const [label, relDir, name] of declaring) {
      const e = ["dependencies", "devDependencies", "optionalDependencies"].map((f) => importers[relDir]?.[f]?.[name]).find(Boolean);
      if (!e) {
        problems.push(`pnpm-lock.yaml: importer ${relDir} 缺少 ${name} 条目（${label} 已声明）`);
        continue;
      }
      if (e.specifier !== PI_VERSION) problems.push(`pnpm-lock.yaml: importer ${relDir} 的 ${name} specifier 为 "${e.specifier}"，必须是 ${PI_VERSION}`);
      const resolved = String(e.version).replace(/\(.*$/, "");
      if (resolved !== PI_VERSION) problems.push(`pnpm-lock.yaml: importer ${relDir} 解析到 ${name}@${resolved}，必须是 ${PI_VERSION}`);
    }
    for (const sec of ["packages", "snapshots"]) {
      for (const key of Object.keys(lock[sec] ?? {})) {
        const m = key.startsWith(PI_PREFIX) ? /^(.+?)@([^@(]+)/.exec(key) : null;
        if (m && m[2] !== PI_VERSION) problems.push(`pnpm-lock.yaml: ${sec} 中 ${m[1]} 解析到 ${m[2]}，必须是 ${PI_VERSION}`);
      }
    }
  }

  for (const v of VENDORED) {
    if (existsSync(join(rootDir, v))) problems.push(`发现疑似 vendored pi 路径: ${v}`);
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { ok, problems } = checkPiPinned(resolve(import.meta.dirname, ".."));
  if (!ok) {
    console.error(problems.map((p) => `- ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`pi ${PI_VERSION} 版本锁定检查通过`);
}

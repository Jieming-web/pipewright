// 校验 pi 以未修改的确切版本使用。注意：本脚本不能独自证明 S3（只查已知路径，
// 改名的源码拷贝由收尾代码审查补充）。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const PI = "@earendil-works/pi-coding-agent";
const PI_VERSION = "1.5.1";
const VENDORED = ["vendor/pi", "vendor/pi-mono", "third_party/pi", "external/pi", "pi", "packages/pi", "packages/pi-coding-agent"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readYaml = (p) => (existsSync(p) ? (parse(readFileSync(p, "utf8")) ?? {}) : {});
const hasPi = (obj) => Object.keys(obj ?? {}).some((k) => k.includes(PI));

export function checkPiPinned(rootDir) {
  const problems = [];
  const manifests = [["package.json", join(rootDir, "package.json")]];
  const pkgsDir = join(rootDir, "packages");
  if (existsSync(pkgsDir)) {
    for (const d of readdirSync(pkgsDir)) {
      const p = join(pkgsDir, d, "package.json");
      if (existsSync(p)) manifests.push([`packages/${d}/package.json`, p]);
    }
  }

  for (const [label, path] of manifests) {
    const pkg = readJson(path);
    if (pkg.name === PI) problems.push(`${label}: 工作区内包名为 ${PI}，疑似 vendored 拷贝`);
    for (const f of DEP_FIELDS) {
      const spec = pkg[f]?.[PI];
      if (spec !== undefined && spec !== PI_VERSION) {
        problems.push(`${label}: ${f} 中 ${PI} 必须是确切版本 ${PI_VERSION}，实际为 "${spec}"`);
      }
    }
    if (hasPi(pkg.pnpm?.patchedDependencies)) problems.push(`${label}: pnpm.patchedDependencies 不得包含 pi`);
    if (hasPi(pkg.pnpm?.overrides) || hasPi(pkg.overrides)) problems.push(`${label}: overrides 不得重定向 pi`);
  }

  const ws = readYaml(join(rootDir, "pnpm-workspace.yaml"));
  if (hasPi(ws.patchedDependencies)) problems.push("pnpm-workspace.yaml: patchedDependencies 不得包含 pi");
  if (hasPi(ws.overrides)) problems.push("pnpm-workspace.yaml: overrides 不得重定向 pi");

  const lockPath = join(rootDir, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    problems.push("pnpm-lock.yaml 缺失");
  } else {
    const lock = readYaml(lockPath);
    if (hasPi(lock.patchedDependencies)) problems.push("pnpm-lock.yaml: patchedDependencies 含 pi");
    if (hasPi(lock.overrides)) problems.push("pnpm-lock.yaml: overrides 含 pi");
    for (const [imp, data] of Object.entries(lock.importers ?? {})) {
      for (const f of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const e = data?.[f]?.[PI];
        if (!e) continue;
        const resolved = String(e.version).replace(/\(.*$/, "");
        if (resolved !== PI_VERSION) {
          problems.push(`pnpm-lock.yaml: importer ${imp} 解析到 ${PI}@${resolved}，必须是 ${PI_VERSION}`);
        }
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

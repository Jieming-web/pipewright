import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContextFileSchema, type ContextFile } from "@forgepilot/engine-protocol";

const run = promisify(execFile);
const MAX = 16 * 1024 * 1024;
export const MAX_RULE_FILE_BYTES = 256 * 1024;
// 继承的 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等会让 git 读到别的仓库
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface GitContextSource {
  repo: string;
  repoDir: string;
  /** 建议用全限定引用如 "refs/heads/main"（或 commit sha）；裸名 "main" 可能与 tag 歧义 */
  baseRef: string;
  paths: string[];
}

async function git(repo: string, repoDir: string, args: string[]): Promise<Buffer> {
  try {
    // --literal-pathspecs: paths are file names, never globs/magic
    // --no-replace-objects: a refs/replace/* in repoDir must not swap the base-ref blob/commit (flag, not env: GIT_* is stripped)
    const { stdout } = await run("git", ["--literal-pathspecs", "--no-replace-objects", "-C", repoDir, ...args], {
      encoding: "buffer",
      maxBuffer: MAX,
      env: gitEnv(),
    });
    return stdout;
  } catch (e) {
    throw new Error(`[${repo}] git ${args[0]} failed: ${(e as Error).message}`);
  }
}

export async function readGitContextFiles(sources: GitContextSource[]): Promise<ContextFile[]> {
  const repos = new Set<string>();
  for (const s of sources) {
    if (!ContextFileSchema.shape.repo.safeParse(s.repo).success) throw new Error(`[${s.repo}] illegal repo id`);
    if (repos.has(s.repo)) throw new Error(`[${s.repo}] duplicate repo id`);
    repos.add(s.repo);
    const paths = new Set<string>();
    for (const p of s.paths) {
      if (!ContextFileSchema.shape.path.safeParse(p).success) throw new Error(`[${s.repo}] illegal path: ${JSON.stringify(p)}`);
      if (paths.has(p)) throw new Error(`[${s.repo}] duplicate path: ${p}`);
      paths.add(p);
    }
    if (s.baseRef.startsWith("-") || s.baseRef.trim() === "") throw new Error(`[${s.repo}] illegal baseRef: ${JSON.stringify(s.baseRef)}`);
  }

  const out: ContextFile[] = [];
  for (const s of sources) {
    // sequential on purpose: few files, deterministic order
    let sha: string;
    try {
      sha = (await git(s.repo, s.repoDir, ["rev-parse", "--verify", "--end-of-options", `${s.baseRef}^{commit}`])).toString("utf8").trim();
    } catch (e) {
      throw new Error(`[${s.repo}] cannot resolve baseRef ${s.baseRef}: ${(e as Error).message}`);
    }
    for (const path of s.paths) {
      // ls-tree on the resolved SHA: empty output = absent from that tree; non-zero exit = real failure
      const entry = (await git(s.repo, s.repoDir, ["ls-tree", "-z", "-l", sha, "--", path])).toString("utf8");
      // ls-tree 不跟随软链接，经软链接目录的路径在树中不存在，按缺失省略
      if (entry === "") continue;
      const m = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t/.exec(entry);
      if (!m || m[2] !== "blob" || m[1] === "120000") throw new Error(`[${s.repo}] ${path} is not a regular file at ${sha}`);
      const size = Number(m[4]);
      if (size > MAX_RULE_FILE_BYTES) throw new Error(`[${s.repo}] ${path} is ${size} bytes, over the ${MAX_RULE_FILE_BYTES} byte limit`);
      const raw = await git(s.repo, s.repoDir, ["cat-file", "blob", m[3]!]);
      let content: string;
      try {
        content = utf8.decode(raw);
      } catch {
        throw new Error(`[${s.repo}] ${path} is not valid UTF-8`);
      }
      out.push(ContextFileSchema.parse({ repo: s.repo, path, content, sourceCommit: sha }));
    }
  }
  return out;
}

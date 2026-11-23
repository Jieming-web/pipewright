import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContextFileSchema, type ContextFile } from "@forgepilot/engine-protocol";

const run = promisify(execFile);
const MAX = 16 * 1024 * 1024;

export interface GitContextSource {
  repo: string;
  repoDir: string;
  baseRef: string;
  paths: string[];
}

async function git(repo: string, repoDir: string, args: string[]): Promise<Buffer> {
  try {
    // --literal-pathspecs: paths are file names, never globs/magic
    const { stdout } = await run("git", ["--literal-pathspecs", "-C", repoDir, ...args], {
      encoding: "buffer",
      maxBuffer: MAX,
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
      const entry = (await git(s.repo, s.repoDir, ["ls-tree", "-z", sha, "--", path])).toString("utf8");
      if (entry === "") continue;
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
      if (!m || m[2] !== "blob" || m[1] === "120000") throw new Error(`[${s.repo}] ${path} is not a regular file at ${sha}`);
      const content = (await git(s.repo, s.repoDir, ["cat-file", "blob", m[3]!])).toString("utf8");
      out.push(ContextFileSchema.parse({ repo: s.repo, path, content, sourceCommit: sha }));
    }
  }
  return out;
}

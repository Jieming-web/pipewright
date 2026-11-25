import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { piResolve } from "../../scripts/t1-real-run.js";
import { importPiInternal } from "../helpers/pi-internal.js";

// 参照 resolveToCwd 而非 resolveReadPath：read 的 NFD/弯引号等回退只对不存在的路径生效，而拦截已拒绝不存在的路径
const { resolveToCwd } = await importPiInternal("dist/core/tools/path-utils.js");

describe("piResolve 与 pi resolveToCwd 一致", () => {
  const cwd = "/tmp/work dir";
  // 组 a：逐个覆盖 piResolve 的分支（Unicode 空白替换、@ 前缀、~、~/、file://、最终 resolve），@~/a.py 验证处理顺序
  const branchCases = [
    "a\u00A0b.py", "a\u2000b\u2009b\u200Ab.py", "a\u202Fb\u205Fb.py", "a\u3000b.py",
    "@a.py", "@/abs/a.py", "~", "~/a.py", "@~/a.py", "file:///abs/a.py", "a.py",
  ];
  // 组 b：pi 将来可能自行改变行为的路径形态，防 pi 升级后 resolveToCwd 变了而 piResolve 不知道
  const shapeCases = ["./a.py", "../x", "..", ".", "", "/abs/a.py", "my file.py", pathToFileURL("/abs/with space/é.py").href];

  it.each([...branchCases, ...shapeCases])("%j", (input) => {
    expect(piResolve(input, cwd)).toBe(resolveToCwd(input, cwd));
  });
});

import { realpathSync } from "node:fs";
import { join } from "node:path";

// pi 未导出内部模块，按文件路径导入，供防漂移测试比对
const PI_PKG = realpathSync(join(import.meta.dirname, "../../packages/engine-runner/node_modules/@earendil-works/pi-coding-agent"));
export const importPiInternal = (rel: string) => import(join(PI_PKG, rel));

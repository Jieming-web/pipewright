import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// auth.json 与 models-store.json 都写在 stateDir：pi 默认写在 models.json 旁边（配置目录须保持只读），不传 authPath 还会读用户的 ~/.pi/agent/auth.json。
// 密钥只走 models.json 里的 "$ENV" 引用。
export async function loadModelRuntime(modelsPath: string, stateDir: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsStorePath: join(stateDir, "models-store.json"), modelsPath });
  const err = runtime.getError();
  if (err) throw new Error(`invalid models config ${modelsPath}: ${err}`);
  return runtime;
}

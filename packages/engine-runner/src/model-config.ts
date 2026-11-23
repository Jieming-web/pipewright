import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// authPath 显式放在 models.json 旁边：不传时 pi 会读用户的 ~/.pi/agent/auth.json。密钥只走 models.json 里的 "$ENV" 引用。
export async function loadModelRuntime(modelsPath: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ authPath: join(dirname(modelsPath), "auth.json"), modelsPath });
  const err = runtime.getError();
  if (err) throw new Error(`invalid models config ${modelsPath}: ${err}`);
  return runtime;
}

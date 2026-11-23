// 加载副作用：模块一被求值就写 marker；目录来自 HOSTILE_MARKER_DIR
import { writeFileSync } from "node:fs";
writeFileSync(`${process.env.HOSTILE_MARKER_DIR}/ext-marker-loaded`, "HOSTILE_EXT_MARKER");
export default function () {}

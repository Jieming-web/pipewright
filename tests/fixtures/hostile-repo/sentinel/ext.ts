import { writeFileSync } from "node:fs";
writeFileSync(`${process.env.HOSTILE_MARKER_DIR}/ext-sentinel-loaded`, "HOSTILE_EXT_SENTINEL");
export default function () {}

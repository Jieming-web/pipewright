#!/usr/bin/env bash
# 构建评测运行包（T2 计划 Task 6）：只读挂载到 SWE-bench 实例容器的 /fp。
#
# 用法：scripts/build-eval-bundle.sh <linux-x64|linux-arm64>
# 产出：eval/.cache/bundle-<arch>/（node/、bin/{rg,fd,fp-entry,fp-env}、app/{runner,client}/、VERSION）
# 环境变量（测试用）：FP_DOWNLOAD_DIR 覆盖下载缓存目录（默认 eval/.cache/downloads），
#                     FP_BUNDLE_OUT 覆盖产出目录。
#
# 校验值来源（与官方发布值比对后写死，2026-11-25）：
#   node：https://nodejs.org/dist/v24.15.0/SHASUMS256.txt
#   rg：  https://github.com/BurntSushi/ripgrep/releases/download/16.0.0/<文件名>.sha256
#   fd：  项目未发布校验文件；取 GitHub release API 附件的 digest 字段（作者 2026-11-25 决定）
#         https://api.github.com/repos/sharkdp/fd/releases/tags/v10.5.2
set -euo pipefail

ARCH="${1:-}"
NODE_VER=24.15.0
RG_VER=16.0.0
FD_VER=10.5.2

case "$ARCH" in
  linux-x64)
    NODE_PKG="node-v$NODE_VER-linux-x64.tar.xz"
    NODE_SHA=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
    RG_PKG="ripgrep-$RG_VER-x86_64-unknown-linux-gnu.tar.gz"
    RG_SHA=165451eaf35f977c0bd6cff1fb93e4fcce0ebd87e90a4b5e976507baf50f4a03
    FD_PKG="fd-v$FD_VER-x86_64-unknown-linux-gnu.tar.gz"
    FD_SHA=985e24041e9ef6e9a38e9e088743405dde23d7220aa96740f091862167d9ff28
    ;;
  linux-arm64)
    NODE_PKG="node-v$NODE_VER-linux-arm64.tar.xz"
    NODE_SHA=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0
    RG_PKG="ripgrep-$RG_VER-aarch64-unknown-linux-gnu.tar.gz"
    RG_SHA=0b0bddcfaf42be1f3c56bf929d70defd1a2d96f2577aecbd7029a3734ddb4740
    FD_PKG="fd-v$FD_VER-aarch64-unknown-linux-gnu.tar.gz"
    FD_SHA=4b144f38bd7352cd4c95020b58e8e575476e60edcdf1dc5e0733e3d01efba6dd
    ;;
  *)
    echo "usage: $0 <linux-x64|linux-arm64>" >&2
    exit 2
    ;;
esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DL="${FP_DOWNLOAD_DIR:-$REPO/eval/.cache/downloads}"
OUT="${FP_BUNDLE_OUT:-$REPO/eval/.cache/bundle-$ARCH}"
mkdir -p "$DL" "$(dirname "$OUT")"

# 下载到缓存（已存在则复用），sha256 不符时失败退出，不删除缓存文件以便排查
fetch() {
  local url="$1" file="$2" sha="$3"
  if [ ! -f "$DL/$file" ]; then
    curl -fsSL --retry 3 -o "$DL/$file.part" "$url"
    mv "$DL/$file.part" "$DL/$file"
  fi
  local got
  got="$(sha256sum "$DL/$file" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "build-eval-bundle: sha256 mismatch for $file: expected $sha, got $got" >&2
    exit 1
  fi
}

fetch "https://nodejs.org/dist/v$NODE_VER/$NODE_PKG" "$NODE_PKG" "$NODE_SHA"
fetch "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VER/$RG_PKG" "$RG_PKG" "$RG_SHA"
fetch "https://github.com/sharkdp/fd/releases/download/v$FD_VER/$FD_PKG" "$FD_PKG" "$FD_SHA"

# 在临时目录组装，成功后再替换产出目录，失败时不留半成品
STAGE="$(mktemp -d "${OUT%/*}/.bundle-$ARCH.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/node" "$STAGE/bin" "$STAGE/app"
tar -xJf "$DL/$NODE_PKG" -C "$STAGE/node" --strip-components=1
# 指定成员路径（不用 --wildcards）：GNU tar 与 macOS bsdtar 都支持
tar -xzf "$DL/$RG_PKG" -C "$STAGE/bin" --strip-components=1 "${RG_PKG%.tar.gz}/rg"
tar -xzf "$DL/$FD_PKG" -C "$STAGE/bin" --strip-components=1 "${FD_PKG%.tar.gz}/fd"
install -m 0755 "$REPO/eval/runtime/fp-entry.sh" "$STAGE/bin/fp-entry"
install -m 0644 "$REPO/eval/runtime/fp-env.sh" "$STAGE/bin/fp-env"

cd "$REPO"
pnpm -r build >/dev/null
pnpm --filter @forgepilot/engine-runner deploy --legacy --prod "$STAGE/app/runner" >/dev/null
pnpm --filter @forgepilot/engine-client deploy --legacy --prod "$STAGE/app/client" >/dev/null

COMMIT="$(git rev-parse HEAD)"
git diff --quiet HEAD -- && [ -z "$(git ls-files --others --exclude-standard)" ] || COMMIT="$COMMIT-dirty"
PI_VER="$(node -p 'require("./packages/engine-runner/node_modules/@earendil-works/pi-coding-agent/package.json").version')"
echo "$COMMIT pi@$PI_VER node@$NODE_VER" > "$STAGE/VERSION"

rm -rf "$OUT"
mv "$STAGE" "$OUT"
trap - EXIT
echo "bundle: $OUT ($(cat "$OUT/VERSION"))"

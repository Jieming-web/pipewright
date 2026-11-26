#!/bin/bash
# 评测运行包启动脚本（T2 计划 Task 6）：docker exec -i <容器> /fp/bin/fp-entry <runner 参数…>
# 激活 testbed 并设置 PATH 后，exec stdio 桥；桥启动 runner，stdin/stdout 一行一条协议消息（engine.md 传输：stdio 桥）。
# shellcheck disable=SC1091
. /fp/bin/fp-env
exec node /fp/app/client/dist/stdio-bridge.js --runner /fp/app/runner/dist/main.js -- "$@"

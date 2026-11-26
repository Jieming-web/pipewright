# 评测运行包的环境设置（T2 计划 Task 6），由 fp-entry source；测试也 source 它来检查同一环境。
# 存在 conda 时激活 testbed（失败退出 3），再把运行包的工具放到 PATH 最前。
# pi 的 bash 工具子 shell 会继承这里的环境变量。
if [ -f /opt/miniconda3/bin/activate ]; then
  # shellcheck disable=SC1091
  if ! { source /opt/miniconda3/bin/activate && conda activate testbed; }; then
    echo "fp-entry: conda activate testbed failed" >&2
    exit 3
  fi
fi
export PATH="/fp/bin:/fp/node/bin:$PATH"

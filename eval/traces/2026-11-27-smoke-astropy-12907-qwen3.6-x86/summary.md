# 评测汇总：smoke-v1

- 状态：**complete**
- 成功率：100.0%（resolved 1 / 分母 1；共 1 次运行（题 × 重复），无法测量 0 次，占 0.0%）
- 各次重复成功率：100.0%；均值 100.0%，样本标准差 —
- 按题 bootstrap 95% 区间（10000 次，种子 0）：[100.0%, 100.0%]
- 模型：qwen3.6-35b-a3b；配置 hash：`b20c5698d622136a0f2a92a1e6f842b07fda44e6e78a2c010144dadf31a7e94e`；任务集 sha256：`7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`；平台：linux-x64

| 每次运行（分母内） | 均值 / 中位数 |
|---|---|
| token | 398707.0 / 398707.0 |
| 轮数（模型请求数） | 29.0 / 29.0 |
| 耗时（秒） | 79.4 / 79.4 |

每次运行 token = input + cacheRead + output（reasoning 已含在 output 里）。

## 结果计数

- resolved：1

## 花费

- 实际：0.7732 元（1 次尝试，含重试）；预计：0.86 元（假设来源：smoke-2026-11-26 实测 ×2（单样本：194578 输入 + 6439 输出，18 轮））
- 口径：input+cacheRead+cacheWrite 按输入价、output 按输出价（reasoning 已含在 output 里，不重复计）；缓存不打折

## 无法测量（从分母排除）

无

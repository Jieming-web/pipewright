# 评测汇总：smoke-v1

- 状态：**complete**
- 成功率：100.0%（resolved 1 / 分母 1；共 1 个实例，无法测量 0 个，占 0.0%）
- 模型：qwen3.6-35b-a3b；配置 hash：`b6b48eb970e315fe7386e74edd8e41487fdefd04049fc1ad7bf40d0e95894463`；任务集 sha256：`7462bbd305be13ca354baaf65ab65bb95c9431ca7f0a6991155413ebc4336ecd`；平台：linux-arm64

| 每次运行（分母内） | 均值 / 中位数 |
|---|---|
| token | 201017.0 / 201017.0 |
| 轮数（模型请求数） | 18.0 / 18.0 |
| 耗时（秒） | 65.6 / 65.6 |

每次运行 token = input + cacheRead + output（reasoning 已含在 output 里）。

## 结果计数

- resolved：1

## 花费

- 实际：0.4198 元（1 次尝试，含重试）；预计：3.02 元（假设来源：未校准的保守估计（约 40 次请求、平均 3.7 万输入 token）；T2-14 冒烟后按 p90 校准）
- 口径：input+cacheRead+cacheWrite 按输入价、output 按输出价（reasoning 已含在 output 里，不重复计）；缓存不打折

## 无法测量（从分母排除）

无

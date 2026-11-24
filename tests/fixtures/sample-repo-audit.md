# sample-repo 人工完整性核对记录

逐模块通读后，列出五个目标函数在每个模块中的所有出现位置。格式固定，测试会解析：
`- 目标 | 路径:行 | 类别 | 说明`。类别：DEF 定义、IMPORT 导入、CALL 对目标的调用（计入答案）、NOT 同名但不是目标的调用或提及（不计入答案）。
别名调用在说明中写 `alias 别名`。每个调用都在单行内；没有动态分派、getattr 或装饰器。

## audit.py
- audit_event | audit.py:4 | DEF | 目标定义

## billing.py
- normalize_name | billing.py:1 | IMPORT | from text_utils
- compute_total | billing.py:4 | DEF | 目标定义
- normalize_name | billing.py:9 | CALL | invoice_label 调用 text_utils.normalize_name
- compute_total | billing.py:13 | CALL | invoice_total 调用同模块 compute_total

## cli.py
- normalize_name | cli.py:2 | IMPORT | from text_utils
- load_config | cli.py:6 | CALL | 经 `import config as cfg` 的 cfg.load_config
- normalize_name | cli.py:7 | CALL | 调用 text_utils.normalize_name

## config.py
- load_config | config.py:4 | DEF | 目标定义

## legacy.py（同名干扰）
- load_config | legacy.py:1 | NOT | 注释提及
- normalize_name | legacy.py:2 | NOT | legacy 自己定义的同名函数，不是 text_utils 的
- send_notice | legacy.py:7 | NOT | Mailer 的同名方法定义
- send_notice | legacy.py:11 | NOT | self.send_notice，调用的是 Mailer 方法
- audit_event | legacy.py:15 | NOT | 字符串提及
- compute_total | legacy.py:15 | NOT | 字符串提及
- normalize_name | legacy.py:16 | NOT | 调用 legacy 本模块自己的 normalize_name

## notify.py
- audit_event | notify.py:1 | IMPORT | from audit
- send_notice | notify.py:4 | DEF | 目标定义
- audit_event | notify.py:5 | CALL | send_notice 内调用 audit_event

## orders.py
- compute_total | orders.py:2 | IMPORT | 导入并别名为 total_of
- send_notice | orders.py:3 | IMPORT | from notify
- compute_total | orders.py:7 | CALL | alias total_of
- send_notice | orders.py:8 | CALL | 调用 notify.send_notice
- audit_event | orders.py:9 | CALL | 经 `import audit` 的 audit.audit_event

## text_utils.py
- normalize_name | text_utils.py:1 | DEF | 目标定义
- normalize_name | text_utils.py:6 | CALL | slugify 内调用

## 汇总（与题集答案一致）
- normalize_name：billing.py:9, cli.py:7, text_utils.py:6
- compute_total：billing.py:13, orders.py:7
- send_notice：orders.py:8
- load_config：cli.py:6
- audit_event：notify.py:5, orders.py:9

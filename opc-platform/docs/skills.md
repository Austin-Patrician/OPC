# 本机技能（SKILL.md）

> 目标：`~/.agents/skills` 里已经装好的技能（docx、pdf、xlsx、officecli…）能被 Agent 用上，
> 但**不把 16 份说明书一次性塞进每次请求**，也不需要"信任"这一步。

---

## 1. 技能和扩展的区别（决定了整个设计）

| | Pi 扩展 | 技能 |
| --- | --- | --- |
| 本体 | 可执行模块（.ts） | Markdown（`SKILL.md` + 可选脚本） |
| 读取会不会执行代码 | **会**，import 即运行 | 不会，只是读文件 |
| 需要信任框 | 需要 | 不需要 |
| 出错代价 | 主进程权限失守 | 提示词多花几个 token |
| 出错可见性 | 加载报错 | 模型读到一段没用的文字 |

所以两条路完全不同：扩展是"扫描 → 列出来 → 用户点信任 → 才 import"，
技能是"扫描 → 直接可用 → 不想用可以关"。

## 2. 发现规则

```
<home>/.agents/skills/<name>/SKILL.md     全局
<project>/.agents/skills/<name>/SKILL.md  项目（同名时覆盖全局）
```

一层深，跳过隐藏目录和 `node_modules`。**同名时项目赢**，和 Pi / [CC] 的优先级一致。

`SKILL.md` 的头部是 YAML frontmatter，只用其中几个键：

```yaml
---
name: pdf
description: Comprehensive PDF manipulation toolkit ...
license: Proprietary
---
# 正文……
```

解析器是手写的（`skills/scanner.ts`），只认 `key: value`、`key: >` / `|` 折叠块和成对引号，
其余忽略。理由：一份写坏的 frontmatter 不应该让技能消失——最坏情况是少一行描述。
没有 frontmatter 时，名字取目录名，描述取正文第一句（跳过标题和代码块）。

自带的文件（`scripts/`、`references/`、schemas…）会被列出来，上限 200 个、4 层深，
只记相对路径，不读内容。

## 3. 怎么进到运行时：一个扩展，两段式披露

技能在注册表里表现为**一个**扩展 `opc.skills`：

```
opc.skills
  ├─ section('skills')      系统提示里的一段：每个技能一行「name — 描述」
  └─ tool read_skill        模型认为相关时，读全文
```

这就是 Anthropic Agent Skills 的 progressive disclosure，代价从"每请求全量"降到"每请求一行"：

| 阶段 | 成本 | 什么时候付 |
| --- | --- | --- |
| 广告（section） | 每个技能约 90–150 tokens | 每次请求 |
| 全文（`read_skill`） | 3k–20k tokens | 模型判断相关时，一次 |

16 个技能全开约 1.4k tokens / 次请求（页面上直接显示这个估算，因为"免费"和
"每次多 1.4k tokens"是两种承诺）。关掉一个技能，它同时从 section 和工具结果里消失。

正文超过 24k 字符会被截断，并告诉模型完整文件在哪、可以用 `read` 工具接着读。

## 4. 脚本还是要过沙箱

技能里写"运行 `scripts/fill.py`"，模型就会调 `bash` —— 和它调任何命令一样，
走 `opc.sandbox` 的路径/命令策略，受 `opc.limits` 的调用次数限制，全程出现在会话记录里。
**技能不能绕过任何一道闸门**，这是"读文件安全"之外必须守住的一半。

## 5. 开关与持久化

| 状态 | 位置 | 说明 |
| --- | --- | --- |
| 关掉的技能 | `<userData>/pi-skills.json` 的 `disabled` | 存**关**而不是存**开** |
| 扫描结果 | 内存，2s TTL | `list()` 强制重扫，开关后立即看到磁盘现状 |
| 启用集合 | 每次 registry 构建时读 `enabled()` | 关掉后下一次任务即生效 |

存 `disabled` 而不是 `enabled` 是刻意的：新装的技能默认就是可用的，
不需要用户回来再点一次。反过来，卸载掉的技能会从 `disabled` 里被清掉，
所以重新装回来时不会莫名其妙还是关着的。

开关变化后同样调用 `invalidateAllHarnesses()`——section 是 registry 的一部分，
不清缓存就要重启才生效。

## 6. 已知边界

- **描述只截 300 字符**。有些技能的描述本身就长，截断会丢掉"什么时候用它"的关键词；
  真遇到召回不准，再考虑让模型先 `read_skill` 一次列表。
- **没有自动触发**。模型靠描述判断相关性；名字太泛（如 `frontend-skill`）时判断会不稳。
- **不解析 `allowed-tools` / `license` 之外的字段**，也不校验正文结构。
- **`superpowers` 是个符号链接**（junction），指向 `~/.codex/superpowers/skills`。目标目录不存在时
  它直接不出现——本机就是这种情况，所以 16 个目录里只列出 15 个技能。链接目标修好后下次刷新自动出现。

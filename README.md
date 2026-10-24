# Nibblearn

![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

将视频字幕整理为带有来源的学习笔记，支持自定义学习目标和文件保存位置。

当前提供 **pi 扩展**，使用宿主已配置的模型。核心与宿主适配层分离，**DSH 适配尚在规划中**。

[安装](#安装) · [快速开始](#快速开始) · [命令](#命令) · [数据与隐私](#数据与隐私) · [源码结构](#源码结构)

## 功能

- **学习计划**：配置学习目标、已有基础、内容范围、笔记形式和输出语言，支持多个计划。
- **字幕获取**：读取 Bilibili 字幕，通过链接中的 `?p=2` 指定分 P；也可导入 SRT、VTT 或字幕 JSON。
- **来源引用**：知识点保留字幕起止时间与证据原文，视频来源可跳转回看。
- **参考材料**：接受主动添加的 Markdown 或纯文本，将补充说明与视频内容分开标注。
- **草稿审核**：生成后先预览、编辑并确认保存；已有文件内容不同时新增版本，不覆盖原文件。
- **请求保护**：限制请求频率，遇到平台限流暂停访问；失败任务需人工确认重试。

## 安装

需要 **Node.js 24+** 和已配置模型的 **pi 1.4.x**。

```sh
pi install git:github.com/hhhhuichen/nibblearn
```

安装后重新启动 pi，或在当前会话执行 `/reload`。

<details>
<summary>从本地源码运行</summary>

```sh
git clone https://github.com/hhhhuichen/nibblearn.git
cd nibblearn
npm ci --ignore-scripts
npm start
```

也可以在仓库根目录临时加载扩展，不添加安装记录：

```sh
pi -e ./extensions/index.ts
```

</details>

## 快速开始

### 创建学习计划

```text
/learn setup
```

按对话框填写目标和保存目录。整理时，字幕与学习计划会发送到当前模型服务，并消耗对应额度。

### 提供视频或字幕

处理 Bilibili 视频前，先通过本地对话框配置登录态：

```text
/learn auth
/learn video <视频链接或BV号>
```

支持带 `?p=2` 的完整链接和纯 BV 号；b23 短链接需先在浏览器展开。登录凭据的配置方式见[数据与隐私](#数据与隐私)。

也可以直接导入已有字幕，无需登录 Bilibili：

```text
/learn import <字幕文件路径>
```

支持 SRT、VTT 和字幕 JSON。路径包含空格时加引号。

### 审核并保存

```text
/learn review
```

选择草稿，预览或编辑后确认保存。文件会写入计划指定目录下的 `<计划ID>/` 子目录。

## 命令

| 命令 | 用途 |
| :--- | :--- |
| `/learn` | 查看帮助 |
| `/learn setup` | 创建学习计划 |
| `/learn plans` · `/learn use <ID>` | 选择计划 |
| `/learn config` | 编辑当前计划，生成新版本 |
| `/learn auth` | 在本地配置 Bilibili 登录态 |
| `/learn video <链接或BV号>` | 获取字幕并生成草稿 |
| `/learn import <文件路径>` | 导入 SRT、VTT 或字幕 JSON |
| `/learn reference <文件路径>` | 添加 `.md` 或 `.txt` 参考材料 |
| `/learn status` | 查看计划、草稿和未完成任务 |
| `/learn review [ID]` · `/learn save [ID]` | 预览、编辑并确认保存 |
| `/learn retry <任务ID>` | 确认后重新整理失败或中断的任务 |
| `/learn resume` | 人工处理登录问题后解除账号暂停，不清除平台等待时间 |
| `/learn cancel` | 取消正在执行的任务 |

Agent 可调用 `learn_video`、`learn_generate` 和 `learn_status`。配置登录态、修改保存目录和确认发布需要用户交互。若已关闭这些工具，需先重新启用。

## 数据与隐私

- **整理请求的模型输入**：字幕、学习目标和主动提供的参考文本。不包含账号 Cookie、成品保存路径或整个 pi 会话历史。
- **账号凭据**：仅在本机保存，不加密。POSIX 使用 `0600` / `0700` 权限，Windows 依赖文件 ACL。
- **凭据输入**：在浏览器开发者工具的 Cookies 面板读取 `SESSDATA`，再填写 `/learn auth` 的本地编辑器。`bili_jct` 和 `buvid3` 可选。`SESSDATA` 是 HttpOnly，不能通过 `document.cookie` 获取。
- **输入安全**：编辑器不提供密码遮罩。不要在聊天、录屏或不可信 RPC 客户端中输入 Cookie。扩展不会主动读取浏览器 Cookie 库或其他工具的凭据。
- **文件保存**：重复保存相同内容会复用已有文件；内容不同时新增 `--v2` 等版本。修改输出目录不会搬迁或删除旧文件。

<details>
<summary>工作目录与环境变量</summary>

默认数据目录为 `~/.pi/agent/video-learn/`。设置 `PI_CODING_AGENT_DIR` 后，目录位于该路径下的 `video-learn/`。

```text
video-learn/
├── settings.json
├── plans/          学习计划与参考材料
├── secrets/        本地登录凭据
├── materials/      带时间戳的字幕
├── drafts/         笔记草稿
├── jobs/           任务状态、缓存索引与用量记录
├── locks/
└── traffic/        请求预算与退避状态
```

可在启动宿主前设置 `NIBBLEARN_HOME`，指定独立工作目录。路径优先级为：

```text
NIBBLEARN_HOME → PI_LEARN_HOME（兼容变量）→ 默认目录
```

不会自动迁移旧数据或重写已有笔记。凭据、字幕、草稿和运行记录不应提交到代码仓库。

</details>

Nibblearn **不是安全沙箱**。Pi 与扩展使用当前系统用户的权限，其他已启用工具不受本插件的保存检查约束。需要更强隔离时，应使用独立系统用户、容器或虚拟机。

## 当前限制

- 仅依据字幕整理，尚未提供画面分析、音频转写、自动选片、定时学习或跨视频主题综合。
- 不浏览网页或独立核查事实。模型补充标注为“未检索核验”，参考文本标注为“用户提供，未独立核验”。
- 时间戳索引经过存在性检查，但引用不代表语义正确、字幕完整或观点已证实。
- 不执行评论、私信、点赞或投稿等平台写操作。遇到验证码、限流或访问限制时停止，不尝试绕过。

<details>
<summary>材料大小、模型用量与重试</summary>

- 字幕最多 `120,000` 字符，每个任务最多 `12` 次分段模型请求，单次输出最多 `4,500 tokens`，同时受所选模型限制。
- 材料或上下文超过限制会明确报错，不静默截断。长材料按段整理，当前没有额外的跨段综合请求。
- 每份参考文本最多 `8,000` 字符；计划最多包含 `10` 份参考材料，合计最多 `16,000` 字符。
- 嵌套模型不提供工具，不执行材料中的命令，不联网查资料。
- 成功调用的嵌套模型用量计入 pi 会话。失败时若服务返回用量，会保存在任务记录；服务没有返回用量时无法确定实际计费。
- 复用草稿不会再次调用整理模型，但宿主调度工具的普通对话请求仍可能消耗额度。
- 重试从头整理材料，保留历史用量记录；不会自动发布文件。

</details>

生成笔记需要核对原始材料，不应作为个性化医疗、法律或投资建议。

## 源码结构

| 目录 | 内容 |
| :--- | :--- |
| `src/` | 学习计划、材料整理、任务与文件存储 |
| `extensions/` | pi 宿主适配 |
| `vendor/` | 固定版本的上游代码与许可证 |

## 许可证与来源

[MIT](LICENSE)。Bilibili 接入参考并部分复用 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，固定提交和修改清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

代码许可证不代表平台对自动化访问的授权。请遵守平台规则、内容访问权限及相关版权要求。

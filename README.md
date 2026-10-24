# Nibblearn · 啃啃学

**让 AI 啃资料，把知识留下来。**

一个不绑定特定 Agent 宿主的学习资料整理项目，采用独立核心与宿主适配层。**当前版本已提供 pi 扩展，DSH 适配计划中，尚未实现。** 用户决定学习主题、目标、笔记形式和文件保存位置。第一版从 Bilibili 字幕或用户导入的字幕生成有出处的 Markdown 草稿，预览确认后保存。

不绑定 Rust、技术开发或 Obsidian；不另建模型账号，不自动播放或进行平台互动。

## 当前能力

- 多个独立学习计划，可修改目标、基础、范围、语言、笔记风格和输出目录。
- 使用 **pi 当前选择的模型与认证**，不复制 pi 的模型密钥。
- 读取 Bilibili 字幕，支持链接中的 `?p=2` 指定课程分 P。
- 导入 SRT、VTT、Bilibili 字幕 JSON；没有账号也可以先试完整流程。
- 字幕按完整分段处理，知识点引用程序校验过的字幕索引，保留起止时间及证据原文。
- 可附加用户主动提供的 `.md`/`.txt` 参考材料；与视频内容及未核验模型解释分开标注。
- 生成草稿、人工预览/编辑、确认保存；重复生成复用草稿，人工编辑过的成品不会被覆盖。
- Bilibili 请求节流、跨进程读预算与退避；失败任务需人工确认重试，不由模型反复提交。

**明确没有实现：** 自动搜索推荐、定时学习、画面分析、音频转写、网页检索、独立事实核查、跨视频主题综合，以及其他宿主的适配。没有字幕时明确失败，不根据简介或热评假装理解了视频。

## 环境与安装

- Node.js **24+**。
- `@earendil-works/pi-coding-agent` **1.4.x**，已配置可用模型。
- 第一版不需要 Python、ffmpeg、Obsidian、数据库或单独模型 API key。

本地开发仓库安装依赖后，也可以直接 `npm start` 启动一个加载本插件的 pi。

先用一次性加载，不修改 pi 全局设置：

```sh
pi -e /absolute/path/to/nibblearn/extensions/index.ts
```

Windows 示例（替换为实际路径）：

```powershell
pi -e "D:\projects\nibblearn\extensions\index.ts"
```

仓库上传到 GitHub 后，其他用户可直接安装（将 `YOUR_USERNAME` 替换为你的 GitHub 用户名）：

```sh
pi install git:github.com/YOUR_USERNAME/nibblearn
```

确认需要长期使用后，也可安装本地包：

```sh
pi install /absolute/path/to/nibblearn
```

之后重新启动 pi 或执行 `/reload`。本项目开发时未自动改动你的 pi 全局设置。Pi 包会提供运行时依赖映射；普通 `node` 不负责加载扩展入口，开发测试除外。

## 五分钟试用：先不登录 Bilibili

1. 在已配置模型的 pi 中运行 **`/learn setup`**。
2. 填写任意主题、目标、已有基础和保存目录；确认哪些内容会发送到当前模型服务。
3. 导入仓库自带示例（路径可以带空格，整体加引号）：

```text
/learn import /absolute/path/to/nibblearn/examples/sample.srt
```

4. 扩展会请当前 Agent 调用 `learn_generate`，并在本地保存草稿；它不会写入成品目录。
5. 运行 **`/learn review`**。在编辑器预览或修改，退出编辑器后再次确认保存。
6. 成品位于你选择的目录下的 `<计划ID>/` 子目录，不需要任何笔记软件。

导入示例会实际调用你选择的模型并消耗额度。测试脚本则全部使用模拟模型，不消耗模型额度。

## 使用 Bilibili 视频

### 仅在本地配置登录态

1. 自己在浏览器登录 Bilibili。
2. 打开开发者工具 → Application/应用 → Cookies → Bilibili，查看 `SESSDATA` 的值；它是 HttpOnly，不使用 `document.cookie` 获取。
3. 在 pi 运行 **`/learn auth`**，在扩展的本地编辑器填入 JSON：

```json
{
  "sessdata": "这里只填SESSDATA的值",
  "bili_jct": "可选，只读功能不要求",
  "buvid3": "可选"
}
```

**不要把 Cookie 发到聊天里，也不要让模型通过 read/bash 帮你读取。** 本地编辑器没有密码遮罩；不要在录屏、不可信 RPC 客户端或共享终端中操作。凭据文件不加密：POSIX 使用 0600/0700 权限；Windows 仍依赖当前用户的文件 ACL。扩展不会主动读取已有 `.bili-ai`、浏览器 Cookie 库或 DSH 凭据。

然后处理一个链接：

```text
/learn video https://www.bilibili.com/video/BVxxxxxxxxxx/?p=2
```

请替换为真实 BV 号。也接受纯 BV 号（默认第一分 P）。暂不接受 b23 短链，请先在浏览器展开。仅处理用户可合法访问的内容；遇到平台限制会停止，不绕过验证码或访问限制。

## 命令

| 命令 | 用途 |
|---|---|
| `/learn` | 帮助 |
| `/learn setup` | 新建学习计划 |
| `/learn plans`、`/learn use <ID>` | 切换计划 |
| `/learn config` | 编辑当前计划；修改后进入新版本 |
| `/learn auth` | 本地保存 Bilibili 凭据，不验证上线状态 |
| `/learn video <链接或BV>` | 获取字幕并请求生成草稿 |
| `/learn import <路径>` | 导入字幕并请求生成草稿 |
| `/learn reference <路径>` | 为当前计划添加用户提供的参考文本 |
| `/learn status` | 当前计划、草稿、未完成任务 |
| `/learn review [ID]`、`/learn save [ID]` | 预览/编辑并确认发布 |
| `/learn retry <任务ID>` | 人工确认后重试；从头调用模型，历史用量保留 |
| `/learn resume` | 人工处理登录/验证码后解除账号暂停，不清除平台等待 |
| `/learn cancel` | 取消本扩展正在执行的任务 |

也可以自然语言要求 Agent 调用 `learn_video`、`learn_generate`、`learn_status`。模型不能通过这些工具配置凭据、修改保存目录或确认发布；这些操作只能走用户交互命令。

`/learn video` 与 `/learn import` 将请求排队给当前 Agent，由它调用相应工具。如果主动关闭了这些工具，需先重新启用。首次失败请检查提示，不让 Agent 自动通过普通 write 工具绕开审核。

## 数据与存储

为兼容首版已有的计划与草稿，pi 适配器继续使用原默认工作目录（不会因项目改名而迁移或覆盖数据）：

```text
<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/video-learn/
├── settings.json
├── plans/          用户计划、参考文本和输出目录
├── secrets/        本地Cookie，不进入模型提示词
├── materials/      原始带时间戳字幕
├── drafts/         Markdown草稿及模型用量
├── jobs/           状态、缓存索引、失败与重试记录
├── locks/
└── traffic/
```

可在启动宿主 **之前**用 `NIBBLEARN_HOME` 指定专用目录；旧变量 `PI_LEARN_HOME` 继续兼容。优先级为 `NIBBLEARN_HOME` → `PI_LEARN_HOME` → 上述原默认目录。未来宿主适配器也可显式传入状态目录。不会自动迁移旧数据或重写已有笔记。工作目录的字幕、参考文本和草稿也可能是隐私材料，请自行控制权限与备份。

成品是普通 Markdown，没有应用专用 URI、`[[双链]]`、凭据或开发者机器路径。通常不含原始全文，但保留每个知识点实际引用的字幕。输出目录必须由用户选择；改变目录不会移动或删除已有文件。

保存使用不覆盖目标的独占操作。支持时以同目录硬链接原子发布；不支持时使用独占复制。若已有同名文件内容不同，会新增 `--v2` 等版本；相同内容重复发布返回已有文件。目标子目录若变成符号链接/目录联接会拒绝写入。

## 模型调用与来源可信度

- 只把本次计划、字幕和用户主动提供的参考文本发送给当前模型。不发送保存路径、账号 Cookie 或整个 pi 对话历史。
- 嵌套模型不提供工具，不执行字幕中出现的命令，不联网查资料。
- 工具返回嵌套模型用量，计入 pi 会话；失败时若服务返回用量，会保存在任务记录，未必全部计入宿主工具失败结果。服务未返回用量时无法确定实际计费。
- 复用草稿不再次调用整理模型，但宿主 Agent 为调度工具产生的普通对话请求仍可能消耗额度。
- 字幕最多 120000 字符，每个任务最多 12 次分段模型请求，单次输出上限 4500 tokens。过大就明确拒绝，不静默少读。
- 多段内容逐段整理，第一版没有额外的跨段综合请求。引用索引经过存在性检查，**不代表语义正确、字幕完整或事实已核验**。
- 模型补充统一标注“未检索核验”；用户材料统一标注“用户提供，未独立核验”。关闭模型补充后，拒绝无来源补充。
- 图片、HTML 和指令在材料里只是数据；模型输出中的 Markdown 图片标记和 HTML 不直接启用。

这里不是安全沙箱。Pi 与扩展仍具有当前操作系统用户的权限，其他已启用的 read/bash/write 工具不受本插件边界约束。需要更强隔离时使用专门用户、容器或其他 OS 边界。不要把学习笔记当作个性化医疗、法律或投资建议。

## 开发与验证

```sh
npm install --ignore-scripts
npm run verify
```

验证包括 TypeScript 严格检查、模拟模型/模拟平台网络测试，以及真实 pi 扩展加载器冒烟测试。测试只使用临时目录与虚构凭据，不登录账号或调用真实模型。

架构：`src/` 为核心，`extensions/index.ts` 为当前 pi 适配层，`vendor/` 固定复用上游请求保护与签名代码。项目主体叫 Nibblearn，宿主适配器按需增加，不要求为 DSH 重写核心。没有捆绑 DSH 的互动命令或宿主服务，目前不能直接作为 DSH 插件安装。

## 上传 GitHub

仓库命名为 **`nibblearn`**，显示名称 **Nibblearn · 啃啃学**。手动上传步骤与排除清单见 [GITHUB_UPLOAD.md](GITHUB_UPLOAD.md)。

通过 `npm run export:github -- <新目录>` 可导出不带依赖、Git 历史和运行数据的源码快照。目标目录必须尚不存在；导出时会检查常见凭据标记、个人主目录路径、凭据示例和依赖锁文件地址。此检查不能代替完整安全审计。

仓库提供 GitHub Actions，在 Windows 与 Linux 的 Node.js 24 环境执行 `npm ci --ignore-scripts` 和 `npm run verify`，不需要模型或 Bilibili 密钥。

## 开源来源

MIT。Bilibili 接入参考并部分复用 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，固定提交与修改清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。代码许可不代表平台对自动化访问的授权。
#   n i b b l e a r n  
 
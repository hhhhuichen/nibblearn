# Nibblearn · GitHub 手动上传说明

## 名称与简介

- 仓库名称：**nibblearn**
- 显示名称：**Nibblearn · 啃啃学**
- 项目口号：**让 AI 啃资料，把知识留下来。**
- 建议简介：`Turn video subtitles into goal-driven, source-linked learning notes. Pi supported; DSH planned.`
- 可选 Topics：`pi-extension`、`pi-package`、`bilibili`、`learning`、`markdown`、`typescript`。
- 许可证：MIT；必须保留本项目 LICENSE 和 vendor 中的上游许可证、THIRD_PARTY_NOTICES.md。

这里没有声称名称在所有 npm/GitHub 用户空间中唯一；GitHub 仓库名称在你自己的账号下可用即可。尚未发布 npm 包。

## 浏览器上传

1. 在 GitHub 创建名为 `nibblearn` 的空仓库。Public/Private 按你的需要选择；不要再自动生成 README、许可证或 .gitignore，本目录已经提供。
2. 打开仓库的 **uploading an existing file** 或 **Add file → Upload files**。
3. 上传这份干净目录里的所有文件和子目录，保持相对层级。仓库首页应直接看到 `package.json`、`README.md`、`src/`、`extensions/`，不要再多套一层父目录。
4. 确认 `.github/`、`.gitignore` 和 `.gitattributes` 也已上传。首次提交说明可以填写 `Initial release: Nibblearn v0.1.0`。
5. 将 README 安装命令中的 `YOUR_USERNAME` 改成你的实际 GitHub 用户名。
6. 提交后可在 Actions 页面查看验证结果；私有仓库或禁用 Actions 时，按需开启。CI 不需要填写任何账号密钥。

如果拿到的是 ZIP，请先解压并上传内部源码。**不要只把 ZIP 文件上传到仓库**，否则无法正常浏览源码、运行工作流和逐文件版本控制。

**网页上传不会因为存在 .gitignore 就替你过滤本地文件。** 请只使用导出的干净目录，不要把完整开发目录直接拖进去。

## 已保留

- TypeScript 核心与当前 pi 扩展入口（DSH 适配尚未实现）。
- 自动化测试、加载器测试和源码导出脚本。
- package.json、package-lock.json、tsconfig.json；保留 lock 文件便于复现依赖。
- README、许可证、上游来源说明。
- 空白凭据示例、虚构演示字幕、参考文本。
- 基础 GitHub Actions 工作流。

测试源码中的 `DUMMY`、`NOT_A_REAL_COOKIE`、`LOCAL_FAKE_SECRET` 等是虚构值，不是真实登录态。

## 不应上传

- `node_modules/`、`.git/`、本机编辑器配置和缓存。
- 实际 Cookie、API key、auth.json、credentials.json、.env 或 npm 登录配置；包括 NIBBLEARN_HOME 或兼容旧变量指定目录内的内容。
- 用户学习计划、字幕缓存、生成草稿、笔记成品、运行状态与日志。
- 个人主目录、浏览器数据、DSH/pi 私人设置、调研工作目录。

## 之后如何继续开发

这份目录是导出时的**源码快照**，不会自动随原开发目录更新。长期版本控制建议在首次上传后克隆 GitHub 仓库，以克隆目录作为统一开发目录，避免两份源码分叉。

源码中不包含依赖目录。从 GitHub 克隆后运行：

```sh
npm ci --ignore-scripts
npm run verify
```

也可从原开发目录再次导出到另一个尚不存在的目录：

```sh
npm run export:github -- /path/to/new-clean-folder
```

导出检查仅用于防止常见误传，不是完整安全审计。首次发布前仍建议浏览确认文件清单。

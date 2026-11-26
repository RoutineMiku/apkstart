# 贡献指南

欢迎提交 Issue 和 Pull Request。这个项目的原则是**壳层零依赖、行为可预测**，所以请先读一下下面的约定。

## 开发环境

- Windows 10/11 x64
- Node.js ≥ 20
- `npm install && npm start`

## 提交前自检

```powershell
npm test          # 纯 Node 单元测试 + 引擎链路测试（不需要网络、不需要虚拟机）
```

涉及界面改动时，建议再跑一次冒烟截图确认没有布局塌陷：

```powershell
electron . --smoke test\shot.png
```

## 代码约定

- **壳层不引入第三方运行时依赖**。`src/core/` 下的 ZIP / AXML / ARSC / PNG / ICO 解析都是手写的，
  新增功能时优先考虑「能不能用 Node 内置模块写完」，避免为了小功能拉进一个大包。
- 渲染层是原生 HTML/CSS/JS，不使用前端框架。
- 与安卓侧交互一律走 `src/core/adb.js`，不要在各处直接拼 adb 命令。
- 主进程与渲染进程之间只通过 `preload.js` 暴露的白名单通道通信，保持 `contextIsolation` 开启。
- 注释与 UI 文案使用中文，标识符使用英文。
- 界面多语言：UI 文案**照常写中文**，不用改调用点。词典 `src/i18n/en-US.json` 以中文原文为 key，
  界面显示时自动翻译（见 `src/i18n/index.js`）。新增或改动文案后跑一次
  `npm run i18n`，再按 `npm run i18n -- --missing` 列出的条目补上英文即可；没补的文案在英文界面里会暂时显示中文，不会出错。

## 测试约定

- 拿不到真实 APK 时测试会自动跳过 APK 解析部分；要覆盖这部分，设置环境变量指向任意 APK：

```powershell
$env:APKSTART_TEST_APK="C:\path\to\any.apk"; npm test
```

- 不要在测试里访问外网。需要网络行为的测试请起本地 `http` 服务（参考 `test/engine-test.js`）。

## 提交信息

使用 Conventional Commits 风格，例如：

```
feat(engine): 支持从自定义路径导入 qcow2 磁盘
fix(axml): 修正属性表基址偏移
docs: 补充 WHPX 开启说明
```

## 法律与边界

- 本项目不分发任何安卓系统镜像、QEMU 二进制或 Google 组件，全部由用户本机按需下载。
- 请勿在仓库中提交商业 APK、破解工具或任何侵犯第三方版权的内容。

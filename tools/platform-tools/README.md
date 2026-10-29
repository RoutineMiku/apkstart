# 便携 adb

把 Android platform-tools 解压到本目录（应出现 `adb.exe`），ApkStart 会优先使用它：

```
tools/platform-tools/
└─ adb.exe
```

下载地址：https://developer.android.com/tools/releases/platform-tools

如果本目录为空，ApkStart 会依次尝试：

1. 设置中手动指定的 adb 路径
2. 本目录
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. 常见模拟器自带的 adb（LDPlayer / MuMu / BlueStacks）
5. 系统 PATH

# ApkStart User Manual and Troubleshooting Guide

> Version: v0.6.4 · Platform: Windows 10/11 x64 · Updated: 2026-11-22
>
> ApkStart runs Android apps on Windows: **Android apps install like native Windows programs, show up on your desktop, and open with a double-click.**
> This manual first shows you how to use it, then gives step-by-step fixes organized by symptom. Every step refers to a button or menu that really exists in the app.
>
> This is a translation of the Chinese manual (`USER-MANUAL.md`). If the two differ, the Chinese version is the reference.

---

## Contents

1. [ApkStart in 30 seconds](#1-apkstart-in-30-seconds)
2. [Installing and first launch](#2-installing-and-first-launch)
3. [Everyday use](#3-everyday-use)
4. [Three core concepts (the key to understanding errors)](#4-three-core-concepts-the-key-to-understanding-errors)
5. [Do this first when something goes wrong: check-up and automatic detection](#5-do-this-first-when-something-goes-wrong-check-up-and-automatic-detection)
6. [Solutions to common problems](#6-solutions-to-common-problems)
   - [6.1 "Hardware acceleration not enabled" / slow startup](#6-1-hardware-acceleration-not-enabled-slow-startup)
   - [6.2 Install failed (INSTALL_FAILED_*)](#6-2-install-failed-install_failed_)
   - [6.3 No ARM translation layer / ARM apps won't install or crash](#6-3-no-arm-translation-layer-arm-apps-won-t-install-or-crash)
   - [6.4 adb unauthorized (Allow USB debugging)](#6-4-adb-unauthorized-allow-usb-debugging)
   - [6.5 Nothing happens on double-click / endless spinner / a window with a rotate button](#6-5-nothing-happens-on-double-click-endless-spinner-a-window-with-a-rotate-button)
   - [6.6 Quick reference for other startup problems](#6-6-quick-reference-for-other-startup-problems)
   - [6.7 No sound in apps / sound is very quiet](#6-7-no-sound-in-apps-sound-is-very-quiet)
   - [6.8 Store version won't start / 0xC0000135 (DLL failed to load)](#6-8-store-version-won-t-start-0xc0000135-dll-failed-to-load)
   - [6.9 Apps can't use the microphone / voice calls and recording don't work](#6-9-apps-can-t-use-the-microphone-voice-calls-and-recording-don-t-work)
   - [6.10 Discrete vs. integrated GPU rendering (graphics preference)](#6-10-discrete-vs-integrated-gpu-rendering-graphics-preference)
7. [Command-line reference](#7-command-line-reference)
8. [Data and folders](#8-data-and-folders)
9. [Getting help and reporting problems](#9-getting-help-and-reporting-problems)

---

## 1. ApkStart in 30 seconds

```
Desktop icon (the app's real icon, a .lnk)
      │ double-click
      ▼
ApkStart.exe --launch <package name>
      │ Android runtime not running? → started automatically (Android 14 emulator, bundled or downloaded on first use)
      ▼
Opens the app through the launch entry the system resolves (not the main Activity hard-coded in the APK)
      ▼
Emulator window = app window (own title, own icon, portrait aspect ratio, full screen and centered)
```

**What makes it different**

- 🖱️ **Double-click an .apk to install it**: once the file association is registered in Explorer, double-clicking an APK parses it, installs it and creates a desktop icon.
- 🧩 **One desktop icon per app**: icons are extracted offline from inside the APK; double-clicking the icon takes you straight into the app.
- 🪟 **Each app is its own window**: native rendering, full screen fills the screen height and centers the app, window mode can be dragged and resized, and each app remembers its own size.
- 🔍 **Windows Search finds it**: shortcuts on both the desktop and the Start menu (`Programs\ApkStart\`).
- 📁 **Shared files**: `%USERPROFILE%\ApkStartShared` ↔ `/sdcard/ApkStartShared` inside Android, synced both ways.
- 🪶 **Bundled runtime**: doesn't depend on any emulator you may have installed, such as MuMu, LDPlayer or WSA.

> Note: this is an early-stage project maintained by the author in their spare time. It's open source, free and has no ads. Running into problems is normal, and this manual exists for exactly that.

---

## 2. Installing and first launch

### 2.1 Choose the right version

Both download sources have the same files. Gitee is much faster from mainland China:

- GitHub: `github.com/RoutineMiku/apkstart/releases`
- Gitee: `gitee.com/daily-miku/apkstart/releases` (direct connection in mainland China is much faster)

| Edition | File name | When to choose it |
|---|---|---|
| **Store version** | `ApkStart_<four-part version>_x64.msix` | Installed from the Microsoft Store. Includes the full runtime, needs no internet after installing, and the Store handles updates |
| **Full portable** | `ApkStart-v*-win64-full.zip` (about 830 MB, ~1.3 GB extracted) | You don't want to install anything or wait for downloads: extract and run, the runtime is all in the package |
| **Installer** | `ApkStart-v*-Setup.exe` (about 1.3 GB) | You want desktop/Start menu shortcuts and an uninstall entry |
| **Lightweight portable** | `ApkStart-v*-win64-portable.zip` (96 MiB, ~227 MB extracted) | You just want to try it first; the runtime is downloaded on first launch |

> ⚠️ **Always use the latest version (currently 0.6.4).** Old versions (0.5.x and earlier) either have no bundled runtime and look for / download the 1.5 GB runtime on every start, or use the embedded window by default. That is the typical cause of "very slow, won't open, a window with a rotate button shows up". If you upgraded from an old version, make sure your desktop icons point to the new program folder.

### 2.2 What happens on first launch

1. **(Lightweight version only) Download the runtime**: adb, the Android Emulator and the Android 14 system image. The official sources measure 10+ MB/s, with 8-thread chunked downloads and resume support. The full and Store versions skip this step.
2. **First image extraction**: the xz image is extracted to `%APPDATA%\apkstart\system-images` (about 20 seconds, only once).
3. **First `/data` creation**: ApkStart builds its own encrypted, SELinux-labeled ext4 user data (the official image only contains a 1 MB placeholder).
4. **Automatic boot**: after this, opening an app only takes one `am start`. A cold boot takes about 23 seconds; with a snapshot, about 10 seconds.

> A slow first launch is normal; it's a one-time cost. After that, apps open in seconds.

---

## 3. Everyday use

### 3.1 Installing apps

Pick any of three ways:

- **Double-click an APK file** (register the association first: Settings → System integration → Associate .apk files);
- Choose "Install APK" in the main window;
- Command line: `ApkStart.exe <path\to.apk>`.

Split packages (`.apks` / `.xapk`) are supported (installed automatically with `install-multiple`). Desktop and Start menu shortcuts are created automatically after installing.

### 3.2 Opening apps

Double-click the desktop icon. All apps share the same runtime, so **the second app starts almost instantly**.

### 3.3 Windows and display

| Action | How |
|---|---|
| Switch between full screen and window | `F11` or the tray icon's right-click menu. Full screen only enlarges the window; it doesn't change the aspect ratio |
| Rotate between portrait and landscape | `Ctrl+Alt+R` (global) or the rotate button in the title bar; the app remembers its orientation |
| Auto fullscreen | Settings → Display & windows → Auto fullscreen (works best together with "Force orientation") |
| Force landscape/portrait | Settings → Display & windows → Screen orientation |

> The runtime only restarts the one time the panel orientation and the app's orientation don't match (about 40 seconds; the title bar shows a notice). Apps with the same orientation open in seconds after that.

### 3.4 Keyboard shortcuts

| Key | What it does |
|---|---|
| `F11` | Switch between full screen and window mode |
| `Ctrl+Alt+R` | Rotate the current app between portrait and landscape |
| `Ctrl+R` | Rotate inside the shell window (in native window mode, use `Ctrl+Alt+R`) |

### 3.5 Sharing files (Windows ↔ Android)

`%USERPROFILE%\ApkStartShared` on your PC and `/sdcard/ApkStartShared` inside Android sync both ways within seconds.
Where: Settings → Integration & files → File sharing ("Sync now" or open the folder).

### 3.6 Settings navigation

Since 0.6.0, settings are split into categories, with a search box at the top (type keywords such as "landscape", "memory" or "proxy" to find matches across all categories):

| Category | Main contents |
|---|---|
| General & install | Interface language, runtime & environment, set up everything, start at sign-in, disk usage and cleanup |
| Display & windows | Display mode, auto fullscreen, screen orientation, tablet layout, window hosting |
| Controls & input | Mouse buttons, keyboard mapping |
| Performance & resources | Resource policy, graphics preference (discrete/integrated GPU), microphone, picture quality, data partition, system language, snapshots, prewarm at startup |
| Network & downloads | Update & download source, acceleration mirrors, download threads |
| Diagnostics & repair | PC check-up, drivers/compatibility patches, automatic detection |
| Integration & files | Desktop & apps, file sharing, system integration |
| Updates & about | Software updates, about |
| Labs | Windows native multi-window, multiple apps (experimental), apps kept in background |

> **Interface language**: at the top of General & install, choose Auto (follows Windows), 简体中文 or English. With the English interface, Android itself also defaults to English, the Chinese keyboard isn't installed, and the emulator uses Cloudflare/Google DNS, unless you've set these yourself.

> **Labs · multiple apps (experimental)**: when turned on, opening a new app no longer force-closes the previous one. Several apps can stay in the background, you can switch back at any time, and they stay signed in. Because the Android runtime has only one emulator window, only one app is shown in the foreground at a time; this isn't true side-by-side multi-window. Turning it on uses more memory. It's off by default; if you want stability, you can ignore it.

### 3.7 Online updates

Settings → Updates & about → Check for updates, or right-click the tray icon → Check for updates. The updater tests the sources on the spot and picks the fastest (GitHub / Gitee / mirrors), downloads in parallel chunks, and switches sources automatically on failure. Updating doesn't lose the runtime, installed apps or snapshots.

Newer portable versions support **incremental updates**: each release also publishes a "code manifest" and a small package with only the program code (a few MB, compared with about 100 MB for the full package). If your Electron shell version hasn't changed, the update downloads only this small package, verifies each file and replaces the program code, which takes a few seconds. If the shell version changed, the manifest is missing or any check fails, it automatically falls back to downloading the full package, so an update can't break the program. The Store version is still updated by the Microsoft Store.

> Note: only portable versions installed from GitHub / Gitee through "Check for updates" use incremental updates; Microsoft Store installs use the Store channel. Incremental updates don't affect installed apps, Android data, the runtime or snapshots.

---

## 4. Three core concepts (the key to understanding errors)

Most "weird problems" come down to one of the three things below. A minute spent understanding them makes troubleshooting much easier.

### 4.1 Runtime / system image

ApkStart doesn't emulate an "empty Android". It loads a **complete Android 14 system image** as its base.
0.6.3 has **a single universal image** (Google Play x86_64) that runs both x86 and ARM apps. There are no longer two separate images ("AOSP image / compatibility image") as in older versions.

- Image missing / corrupted / incompatible with old user data → boot fails, gets stuck booting, or keeps restarting.
- User data (`/data`) is a thin differencing layer; the system image is shared once across the whole PC.

### 4.2 Hardware acceleration

For the emulator to run fast, it needs CPU virtualization acceleration. On Windows there are only two options:

| Option | What it is | Needs administrator when | Restart after installing? |
|---|---|---|---|
| **WHPX** | The built-in Windows feature "Windows Hypervisor Platform" (HypervisorPlatform) | Turning the feature on | Yes |
| **AEHD** | Google's own kernel driver | Installing the driver | No |

**It runs without acceleration too** (pure software emulation, TCG), but booting takes minutes and the picture drops frames easily. That's "slow", not "failed to start". ApkStart falls back automatically and retries with up to 4 sets of parameters in the order "rendering backend → acceleration method → memory/cold boot".

> Don't mistake **VirtualMachinePlatform** (used by WSL2) for the acceleration switch. The emulator needs **HypervisorPlatform**. With only the former turned on, `emulator -accel-check` still says it's unavailable.

### 4.3 ARM translation layer

Most Chinese Android apps only ship **native ARM libraries** (arm64-v8a / armeabi-v7a), while the system image is **x86_64**, so a "translation layer" is needed to convert ARM instructions for the x86 CPU. The universal image in 0.6.3 includes the new `ndk_translation` layer, so installing ARM apps usually needs no setup.

- The first time an ARM app shows up, if the translation layer components aren't in place yet, ApkStart automatically fetches the compatibility image, restarts the runtime and retries (see 6.3).
- The old image (API 30) has compatibility problems with the new translation layer (for example ByteDance apps triggering a `DoBadTrampoline` SIGABRT); the Android 14 image fixes this.

---

## 5. Do this first when something goes wrong: check-up and automatic detection

Before going through this manual, let the app check itself. It can fix most problems automatically.

### 5.1 PC check-up · automatic configuration

Where: Settings → Diagnostics & repair → **Start check-up**

- What it checks: whether CPU virtualization (VT-x/SVM) is on, whether Hyper-V / Windows Hypervisor Platform is available, graphics card / video memory / driver, memory, Windows version, `emulator -accel-check`, and the AEHD driver.
- Click "**Apply recommended configuration**" to write safe settings automatically: memory / CPU cores / render resolution / picture quality / forcing software emulation when there's no acceleration. These are saved as a driver profile for this PC and applied automatically from then on.
- Results are graded: `ok` (fine) / `warn` (works, but should be improved) / `bad` (won't run unless fixed). Each item has a color and an explanation.

Only two kinds of things need you to do them yourself:
- **BIOS virtualization**: restart into the BIOS → turn on Intel VT-x / AMD SVM → Enabled (the app can't do this for you).
- **Windows features / acceleration driver**: see 6.1.

### 5.2 Automatic detection (auto debug)

Where: Settings → Diagnostics & repair → "Automatic detection · smart diagnosis"

Every 10 minutes it checks the machine in the background and lists problems by category. Each one can be **fixed in one click** (restart the runtime, clear locks, clear orphan processes, invalidate the snapshot, clean up disk space, reset Android networking…), and it re-checks automatically after fixing:

| Category | Problems covered |
|---|---|
| Runtime | The real cause of the last failed start, stuck boot, leftover lock files, orphan emulator processes, empty snapshots, no hardware acceleration |
| Device connection | adb unauthorized, offline, runtime running but adb can't see the device |
| Storage | Free disk space, data partition configuration not matching reality, shared folder not writable |
| Settings | Screen orientation conflicting with the physical panel, auto fullscreen not working in own-window mode |
| Network/logs | No network inside Android, download sources unreachable, errors in recent logs |

> Two principles: a failed probe is never reported as a problem (if it can't get the status, it says "unknown" rather than guessing), and the same old problem won't keep bothering you.

### 5.3 Export a diagnostic report

Where: Settings → Diagnostics & repair → **Export diagnostic report** (or the button with the same name on the System integration page)

The report is plain text with this PC's configuration, the automatically chosen startup parameters, logs and diagnostic conclusions. Attaching it when you report a problem makes it much faster to pin down.

### 5.4 Built-in manual and automatic guides

Since 0.6.3 this manual is **built into the app**: the "?" button in the main window's title bar and "Open the user manual" in Settings → About both open it directly. You can search, scroll and print / save it as PDF. It opens at the section related to the current problem.

Automatic detection and repair also bring the guide to you:

- When automatic detection finds a problem, the item has a "Guide" button on the right that goes straight to the matching section;
- For hardware acceleration, install failures, the ARM translation layer, adb authorization, no sound and similar problems, **the matching guide opens automatically when an automatic fix fails**, so you don't need to come looking here;
- Each guide opens automatically only once per run, so it won't keep interrupting you.

> Open it manually: the `?` button in the title bar. To stop guides from opening automatically, turn off notifications in the automatic detection settings; guides are still available from the "Guide" button on each item.

---

## 6. Solutions to common problems

### 6.1 "Hardware acceleration not enabled" / slow startup

**Symptoms**: Settings/diagnostics say "No hardware acceleration" or "Hardware acceleration unavailable"; booting takes minutes and the picture drops frames.

**First, be clear**: this usually means "slow", not "won't open". ApkStart has already fallen back to software emulation automatically. You only need acceleration if you want it to be smooth.

**By edition:**

- **Installer / portable versions**: Settings → Diagnostics & repair → PC check-up → find "Hardware acceleration not enabled" → click **Repair**. A UAC prompt appears once and WHPX is turned on automatically; if that doesn't work (Windows doesn't support it, or you clicked No), it installs the AEHD driver instead.
- **Microsoft Store (MSIX) version**: Store apps **can't elevate themselves**, so "Repair" opens the "Turn Windows features on or off" dialog:
  1. Tick **"Windows Hypervisor Platform"** (HypervisorPlatform);
  2. Click OK, then **restart the PC** once.

  You can also run this in an **administrator PowerShell**:

  ```powershell
  dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
  dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  ```

> Two pitfalls: ① don't turn on only VirtualMachinePlatform, that's not the acceleration the emulator needs; ② if VT-x/SVM is off in the BIOS, turn it on there first as described in 5.1, otherwise turning on the Windows feature won't help.
> If your graphics driver is more than 3 years old, update it from the manufacturer's website; ApkStart won't install drivers automatically (the wrong one makes things worse). Some old graphics cards / integrated GPUs need a compatibility patch; see Settings → Diagnostics & repair → Drivers · compatibility patches.

---

### 6.2 Install failed (INSTALL_FAILED_*)

**Symptoms**: an error when installing an app; the message usually starts with "Install failed:" and ends with an `INSTALL_*` error code.

ApkStart translates the raw Android error into a readable explanation. Use the table below:

| Error code | Meaning | What to do |
|---|---|---|
| `INSTALL_FAILED_NO_MATCHING_ABIS` | The app only ships ARM libraries and the current image has no ARM translation layer | **Usually handled automatically**: ApkStart switches to the compatibility image and retries. See [6.3](#6-3-no-arm-translation-layer-arm-apps-won-t-install-or-crash) |
| `INSTALL_FAILED_OLDER_SDK` | The app needs a newer Android version | Needs a newer system image; the current one is Android 14 (API 34), so this rarely happens |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | The APK has no valid signature | The APK is corrupted or not a proper package; get the installer again |
| `INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES` / `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Signature doesn't match the installed version | Uninstall the old version first, then install |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | A newer version is already installed | You can't downgrade over it; install a newer version or uninstall first |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | The runtime is out of disk space | Free up disk space, or move the runtime data folder to a drive with enough space (Settings → System integration) |
| `INSTALL_FAILED_INVALID_APK` | The APK is corrupted/incomplete | The download may not have finished; download it again |
| `INSTALL_FAILED_INVALID_URI` | The APK path contains special or Chinese characters | Move the APK to a path with only English letters and try again |
| `INSTALL_FAILED_ALREADY_EXISTS` | An app with the same name but a different signature exists | Uninstall it first |
| `INSTALL_FAILED_DEPRECATED_SDK_VERSION` | The app targets a very old Android version | **Handled automatically**: ApkStart retries with the official bypass flag |
| `INSTALL_FAILED_TEST_ONLY` | A test-only package | **Handled automatically**: retried with the test-package flag |
| `INSTALL_FAILED_MISSING_SHARED_LIBRARY` | A required device feature/vendor library doesn't exist | The app depends on a specific vendor environment that the emulator can't provide |
| `INSTALL_FAILED_USER_RESTRICTION` | The system is restricting installs | Restart the runtime and try again |
| `INSTALL_FAILED_CONFLICTING_PROVIDER` | Conflicts with an existing app's ContentProvider | Uninstall the conflicting app |
| `INSTALL_FAILED_INTERNAL_ERROR` | Internal system error (usually low space or boot not finished) | Restart the runtime, wait for boot to finish, then try again |

> If you get a raw error that isn't in the table, export a diagnostic report as in 5.3 and send it in.

---

### 6.3 No ARM translation layer / ARM apps won't install or crash

**Symptoms**: installing shows `INSTALL_FAILED_NO_MATCHING_ABIS` with a message like "The app only ships native ARM libraries… the current system image has no ARM translation layer"; or the app installs but crashes as soon as it starts, and the log shows `DoBadTrampoline`, `libndk_translation`, `UnsatisfiedLinkError` or `...so not found`.

**How it works**: 0.6.3 uses **one universal Android 14 image** that supports both x86 and ARM, with the translation layer built in. Older versions needed you to switch images manually; the "Universal compatibility image (managed automatically)" switch is now **only kept for compatibility with old configurations, and normally you don't need to touch it**.

**What ApkStart does automatically:**

1. If installing fails with `NO_MATCHING_ABIS`, it switches to the compatibility image → restarts the runtime → restores the installed apps from their local APK backups → installs again (the log shows "Switching to the compatibility image and restarting the runtime…").
2. If an app crashes on startup and the log clearly points at the ARM translation layer (such as `DoBadTrampoline`), it switches to the Android 14 compatibility image and retries (the log shows "ARM translation layer crash detected, switching to the compatibility image automatically…").

**What you need to do:**

- **Be patient**: switching images restarts the runtime, about 40 seconds to 1 minute each time, and you may see a notice window.
- **Make sure the image is in place**: Settings → General & install → Runtime, check the status of "Universal compatibility image (managed automatically)". If it shows as not downloaded, click "Download compatibility image" (about 1.5 GB), then **restart the runtime** for it to take effect.
- **Still crashing**: a few apps have deeper anti-emulator checks (requiring real sensors, a baseband and so on) and can't run in an emulator. ApkStart shows an explanation for these; it's a limitation, not a fault.

**What if you see a red "Install failed" while the message says "switching to the compatibility image and retrying"?**

This was a display bug in an old version: the image file was on disk, but it reused an old runtime without the translation layer, so the switch-and-retry was skipped and it reported failure straight away, while the message still said "retrying". **You aren't on the latest code; please upgrade to the latest 0.6.4 build** (the version this manual describes has fixed it: before installing it probes the current runtime's real translation capability instead of only checking whether the image file exists; `NO_MATCHING_ABIS` always triggers switch + restart + clearing the old snapshot before reinstalling; and if the second attempt still fails, it tells you so honestly instead of claiming "retrying"). After upgrading, install it again.

> Tested: 红果免费短剧 (com.phoenix.read, arm64-v8a only) installs normally on the Android 14 image with the new translation layer, opens its recommendation feed and plays video. The current runtime's `ro.product.cpu.abilist` = `x86_64,arm64-v8a`, so the translation layer is active.

---

### 6.4 adb unauthorized (Allow USB debugging)

**Symptoms**: diagnostics report "adb unauthorized" or "Android debugging authorization not completed", `adb devices` shows `unauthorized`, and apps never start.

**What to do (in order):**

1. Check whether an emulator window is showing an **"Allow USB debugging?"** dialog. Go to that window, click **Allow**, and tick **"Always allow from this computer"** so it won't ask again.
2. If you can't click it or it never appears: Settings → Runtime → **Reset Android data** and try again (this removes installed apps, but the APK files are kept and reinstalled automatically; the system itself isn't affected).

> ⚠️ **Never delete `%USERPROFILE%\.android\adbkey`.** Testing showed that makes things worse: Android only writes a new public key when the `adb_keys` file doesn't exist. If you switch to a new private key, the old public key stored in the system is still in effect, they don't match, and authorization can never succeed.

> Command-line troubleshooting: ApkStart's adb server runs on its **own port, 5044** (completely separate from your own 5037):
> ```powershell
> $env:ANDROID_ADB_SERVER_PORT = 5044
> adb devices    # should show emulator-5554
> ```
> Don't run `adb connect` on port 5555 manually: the Play image will show "Allow USB debugging" on top of the app, which looks as if the program is broken.

---

### 6.5 Nothing happens on double-click / endless spinner / a window with a rotate button

These problems almost always come down to **the launch entry or window takeover**. Check in this order.

**① Make sure you're running the new version**

- Look at the start of the log `%APPDATA%\ApkStart\logs\app.log`: it should say `start v0.6.4`. If it says `v0.5.x`, your desktop/Start menu icons point to the old version's folder.
- Old versions (0.5.x) have no bundled runtime and use the embedded window by default → "very slow + a shell window with a rotate button". Switch to 0.6.4 and point your shortcuts at the new `ApkStart.exe`.

**② Know how long booting takes**

A cold boot of about 23–48 seconds, and about 50 seconds for a restart after an orientation change, are normal. During this time, clicking the icon seems to do nothing, but it's booting in the background. **Don't click repeatedly**: a second instance can take over the emulator, and when the first instance exits its cleanup may shut the emulator down too, causing a failure (0.6.3 added `owner.pid` protection, but waiting in the queue still looks like nothing is happening). Click once and wait for it to come up.

**③ Native window takeover failed → falls back to the embedded window with a rotate button**

If the log shows `attach failed` or `emu:0`, the window agent didn't find the emulator window and the program fell back to embedded mode (the shell window with a title bar and rotate button you're seeing).
- This tends to happen when launched from a directory junction or a non-standard path; 0.6.3 makes the agent resolve the real path before matching. If it still happens, send the log in.

**④ Reset Android data (last resort)**

Settings → General & install → **Reset Android data** (asks for confirmation). This removes installed apps and their data but keeps the system itself; the app list is kept and apps reinstall automatically when you open them. Use it for data partition corruption, `/data` failing to mount, and the various "won't open" problems these cause.

---

### 6.6 Quick reference for other startup problems

ApkStart **already handles most of these runtime errors automatically**. The table explains what it does and what else you can do. If the automatic fix doesn't help, export a diagnostic report as in 5.3.

| Diagnostic title | Handled automatically | What else you can do |
|---|---|---|
| Hardware acceleration unavailable | Falls back to software emulation | Turn on acceleration as in 6.1 |
| Memory allocation failed | Lowers memory and CPU cores | Close programs that use a lot of memory |
| Emulator port in use | Switches to a free port automatically | Quit other emulators (Nox/MuMu/BlueStacks) or restart |
| Leftover lock files / "Running multiple emulators with the same AVD" | Clears the AVD lock automatically and retries | Make sure no other emulator is using the same runtime |
| System image missing/corrupted/incompatible with old data | Boots again with clean user data | Delete the image in Settings → Runtime and download it again |
| Quick-boot snapshot corrupted | Discards the old snapshot and cold boots | It's rebuilt on the next normal exit; or turn snapshots off |
| Runtime components deleted / VC++ runtime missing | — | Add ApkStart to your antivirus allow list and extract it again; install the Microsoft VC++ 2015-2022 runtime |
| Low disk space | — | Move the runtime folder to a drive with enough space; turn off snapshots / shrink the data partition |
| Path contains Chinese/special characters | Switches to the short path automatically | Move ApkStart to a folder with only English letters (such as `C:\ApkStart`) |
| CPU missing instruction sets (AVX/SSE4) | — | Usually just a warning and it still boots; otherwise use a machine that supports VT-x/AVX or an older engine |
| The current runtime doesn't accept this GPU mode | Picks a GPU mode that works with the engine version | — |
| Graphics/unknown error | Retries automatically with several parameter sets | Update your graphics driver, or write a compatibility patch; if it still fails, export a diagnostic report |

**Desktop icon shows the ApkStart icon / a blank icon**: Settings → System integration → **Rebuild shortcuts** (rewrites the desktop and Start menu shortcuts from the current app list, fixing the icons and taskbar identity too). Also rebuild them if moving the shortcuts broke their paths.

---

### 6.7 No sound in apps / sound is very quiet

**Symptoms**: videos and notification sounds in Android apps are completely silent; or other Windows programs have sound and only apps in ApkStart don't.

**First, tell them apart**: if Windows itself has no sound, fix Windows audio first. Only follow the steps below if just the apps in ApkStart are silent.

1. **Windows volume and output device**: click the volume icon on the taskbar, make sure it isn't muted, the volume isn't 0, and the output device is the headphones/speakers you're actually using. Open the Volume Mixer and check that the ApkStart / Android runtime row isn't muted separately or set to 0.
2. **In-app volume**: some apps set media volume to 0 the first time you open them; turn it up in the app's own settings or with the Android volume keys. Bilibili, Douyin and similar apps may also have autoplay sound turned off inside the app.
3. **ApkStart's sound switch**: Settings → Performance & resources → **Android sound** must be ticked. Automatic detection checks this; if it's off, it's reported under "Settings → Diagnostics & repair", and clicking "Fix" turns it back on in one click. **You must restart the Android runtime once after changing it** (it only starts with `-no-audio` when both sound and microphone are off, and changing it while running won't make sound play right away).
4. **Windows Audio service**: press `Win+R`, type `services.msc`, find **Windows Audio**, and check its status is "Running" and its startup type is "Automatic". If it's disabled, right-click to start it; 0.6.3's automatic detection also finds this and tells you. In an administrator PowerShell you can run `net start Audiosrv`.
5. **Bluetooth headphones / multiple output devices**: after switching to Bluetooth headphones, Windows sometimes doesn't move programs that are already running. Disconnect and reconnect the headphones, or restart the Android runtime once.
6. **Still no sound**: export a report from "Settings → Diagnostics & repair → Export diagnostic report" and send it in. The report includes the sound switch and the audio service status, which shows directly whether it's the configuration, a Windows service or the app itself.

> When an automatic fix fails, the app opens this section automatically. If you turned off automatic detection notifications, you can also come here from the "Guide" button on the automatic detection item or the `?` in the title bar.

---

### 6.8 Store version won't start / 0xC0000135 (DLL failed to load)

**Symptoms**: after opening an app it keeps spinning or exits straight away, and the diagnostic report shows exit code `0xC0000135` (decimal `3221225781`). Most common with the version **installed from the Microsoft Store**.

**First, correct a common misjudgment**: `0xC0000135` only means "some DLL failed to load". It **doesn't necessarily** mean the VC++ runtime is missing, and it doesn't necessarily mean antivirus deleted a file. There are three possible causes behind the same exit code, so don't keep reinstalling based on only the first one:

1. **Path restrictions in the Store (MSIX) version**: the Store version is installed in the read-only `C:\Program Files\WindowsApps\...` folder. When the Android runtime starts child processes such as `qemu` from this folder, they look for DLLs by relative path, which the container's path redirection / environment isolation can break; if a dependency isn't found, they exit with `0xC0000135`. This is specific to the Store version and can't be fixed by reinstalling VC++.
2. **The VC++ runtime really is missing**: the Android runtime (Qt6 / qemu) depends on Microsoft VC++ 2015-2022 (x64). If Settings → Diagnostics & repair explicitly reports "VC++ runtime (x64) missing", **the DLL files were actually checked and don't exist**, and you can click "Fix" to install it in one click.
3. **Antivirus quarantined runtime files**: if DLLs in the runtime folder were quarantined / deleted, you also get this code. Add ApkStart's install folder and runtime data folder to your antivirus allow list, then install once more.

**Check in order**:

1. **See whether diagnostics really say VC++ is missing**: if settings report "VC++ runtime (x64) missing", click its one-click fix, restart the PC afterwards and try again. **Don't** reinstall just because the exit code is `0xC0000135`; first confirm that item is actually reported.
2. **VC++ isn't reported but it still fails → most likely the Store version's path problem**: this is currently the most likely cause. Try in turn:
   - Quit ApkStart completely (tray icon → Quit) and open it again;
   - Check your antivirus's "Controlled folder access / ransomware protection", add ApkStart to the allow list, then restart;
   - If it still doesn't work, use the **portable version** (`ApkStart-win64-portable` under Releases on GitHub / Gitee) in a folder with only English letters (such as `C:\ApkStart`). The portable version isn't installed under WindowsApps, so it avoids this restriction.
3. **Find the exact DLL that failed** (advanced): when reporting the problem, the most useful thing is telling the developer which DLL is missing. In Event Viewer → Windows Logs → Application, find the `Application Error` for ApkStart / emulator and look at the `FaultingModuleName` field; or export a report from "Settings → Diagnostics & repair → Export diagnostic report" and send it along.
4. **What if adb crashes too**: if the event log also shows `adb.exe` with `0xC0000409`, that's a separate problem (device connection), not the direct reason the emulator exits. Handle the startup with steps 1–3 above first and mention the adb problem separately when you report it.

> This section opens automatically: when a failed start / failed fix is classified as a DLL problem, the app opens it directly. You can also come here at any time from the "Guide" button on an automatic detection item or the `?` in the title bar.

---

### 6.9 Apps can't use the microphone / voice calls and recording don't work

**Symptoms**: voice messages, calls, recording, voice search and similar features in apps don't work, with messages like "no microphone / recording device unavailable".

1. **ApkStart's microphone switch**: Settings → Performance & resources → **Microphone input** must be ticked. It's on by default; if it's turned off, automatic detection reports "Microphone input is turned off in settings" under "Settings → Diagnostics & repair", and clicking "Fix" turns it on and restarts the runtime. **You must restart the Android runtime once after changing it** (the switch decides whether the emulator exposes a recording device to Android).
2. **Windows microphone permission**: in `Settings → Privacy & security → Microphone`, make sure both "Let apps access your microphone" and "Let desktop apps access your microphone" are on. Android runs inside a desktop app, and if this is off, Windows won't give it the microphone.
3. **Make sure Windows can record**: record a clip with the built-in Sound Recorder to confirm the microphone itself and the input device (headset mic / webcam mic / standalone mic) work and aren't muted.
4. **Choose the right input device**: if you have several microphones, set the one you want as the default device in Windows "Sound settings → Input"; the emulator uses the system's default input device.
5. **How sound and microphone relate**: the emulator only turns off its audio subsystem completely (to save CPU) when **both** "Android sound" and "Microphone input" are off. As long as one is on, the other works normally.

> When the microphone is off, apps just "can't find a recording device" without an obvious error. Automatic detection is there to tell you about it; you can also come to this section from the `?` in the title bar.

---

### 6.10 Discrete vs. integrated GPU rendering (graphics preference)

**Symptoms**: your PC has a discrete graphics card but the app's picture stutters and drops frames; or your laptop runs hot and drains the battery and you'd rather use the integrated GPU to save power.

ApkStart renders Android with `-gpu host`, which uses your PC's actual graphics card. Since 0.6.4, all graphics cards (NVIDIA / AMD / Intel) use host rendering first by default, instead of old versions dropping AMD/Intel to software rendering across the board, which amounted to giving up the graphics card. If host rendering crashes on a particular machine, it automatically falls back to a software backend and keeps working.

**Choose which graphics card to use**: when a PC has both a discrete and an integrated GPU, Windows sometimes assigns the emulator to the integrated one. Settings → Performance & resources → **Graphics preference** lets you choose explicitly:

| Option | Best for |
|---|---|
| System default (recommended) | Lets Windows choose based on power and load; the least hassle on most machines |
| Prefer discrete GPU | Games, video, high frame rates; uses more power and runs hotter |
| Prefer integrated GPU | Light apps, idling, saving laptop battery; somewhat lower performance |

- This works through Windows' "Graphics performance preference" (UserGpuPreferences) for the emulator process, and **only works on Windows 10 1803 and later**; older systems ignore it automatically without affecting startup.
- The choice takes effect the **next time the Android runtime starts**; the settings page shows whether it's in effect.
- Host rendering occasionally crashes on old AMD drivers: update your graphics driver; if that doesn't help, enable the bundled AMD integrated-GPU swangle example patch in "Settings → Diagnostics & repair → Drivers · compatibility patches" to pin rendering to a more stable backend.

---

## 7. Command-line reference

```
ApkStart.exe                          Open the main window
ApkStart.exe <path\to.apk>            Install an APK
ApkStart.exe --launch <package name>  Launch an app directly (this is what desktop shortcuts use)
```

---

## 8. Data and folders

| Purpose | Location |
|---|---|
| Runtime (adb / emulator / images) | Bundled, or `%APPDATA%\apkstart\runtime` (lightweight version) |
| Extracted system image | `%APPDATA%\apkstart\system-images` |
| AVD / installed apps / snapshots | `%APPDATA%\apkstart\avd` |
| App icons | `%APPDATA%\apkstart\icons\<package name>.ico` |
| Settings and app list | `%APPDATA%\ApkStart\settings.json` / `apps.json` |
| Logs / diagnostic reports | `%APPDATA%\ApkStart\logs\` |
| Windows ↔ Android shared folder | `%USERPROFILE%\ApkStartShared` ↔ `/sdcard/ApkStartShared` |

> "Reset Android data" only clears the user data layer; the system image and APK files are kept. Updating the app doesn't lose the runtime, installed apps or snapshots.
>
> Keep plenty of free space on drive C: the extracted image, data partition and snapshots together can reach several GB. Low space can make installing or booting fail.

---

## 9. Getting help and reporting problems

When reporting a problem, please include these three things; they make it much faster to pin down:

1. **Diagnostic report**: Settings → Diagnostics & repair → Export diagnostic report;
2. **The last 20 lines of app.log**: `%APPDATA%\ApkStart\logs\app.log`;
3. **Your version and edition**: for example "Store version 0.6.4" or "full portable 0.6.4".

- GitHub: <https://github.com/RoutineMiku/apkstart> (Issues / Releases)
- Gitee: <https://gitee.com/daily-miku/apkstart>

---

*This manual describes v0.6.4 and is updated with each release. If the wording in the app differs slightly from this manual, what the app shows is correct.*

# ApkStart User Manual & Troubleshooting Guide

> Version: v0.6.4 · Platform: Windows 10/11 x64 · Updated: 2026-11-22
>
> ApkStart is an Android app runner for Windows: **install Android apps like native Windows software, launch from desktop icons, and double-click to run.**
> This manual first explains how to use ApkStart, then provides step-by-step solutions organized by symptom. Every step corresponds to actual buttons and menus in the app.

---

## Contents

1. [ApkStart in 30 Seconds](#1-apkstart-in-30-seconds)
2. [Installation & First Launch](#2-installation--first-launch)
3. [Daily Usage](#3-daily-usage)
4. [Three Core Concepts (Understanding Errors)](#4-three-core-concepts-understanding-errors)
5. [First Step When Troubleshooting: Preflight & Auto-Debug](#5-first-step-when-troubleshooting-preflight--auto-debug)
6. [Common Troubleshooting Solutions](#6-common-troubleshooting-solutions)
   - [6.1 "Hardware Acceleration Not Enabled" / Slow Boot](#61-hardware-acceleration-not-enabled--slow-boot)
   - [6.2 Installation Failed (INSTALL_FAILED_*)](#62-installation-failed-install_failed_)
   - [6.3 Missing ARM Translation Layer / ARM App Fails to Install or Crashes](#63-missing-arm-translation-layer--arm-app-fails-to-install-or-crashes)
   - [6.4 adb Unauthorized (Allow USB Debugging)](#64-adb-unauthorized-allow-usb-debugging)
   - [6.5 Double-Clicking Icon Does Nothing / Infinite Spinner / Window with Rotate Button](#65-double-clicking-icon-does-nothing--infinite-spinner--window-with-rotate-button)
   - [6.6 Other Startup Issues Quick Reference](#66-other-startup-issues-quick-reference)
   - [6.7 No Sound / Low Volume in Apps](#67-no-sound--low-volume-in-apps)
   - [6.8 Store Edition Launch Failure / 0xC0000135 (DLL Load Failed)](#68-store-edition-launch-failure--0xc0000135-dll-load-failed)
   - [6.9 App Cannot Access Microphone / Voice Calls & Recording Fail](#69-app-cannot-access-microphone--voice-calls--recording-fail)
   - [6.10 Discrete / Integrated GPU Rendering (GPU Preference)](#610-discrete--integrated-gpu-rendering-gpu-preference)
7. [Command-Line Reference](#7-command-line-reference)
8. [Data & Directory Layout](#8-data--directory-layout)
9. [Help & Feedback](#9-help--feedback)

---

## 1. ApkStart in 30 Seconds

```
Desktop Shortcut (real app icon .lnk)
      │ Double-click
      ▼
ApkStart.exe --launch <package>
      │ Android runtime not running? → Auto-start (Android 14 emulator, bundled or downloaded on first run)
      ▼
Launch app via system-resolved launcher entry (not hardcoded main Activity)
      ▼
Emulator Window = App Window (custom title, icon, portrait ratio, centered fullscreen)
```

**Key Features**

- 🖱️ **Double-click .apk to install**: After registering file associations in Explorer, double-clicking an APK automatically parses, installs, and creates a desktop shortcut.
- 🧩 **One desktop icon per app**: Icons are extracted offline from the APK; double-clicking the icon launches the app directly.
- 🪟 **Each app is a window**: Native rendering, fullscreen fills screen height and centers, windowed mode supports resizing, and each app remembers its own window size.
- 🔍 **Searchable in Windows**: Dual shortcuts on Desktop and Start Menu (`Programs\ApkStart\`).
- 📁 **Shared files**: Two-way sync between `%USERPROFILE%\ApkStartShared` and `/sdcard/ApkStartShared` in Android.
- 🪶 **Self-contained runtime**: Does not depend on MuMu, LDPlayer, WSA, or any third-party emulator installed on your PC.

> Note: This is an early open-source, free, ad-free project maintained in spare time. If you run into issues, this manual is here to help.

---

## 2. Installation & First Launch

### 2.1 Choosing the Right Edition

Both sources have identical contents:

- GitHub: `github.com/RoutineMiku/apkstart/releases`
- Gitee: `gitee.com/daily-miku/apkstart/releases`

| Edition | Filename | When to Choose |
|---|---|---|
| **Microsoft Store** | `ApkStart_<4-part-version>_x64.msix` | Install from Microsoft Store. Bundled full runtime, no download needed, updated via Store |
| **Full Portable** | `ApkStart-v*-win64-full.zip` (~830 MB, ~1.3 GB extracted) | No installer and no runtime download wait: extract and run with full bundled runtime |
| **Installer** | `ApkStart-v*-Setup.exe` (~1.3 GB) | Adds Start Menu/Desktop shortcuts and Windows uninstaller entry |
| **Lite Portable** | `ApkStart-v*-win64-portable.zip` (96 MiB, ~227 MB extracted) | Try it out first; downloads the runtime on first launch |

> ⚠️ **Always use the latest version (currently v0.6.4)**. Older versions (v0.5.x and earlier) either lacked a bundled runtime or defaulted to an embedded shell window—which caused slow launches or a window with a rotate button. When upgrading from an older version, ensure your desktop shortcuts point to the new program folder.

### 2.2 What Happens on First Launch

1. **(Lite edition only) Download runtime**: adb, Android Emulator, and Android 14 system image (8-thread chunked download with resume support). Full Portable and Store editions skip this step.
2. **Extract system image**: The xz image is extracted once to `%APPDATA%\apkstart\system-images` (~20 seconds).
3. **Create `/data` partition**: ApkStart creates an ext4 user data image with encryption and SELinux labels (the official image only ships a 1 MB placeholder).
4. **Auto-boot**: Subsequent app launches only run `am start`; cold boot takes ~23s and quickboot snapshot resume takes ~10s.

> First-launch slowness is a one-time setup cost. Subsequent launches are much faster.

---

## 3. Daily Usage

### 3.1 Installing Apps

Choose any of three methods:

- **Double-click an APK file** (register association first: Settings → Integration & Files → Associate .apk files);
- Click **Install App** in the main window;
- Command line: `ApkStart.exe <path\to.apk>`.

Supports `.apks` / `.xapk` split packages (automatically uses `install-multiple`). Desktop and Start Menu shortcuts are created automatically after installation.

### 3.2 Launching Apps

Double-click the desktop icon. All apps share the same Android runtime, so **launching a second app is nearly instant**.

### 3.3 Window & Display

| Action | Method |
|---|---|
| Toggle Fullscreen / Windowed | `F11` or tray context menu. Fullscreen scales the window while preserving aspect ratio |
| Rotate Portrait / Landscape | `Ctrl+Alt+R` (global) or the titlebar rotate button; orientation is remembered per app |
| Auto Fullscreen | Settings → Display & Window → Auto Fullscreen (works best with Orientation Lock) |
| Force Landscape / Portrait | Settings → Display & Window → Screen Orientation |

> The runtime only restarts when the panel orientation differs from the app orientation (~40s, indicated on the titlebar). Apps with the same orientation launch immediately.

### 3.4 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `F11` | Toggle fullscreen / windowed mode |
| `Ctrl+Alt+R` | Rotate current app portrait / landscape |
| `Ctrl+R` | Rotate inside shell window (use `Ctrl+Alt+R` in native detached window mode) |

### 3.5 File Sharing (Windows ↔ Android)

Two-way sync between `%USERPROFILE%\ApkStartShared` on Windows and `/sdcard/ApkStartShared` inside Android.
Go to Settings → Integration & Files → File Sharing ("Sync Now" or "Open Folder").

### 3.6 Settings Navigation

Starting from v0.6.0, Settings is organized into categories with a search bar at the top (search keywords like "landscape", "memory", or "proxy" across all categories):

| Category | Contents |
|---|---|
| General & Install | Runtime & environment, one-click deploy, auto-start, disk usage & cleanup |
| Display & Window | Display mode, auto fullscreen, screen orientation, tablet layout, window host mode |
| Input & Controls | Mouse bindings, keyboard mapping |
| Performance & Resources | Resource policy, GPU preference (dGPU/iGPU), microphone, display quality, data partition, system language, snapshots, boot prewarm |
| Network & Downloads | Update & download sources, mirror acceleration, download threads |
| Diagnostics & Repair | Host preflight check, drivers & compat patches, auto-debug |
| Integration & Files | Desktop & apps, file sharing, system integration |
| Updates & About | Software updates, about |
| Labs | Multi-window (experimental), background app limit |

> **Labs · Multi-Window (Experimental)**: When enabled, opening a new app keeps previous apps resident in the background so you can switch back with login state preserved. Because the Android runtime uses one emulator window, only one app is visible in the foreground at a time, and memory usage increases. Disabled by default.

### 3.7 Online Updates

Go to Settings → Updates & About → Check for Updates, or right-click the tray icon → Check for Updates. ApkStart benchmarks sources (GitHub / Gitee / mirrors), downloads in parallel chunks, and falls back automatically on failure. Updating preserves your runtime, installed apps, and snapshots.

Portable editions support **incremental updates**: each release includes a code manifest and a small app-code archive (a few MB vs ~100 MB full package). If the Electron shell version matches, only the small archive is downloaded and verified file-by-file; otherwise it automatically falls back to the full package. Store editions are updated by Microsoft Store.

> Note: Incremental updates apply to portable builds updated via "Check for Updates". Microsoft Store builds update through the Store channel. Neither affects installed apps, Android data, runtime, or snapshots.

---

## 4. Three Core Concepts (Understanding Errors)

Most unexpected errors come from one of the three components below.

### 4.1 Runtime / System Image

ApkStart runs a **full Android 14 system image** as its base.
Since v0.6.3, there is **one unified image** (Google Play x86_64) for both x86 and ARM apps—no separate AOSP vs compatibility image split.

- Missing / corrupted image or mismatch with old user data → boot failure, stuck boot, or boot loops.
- User data (`/data`) is a thin diff layer; the system image is shared across the installation.

### 4.2 Hardware Acceleration

Smooth emulation requires CPU virtualization acceleration. On Windows there are two paths:

| Method | What It Is | Admin Required | Reboot After Install |
|---|---|---|---|
| **WHPX** | Built-in Windows feature "Windows Hypervisor Platform" (`HypervisorPlatform`) | When enabling feature | Yes |
| **AEHD** | Google's kernel driver | When installing driver | No |

**Emulation still works without acceleration** (pure software emulation / TCG), though booting takes several minutes and frame rates are lower—this is slowness, not a fatal failure. ApkStart falls back automatically and retries up to 4 parameter combinations (renderer → acceleration → memory/cold boot).

> Do not confuse **VirtualMachinePlatform** (used by WSL2) with **HypervisorPlatform**. The Android emulator requires **HypervisorPlatform**; enabling only VirtualMachinePlatform still leaves `emulator -accel-check` unavailable.

### 4.3 ARM Translation Layer

Most Android apps only ship **ARM native libraries** (`arm64-v8a` / `armeabi-v7a`), while the system image is **x86_64**. A translation layer converts ARM instructions for x86 CPUs. The unified Android 14 image includes an updated `ndk_translation` layer, so ARM apps usually work out of the box.

- If translation components are missing when installing an ARM app, ApkStart automatically switches/prepares the compatibility image and retries (see 6.3).
- Older API 30 images had compatibility issues with newer translation layers (such as `DoBadTrampoline` SIGABRT crashes); the Android 14 image fixes this.

---

## 5. First Step When Troubleshooting: Preflight & Auto-Debug

Before digging through this manual, let ApkStart check your system automatically—most issues can be fixed with one click.

### 5.1 Host Preflight & Auto-Config

Location: Settings → Diagnostics & Repair → **Run Preflight Check**

- Checks: CPU virtualization (VT-x/SVM), Hyper-V / Windows Hypervisor Platform, GPU / VRAM / driver, RAM, OS build, `emulator -accel-check`, and AEHD driver.
- Clicking **Apply Recommended Config** writes safe defaults (memory, CPU cores, resolution, quality, software emulation when acceleration is absent) and saves a local host driver profile.
- Severity levels: `ok` / `warn` (usable, optimization suggested) / `bad` (must be resolved to run).

Only two things require manual action:
- **BIOS virtualization**: Reboot into BIOS → enable Intel VT-x / AMD SVM (software cannot change BIOS settings).
- **Windows features / acceleration driver**: See 6.1.

### 5.2 Auto-Debug (Automatic Diagnostics)

Location: Settings → Diagnostics & Repair → **Auto-Debug · Smart Diagnostics**

Runs every 10 minutes in the background, grouping issues into categories with **one-click fixes** (restart runtime, clear locks, kill orphan processes, invalidate snapshot, clean disk, reset Android network, etc.) and automatic re-verification:

| Category | Covered Issues |
|---|---|
| Runtime | Last boot failure root cause, stuck boot, leftover lock files, orphan emulator processes, empty/corrupt snapshot, missing hardware acceleration |
| Device Connection | adb unauthorized, offline, runtime running but adb cannot see device |
| Storage | Low disk space, data partition size mismatch, shared folder not writable |
| Settings | Orientation conflict with physical panel, auto-fullscreen conflict in detached window mode |
| Network / Logs | Android guest offline, download sources unreachable, recent log errors |

> Two principles: failed probes are never reported as false positives; existing unresolved issues do not spam repeated notifications.

### 5.3 Export Diagnostic Report

Location: Settings → Diagnostics & Repair → **Export Diagnostic Report** (or in Integration & Files).

The report is plain text containing host hardware profile, selected launch arguments, logs, and diagnosis conclusions. Always attach it when reporting bugs.

### 5.4 Built-in User Manual & Auto-Tutorials

Starting in v0.6.3, this manual is **embedded in the app**: click the `?` button in the main titlebar or "Open User Manual" in Settings → Updates & About. It supports search, scrolling, and Print / Save as PDF, and opens directly to the relevant section when triggered from an error.

Auto-debug and auto-repair also surface tutorials automatically:

- Each detected issue has a **Tutorial** button on the right that jumps straight to the matching section;
- When auto-repair fails for hardware acceleration, install failures, ARM translation, adb authorization, or no sound, **the matching tutorial opens automatically**;
- Each tutorial only auto-opens once per session so it never interrupts repeatedly.

> Manual access: click `?` in the titlebar. You can disable auto-open notifications in Auto-Debug settings while keeping the **Tutorial** button available on every issue card.

---

## 6. Common Troubleshooting Solutions

### 6.1 "Hardware Acceleration Not Enabled" / Slow Boot

**Symptoms**: Preflight or diagnostics report "Hardware acceleration is not enabled" / "unavailable"; boot takes several minutes and frame rate drops.

**Note**: This usually means slowness rather than inability to launch. ApkStart automatically falls back to software emulation. Enable acceleration for smooth performance.

**By edition:**

- **Installer / Portable**: Settings → Diagnostics & Repair → Host Preflight → find "Hardware acceleration not enabled" → click **Fix**. Confirm the UAC prompt to enable WHPX; if WHPX is unsupported or declined, ApkStart falls back to installing the AEHD driver.
- **Microsoft Store (MSIX)**: Store apps **cannot elevate privileges directly**. Clicking **Fix** opens "Turn Windows features on or off":
  1. Check **Windows Hypervisor Platform** (`HypervisorPlatform`);
  2. Click OK and **reboot your PC**.

  Or run in an **elevated PowerShell**:

  ```powershell
  dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
  dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  ```

> Two common pitfalls: (1) Enabling only `VirtualMachinePlatform` is not enough—the emulator needs `HypervisorPlatform`. (2) If VT-x/SVM is disabled in BIOS (see 5.1), enabling Windows features alone will not work.
> If your GPU driver is over 3 years old, update it from the vendor's website. Some older integrated GPUs also benefit from compatibility patches in Settings → Diagnostics & Repair → Drivers & Compatibility Patches.

---

### 6.2 Installation Failed (INSTALL_FAILED_*)

**Symptoms**: App installation fails with an `INSTALL_*` error code.

Refer to the table below:

| Error Code | Meaning | Solution |
|---|---|---|
| `INSTALL_FAILED_NO_MATCHING_ABIS` | App only includes ARM libraries and current image lacks ARM translation | **Usually auto-handled**: ApkStart switches to the compat image and retries. See [6.3](#63-missing-arm-translation-layer--arm-app-fails-to-install-or-crashes) |
| `INSTALL_FAILED_OLDER_SDK` | App requires a newer Android version | Requires a newer system image; current image is Android 14 (API 34) |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | APK has no valid signature | APK is corrupted or unsigned; obtain a valid APK |
| `INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES` / `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Signature mismatch with installed version | Uninstall the old version first |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | A newer version is already installed | Install a newer version or uninstall first |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | Insufficient runtime disk space | Free disk space or move the runtime data directory in Settings → Integration & Files |
| `INSTALL_FAILED_INVALID_APK` | APK is corrupted or incomplete | Re-download the APK |
| `INSTALL_FAILED_INVALID_URI` | APK path contains special or non-ASCII characters | Move the APK to an ASCII-only path and retry |
| `INSTALL_FAILED_ALREADY_EXISTS` | Package already exists with a different signature | Uninstall first |
| `INSTALL_FAILED_DEPRECATED_SDK_VERSION` | App targets a very old Android SDK | **Auto-handled**: ApkStart retries with official bypass flags |
| `INSTALL_FAILED_TEST_ONLY` | Test-only APK | **Auto-handled**: ApkStart retries with `-t` |
| `INSTALL_FAILED_MISSING_SHARED_LIBRARY` | Missing vendor/device-specific library | App depends on proprietary device libraries unavailable in emulator |
| `INSTALL_FAILED_USER_RESTRICTION` | System restricted installation | Restart runtime and retry |
| `INSTALL_FAILED_CONFLICTING_PROVIDER` | ContentProvider conflict with an installed app | Uninstall the conflicting app |
| `INSTALL_FAILED_INTERNAL_ERROR` | Internal system error (often low space or boot incomplete) | Restart runtime, wait for boot completion, and retry |

> For any error code not listed above, export a diagnostic report (5.3) and attach it when reporting the issue.

---

### 6.3 Missing ARM Translation Layer / ARM App Fails to Install or Crashes

**Symptoms**: Installation fails with `INSTALL_FAILED_NO_MATCHING_ABIS`, or the app crashes immediately on launch with `DoBadTrampoline`, `libndk_translation`, `UnsatisfiedLinkError`, or `...so not found` in logs.

**How it works**: Since v0.6.3, **one unified Android 14 image** supports both x86 and ARM with built-in translation. The legacy "Universal Compat Image (Auto-managed)" toggle is kept only for backward compatibility and normally requires no manual changes.

**What ApkStart does automatically:**

1. If installation fails with `NO_MATCHING_ABIS`, ApkStart switches to the compat image, restarts the runtime, restores installed apps from local APK backups, and retries installation.
2. If an app crashes on launch due to ARM translation (e.g. `DoBadTrampoline`), ApkStart automatically switches to the Android 14 compat image and retries.

**What you should do:**

- **Wait patiently**: Switching images restarts the runtime (~40–60s).
- **Verify image readiness**: Check Settings → General & Install → Runtime → "Universal Compat Image (Auto-managed)". If not downloaded, click "Download Compat Image" (~1.5 GB) and **restart the runtime** after completion.
- **Still crashing**: A few apps use strict anti-emulator checks (verifying physical sensors, baseband, etc.) and intentionally exit in emulators. This is an app limitation rather than a runtime bug.

**What if a red "Install Failed" error says "switching to compat image and retrying"?**

That was a display bug in older builds where switching was skipped when reusing a non-translation runtime while still printing the retry message. **Update to the latest v0.6.4 build**, which probes actual translation capability before installing, always triggers switch + restart + snapshot clear on `NO_MATCHING_ABIS`, and reports accurately if a retry fails.

> Verified: Hongguo Short Drama (`com.phoenix.read`, `arm64-v8a`-only) installs, loads feeds, and plays video normally on the Android 14 image with `ro.product.cpu.abilist = x86_64,arm64-v8a`.

---

### 6.4 adb Unauthorized (Allow USB Debugging)

**Symptoms**: Diagnostics report "adb unauthorized" or "Android debugging authorization incomplete", `adb devices` shows `unauthorized`, and apps fail to start.

**Correct steps (in order):**

1. Check if an emulator window is showing the **"Allow USB debugging?"** dialog—click **Allow** and check **"Always allow from this computer"** so it won't prompt again.
2. If the window is unresponsive or never appears: go to Settings → General & Install → **Reset Android Data** and retry (this clears installed app data, while local APK files are preserved for automatic reinstall).

> ⚠️ **Never delete `%USERPROFILE%\.android\adbkey`**. That is counterproductive: Android only writes a new public key when `adb_keys` does not exist; regenerating a new private key leaves the old public key inside the system, causing permanent authorization mismatch.

> CLI debugging: ApkStart runs its own adb server on **dedicated port 5044** (isolated from your system port 5037):
> ```powershell
> $env:ANDROID_ADB_SERVER_PORT = 5044
> adb devices    # should list emulator-5554
> ```
> Do not manually run `adb connect` on port 5555—Play images will pop up "Allow USB debugging?" over the app window.

---

### 6.5 Double-Clicking Icon Does Nothing / Infinite Spinner / Window with Rotate Button

These symptoms almost always point to the **launch entry or window attachment**. Check in order:

**1. Confirm you are running the latest version**

- Check the start of `%APPDATA%\ApkStart\logs\app.log`: it should say `start v0.6.4`. If it shows `v0.5.x`, your desktop/Start Menu shortcut still points to an old directory.
- Older versions (v0.5.x) lacked a bundled runtime and defaulted to an embedded shell window with a rotate button. Upgrade to v0.6.4 and rebuild shortcuts.

**2. Understand normal boot times**

Cold boot takes ~23–48s and orientation-switch restart takes ~50s. **Do not double-click repeatedly**: launching a second instance while the first is booting can cause conflicting ownership or premature shutdown. Click once and wait.

**3. Native window attach failed → fallback to embedded window with rotate button**

If logs show `attach failed` or `emu:0`, the window agent could not find the emulator window and fell back to embedded mode (showing a titlebar with a rotate button).
- Launching from directory junctions or non-standard paths can trigger this; v0.6.3+ resolves canonical paths before matching. If it still happens, attach logs when reporting.

**4. Reset Android Data (last resort)**

Settings → General & Install → **Reset Android Data** (with confirmation). Clears installed apps and user data while keeping the system image and app list intact so apps reinstall automatically on next launch. Useful when `/data` is corrupted or fails to mount.

---

### 6.6 Other Startup Issues Quick Reference

Most runtime errors below are **handled automatically** by ApkStart. If auto-recovery fails, export a diagnostic report (5.3).

| Diagnosis | Auto-Handling | What You Can Do |
|---|---|---|
| Hardware acceleration unavailable | Falls back to software emulation | Enable acceleration per 6.1 |
| Memory allocation failed | Reduces RAM and CPU cores | Close memory-heavy applications |
| Emulator port occupied | Switches to a free port automatically | Close other emulators (Nox/MuMu/BlueStacks) or reboot |
| Leftover lock file / "Running multiple emulators with the same AVD" | Clears AVD locks and retries | Ensure no other emulator uses the same runtime |
| System image missing / corrupted / incompatible with old data | Boots with clean user data | Re-download system image in Settings → Runtime |
| Quickboot snapshot corrupted | Discards old snapshot and cold boots | Normal exit rebuilds snapshot; or disable snapshots |
| Runtime components missing / missing VC++ | — | Whitelist ApkStart in antivirus and re-extract; install Microsoft VC++ 2015-2022 Redistributable |
| Insufficient disk space | — | Move runtime directory to a drive with more free space; disable snapshots or shrink data partition |
| Non-ASCII / special characters in path | Automatically uses 8.3 short path | Move ApkStart to an ASCII path (e.g. `C:\ApkStart`) |
| Missing CPU instructions (AVX/SSE4) | — | Usually a warning; otherwise use a CPU with VT-x/AVX |
| GPU mode rejected by current runtime | Re-selects a supported GPU mode | — |
| GPU / unknown error | Retries multiple parameter sets | Update GPU drivers, try a compat patch, or export diagnostic report |

**Desktop icon shows the ApkStart icon or a blank icon**: Go to Settings → Integration & Files → **Rebuild Shortcuts** (rewrites Desktop and Start Menu shortcuts with icons and Taskbar AppUserModelID). Also rebuild shortcuts if you moved the program folder.

---

### 6.7 No Sound / Low Volume in Apps

**Symptoms**: Videos or notifications in Android apps have no sound while other Windows apps work normally.

**Check in order:**

1. **Windows volume & output device**: Click the taskbar speaker icon to verify output device and unmuted volume. Open **Volume Mixer** and ensure ApkStart / Android runtime is not muted or turned down.
2. **In-app volume**: Some apps mute media volume on first launch; raise volume inside the app or via Android volume controls.
3. **ApkStart sound toggle**: Settings → Performance & Resources → **Android Audio** must be checked. Auto-debug checks this setting and offers a one-click fix. **Restart the Android runtime after changing** (when both audio and mic are off, the emulator launches with `-no-audio`, which cannot be toggled live).
4. **Windows Audio service**: Press `Win+R`, run `services.msc`, find **Windows Audio**, and verify its status is **Running** and startup type is **Automatic** (or run `net start Audiosrv` in elevated PowerShell).
5. **Bluetooth / multi-output switching**: Reconnect Bluetooth headphones or restart the Android runtime if Windows did not migrate audio streams.
6. **Still silent**: Export a diagnostic report (Settings → Diagnostics & Repair → Export Diagnostic Report); it includes audio toggle and service status.

> If auto-repair fails, ApkStart opens this section automatically. You can also jump here from an issue's **Tutorial** button or `?` in the titlebar.

---

### 6.8 Store Edition Launch Failure / 0xC0000135 (DLL Load Failed)

**Symptoms**: Clicking an app spins endlessly or exits immediately, and the diagnostic report shows exit code `0xC0000135` (decimal `3221225781`). Most common on **Microsoft Store (MSIX)** installations.

**Important clarification**: `0xC0000135` only means "a DLL failed to load"—it does **not necessarily** mean VC++ Redistributable is missing, nor does it necessarily mean antivirus deleted files. There are three possible causes:

1. **Microsoft Store (MSIX) path & container isolation**: The Store edition installs into read-only `C:\Program Files\WindowsApps\...`. When the runtime spawns `qemu` child processes that resolve DLLs via relative paths, MSIX path redirection / container isolation can break DLL lookup and exit with `0xC0000135`. Reinstalling VC++ will not fix this Store-specific issue.
2. **Actually missing VC++ Redistributable**: The Android runtime (Qt6 / qemu) depends on Microsoft VC++ 2015-2022 (x64). If Settings → Diagnostics & Repair explicitly reports **"Missing VC++ Redistributable (x64)"**, the DLL check confirmed it is absent—click **Fix** to install it.
3. **Antivirus quarantined runtime files**: DLLs in the runtime folder were quarantined or deleted. Whitelist ApkStart's install and runtime data directories in your antivirus and reinstall.

**Troubleshoot in order:**

1. **Check whether VC++ is actually reported missing**: Only install VC++ if Preflight explicitly flags **"Missing VC++ Redistributable (x64)"** (do **not** blindly reinstall VC++ just because you saw `0xC0000135`). Reboot after installing.
2. **If VC++ is present and launch still fails → likely MSIX path isolation**: Try:
   - Fully quit ApkStart (tray icon → Quit) and reopen;
   - Check antivirus Controlled Folder Access / Ransomware Protection and whitelist ApkStart;
   - If it persists, use the **Portable edition** (`ApkStart-win64-portable` from GitHub / Gitee Releases) extracted to an ASCII path like `C:\ApkStart`—it runs outside `WindowsApps` and avoids MSIX container restrictions.
3. **Find the exact failing DLL (advanced)**: Open Event Viewer → Windows Logs → Application, find the `Application Error` for ApkStart / emulator, and check `FaultingModuleName`, or export a diagnostic report when reporting the issue.
4. **What if `adb.exe` crashes with `0xC0000409`?**: That is a separate device-connection crash, not the direct cause of emulator exit. Resolve emulator startup first using steps 1–3, and mention the adb crash separately in your report.

> This section opens automatically when a launch or repair failure is diagnosed as a DLL issue.

---

### 6.9 App Cannot Access Microphone / Voice Calls & Recording Fail

**Symptoms**: Voice messages, calls, audio recording, or voice search fail with "No microphone / recording device unavailable".

1. **ApkStart microphone toggle**: Settings → Performance & Resources → **Microphone Input** must be checked (enabled by default). If disabled, Auto-Debug flags it with a one-click fix. **Restart the Android runtime after changing** (this flag controls whether the emulator exposes a recording device to Android).
2. **Windows microphone permissions**: Open Windows Settings → Privacy & security → Microphone, and ensure both **"Let apps access your microphone"** and **"Let desktop apps access your microphone"** are enabled.
3. **Verify Windows recording works**: Test recording with Windows Sound Recorder to ensure the microphone is unmuted and working.
4. **Select the right input device**: In Windows Sound Settings → Input, set your desired microphone as the default input device.
5. **Audio & microphone relationship**: The emulator only disables the entire audio subsystem when **both** Android Audio and Microphone Input are turned off.

> When the microphone is disabled, Android apps simply see no recording device without an obvious error. Auto-Debug detects and reports this proactively.

---

### 6.10 Discrete / Integrated GPU Rendering (GPU Preference)

**Symptoms**: Apps lag or drop frames even on a PC with a discrete GPU, or you want a laptop to use the integrated GPU to save battery.

ApkStart renders Android graphics using `-gpu host` to utilize your real GPU. Starting in v0.6.4, all GPUs (NVIDIA / AMD / Intel) default to host rendering instead of forcing AMD/Intel to software rendering. If host rendering crashes on a given machine, ApkStart automatically falls back to software rendering.

**Choose which GPU to use**: When your PC has both an iGPU and a dGPU, Windows may assign the emulator to the iGPU. Go to Settings → Performance & Resources → **GPU Preference**:

| Option | Best For |
|---|---|
| System Default (Recommended) | Lets Windows choose based on power/load |
| Discrete GPU (Performance) | Games, video, high frame rates (higher power/heat) |
| Integrated GPU (Power Saving) | Lightweight apps, idle tasks, laptop battery life |

- Uses Windows **Graphics Performance Preference** (`UserGpuPreferences`) for the emulator executable (**requires Windows 10 1803 or later**; ignored harmlessly on older systems).
- Takes effect on the **next Android runtime start**.
- For older AMD drivers where `host` crashes: update GPU drivers, or enable the built-in AMD iGPU `swangle` compatibility patch in Settings → Diagnostics & Repair → Drivers & Compatibility Patches.

---

## 7. Command-Line Reference

```
ApkStart.exe                          Open main window
ApkStart.exe <path\to.apk>            Install APK
ApkStart.exe --launch <package>       Launch app directly (used by desktop shortcuts)
```

---

## 8. Data & Directory Layout

| Purpose | Location |
|---|---|
| Runtime (adb / emulator / images) | Bundled, or `%APPDATA%\apkstart\runtime` (Lite edition) |
| Extracted system images | `%APPDATA%\apkstart\system-images` |
| AVD / installed apps / snapshots | `%APPDATA%\apkstart\avd` |
| App icons | `%APPDATA%\apkstart\icons\<package>.ico` |
| Settings & app manifest | `%APPDATA%\ApkStart\settings.json` / `apps.json` |
| Logs / diagnostic reports | `%APPDATA%\ApkStart\logs\` |
| Windows ↔ Android shared folder | `%USERPROFILE%\ApkStartShared` ↔ `/sdcard/ApkStartShared` |

> "Reset Android Data" only clears the user data layer; system images and APK files are preserved. Updating ApkStart preserves your runtime, installed apps, and snapshots.
>
> Keep sufficient free space on `C:\`: extracted images + data partition + snapshots can total several GB. Low disk space causes install and boot failures.

---

## 9. Help & Feedback

Please include these three items when reporting an issue:

1. **Diagnostic Report**: Settings → Diagnostics & Repair → Export Diagnostic Report;
2. **Last 20 lines of `app.log`**: `%APPDATA%\ApkStart\logs\app.log`;
3. **Version & edition**: e.g. "Store 0.6.4" or "Full Portable 0.6.4".

- GitHub: <https://github.com/RoutineMiku/apkstart> (Issues / Releases)
- Gitee: <https://gitee.com/daily-miku/apkstart>

---

*This manual corresponds to v0.6.4 and is updated with each release. If any wording differs slightly, follow the actual UI text in the app.*

# arsc-minimal.apk — synthetic resource-ID fixture

**Not a compiled APK.** These bytes were assembled by `test/lib/make-arsc-apk.js`
from documented binary formats (`resources.arsc` ResTable, binary AXML, stored ZIP).
No aapt2, Android SDK, device dump, or third-party APK was used. Do not treat this
fixture as evidence about any real application.

## Purpose

The existing synthetic APK (`test/lib/make-apk.js`) writes literal strings for
`android:label` / `android:icon`, so the production `ResTable` path had no fixture.
This one declares:

| Manifest attribute | Value |
| --- | --- |
| package | `com.example.arscfixture` |
| versionCode / versionName | `7` / `1.2.3` |
| `android:label` | `@0x7f010000` → string `Arsc Fixture App` |
| `android:icon` | `@0x7f020000` → `res/mipmap-hdpi/ic_launcher.png` |

`resources.arsc` has one package (id `0x7f`, name `com.example.arscfixture`),
type 1 `string` entry 0 `app_name`, and type 2 `mipmap` entry 0 `ic_launcher`.
The ZIP also carries a larger decoy PNG (`res/drawable-xxxhdpi/app_icon_decoy.png`)
so a test can prove the icon came from the referenced resource ID rather than
`pickIconFromZip`'s size heuristic.

## Reproduction

Generator source: `test/lib/make-arsc-apk.js`.

```sh
node test/lib/make-arsc-apk.js --write test/fixtures/arsc-minimal/arsc-minimal.apk
```

Generated on: 2026-11-21, Node `v24.19.0` (win32 x64). ZIP timestamps and all
format padding are zero-filled, so regeneration is byte-identical for the exact
generator source and Node's byte-level Buffer APIs.

## Recorded bytes

- fixture size: 9014 bytes
- fixture SHA-256: `b5cf42da75a85a30d64fbd5da26474a592136abd0c326a9cfed800a37d16fd06`
- icon payload (`res/mipmap-hdpi/ic_launcher.png`, 96×96): 1620 bytes,
  SHA-256 `0c34ba5629c3745681dd94834b808f8b96e775c81169b00e44d4c72ea6252797`
- decoy payload (256×256): SHA-256
  `744c77e6d9e441ec446e7f72aad692a4d3d64cc6616b83de5c43cade9682146f`

All five entries are stored with matching, correct CRC-32 values; Python
`zipfile.ZipFile(...).testzip()` returns `None` and the project `ZipFile` reads
every entry.

If the generator changes, regenerate the fixture and update these hashes plus
`FIXTURE_SHA256` / `ICON_SHA256` / `DECOY_SHA256` in `test/arsc-fixture-test.js`.

## Test

```sh
node test/arsc-fixture-test.js
```

The test verifies the fixture hash, byte-for-byte generator replay, production
`parseApk` output (package, versions, launcher, resolved label, icon file and
bytes), direct AXML reference IDs, direct ResTable structure, and three negative
controls (wrong ARSC value, swapped manifest IDs, missing `resources.arsc`).
Missing or mutated fixtures fail with a non-zero exit; nothing is skipped.

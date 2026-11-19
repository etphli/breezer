# Build Breezer for Windows x64

The native Windows build uses the Helium Windows and shared Chromium revisions in
[`upstream.lock.json`](../upstream.lock.json). It applies the shared Helium
patches, the Windows patch series, and the Breezer overlays before compiling.
Breezer keeps Windows DPAPI encryption and Chromium's download warning handling.

The Windows candidate includes the workspace sidebar, new tab and browser
settings. The bundled assistant, Organato integration and in-app updater depend
on the macOS helper. On Windows, choose **Import browser data** for Firefox
passwords. Other password sources use the native CSV importer. See
[password import and management](passwords.md).

## Set up the build machine

- Use an x64 Windows 10 or 11 PC and a short path on an NTFS drive. Chromium
  requires at least 100 GB of free space and recommends more than 16 GB of RAM.
- Install Visual Studio 2026 with **Desktop development with C++** and the x64
  ATL/MFC component. Install the Windows SDK 10.0.28000.2270 (its headers are in
  `Include\10.0.28000.0`) and the SDK Debugging Tools 10.0.26100.3323 or later.
  See the [Chromium Windows build instructions at the pinned revision](https://github.com/chromium/chromium/blob/156.0.8078.47/docs/windows_build_instructions.md).
- Install Git for Windows, a recent system installation of 7-Zip with Zstandard
  support, and Python 3.12 on `PATH`. Make `python` and `python3` resolve to the
  same installation. Enable Windows long paths and use a build account that
  can create symbolic links. See the [pinned Helium Windows instructions](https://github.com/imputnet/helium-windows/tree/0.20.1.1#building).

## Build and package

From PowerShell in the Breezer checkout, set a dedicated build directory. Use
`fetch` when you want to download and verify inputs before preparing the source.

```powershell
$env:PYTHONUTF8 = '1'
python -m pip install requests Pillow
$Build = 'B:\BreezerBuild\windows-x64'
python -u script/windows/build_breezer.py prepare --build-dir $Build
python -u script/windows/build_breezer.py build --build-dir $Build -j 4
python -u script/windows/build_breezer.py package --build-dir $Build
```

`prepare` saves verified downloads in `download_cache` and writes the patched
Chromium tree to `src`. If preparation fails, the incomplete source stays in a
`src-preparing-*` directory for diagnosis. A retry reuses the download cache.
`build --gen-only` checks the overlays and generates the Ninja build graph without
compiling. A regular `build` retries unfinished work using the same output tree
in `src\out\Default`.

The `artifacts` directory contains `Breezer-Windows-x64-Setup.exe`, Chromium's
native mini installer built with the Breezer payload, and `Breezer-Windows-x64.zip`.
Each has a `.sha256` sidecar. The local artifacts are unsigned. Use `--output-dir`
with a new path to package the same build again. To run the ZIP build, extract
the entire archive and open `chrome.exe` in the extracted directory.

```powershell
Get-FileHash "$Build\artifacts\Breezer-Windows-x64-Setup.exe" -Algorithm SHA256
Get-Content "$Build\artifacts\Breezer-Windows-x64-Setup.exe.sha256"
```

Run `python tests/windows/build_breezer_test.py` to verify the packaging workflow
against synthetic build outputs. Use the [Windows import smoke test](passwords.md#windows-import-smoke)
with the compiled browser and its matching ChromeDriver on a Windows desktop.

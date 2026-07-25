# ExtraHop Admin Tools — Start Here

This folder contains everything needed to run ExtraHop Admin Tools on macOS or Linux. The application runs only on your computer and opens in your normal browser.

## Start on macOS

1. Extract the ZIP.
2. Double-click **START-HERE.command**.
3. Keep the Terminal window open while using the application.

If macOS blocks the first launch, Control-click **START-HERE.command**, choose **Open**, and confirm once.

## Start on Linux

Open a terminal in this extracted folder and run:

```bash
./start.sh
```

If the file is not executable, run `chmod +x start.sh` once and retry.

## What happens on the first launch

- Python 3.10 or newer is required.
- The launcher creates a private runtime under your user account.
- It downloads tested Python dependencies and the Chromium browser used for PDF export.
- The first launch therefore needs internet access and can take several minutes.
- Later launches reuse the private runtime and start much faster.

The launcher prints and opens a URL such as `http://127.0.0.1:8000`. Use that URL only. **Do not open files inside the `app` folder or open `index.html` directly.**

Press **Ctrl+C** in the launcher window to stop the application.

## Connect to ExtraHop

Choose RevealX 360 or RevealX Enterprise and enter the requested credentials. Credentials are held by the local Python service, are not sent to a third-party proxy, and are not saved in browser storage.

Enterprise TLS certificates are verified by default. Enable **Allow an untrusted or self-signed TLS certificate** only for a lab appliance you recognize and trust.

## Troubleshooting

### “Failed to fetch” or “Local Backend Unreachable”

The browser cannot reach the local launcher service.

1. Close any page opened directly from the `app` folder.
2. Confirm the launcher Terminal is still open.
3. Run `START-HERE.command` or `./start.sh` again.
4. Use the exact `http://127.0.0.1:PORT` URL printed by the launcher.

### Collect safe diagnostics

macOS or Linux:

```bash
./start.sh --diagnostics
```

The report includes versions, paths, dependency health, and recent server startup messages. It intentionally omits credentials and API-response log contents.

### Rebuild the private runtime

```bash
./start.sh --reset-runtime
```

Use this if dependency installation was interrupted or diagnostics report a broken private runtime.

### PDF export is unavailable

Start again without `--skip-pdf-setup`. On some Linux distributions, Playwright may also require operating-system browser libraries that an administrator must install.

## Chart themes

System Health charts export as PNGs sized for slide decks. Open **Chart theme** above the charts to switch between the built-in themes or set exact colors, then export.

Themes you save are written to the `chart-themes` folder beside this file, one small JSON file each. Copy that folder to back up your themes or to give them to someone else — drop the files into their `chart-themes` folder and they appear in the picker.

## Logs and privacy

The launcher prints the writable log directory during startup and diagnostics.

- `server.log` contains local startup and request status messages.
- `api-responses.jsonl` is created only when API Logging is enabled in the UI.
- **Full** API logging can contain sensitive operational data even though credential-shaped fields are redacted. Review logs before sharing them.

## Launcher options

```text
--no-browser       Do not open the browser automatically
--port PORT        Use a specific local port
--diagnostics      Print safe diagnostics and exit
--reset-runtime    Rebuild this package version's private runtime
--skip-pdf-setup   Skip the optional Chromium download
--help             Show launcher help
```

Package version: see `VERSION`.

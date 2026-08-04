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

### Windows Subsystem for Linux (WSL 2)

Run `./start.sh` inside WSL, keep that terminal open, and open the printed URL in
the Windows browser. The launcher automatically listens on the WSL virtual
network interface so Windows localhost forwarding and explicit port proxies can
reach it; native Linux and macOS launches remain loopback-only.

## What happens on the first launch

- Python 3.10 or newer is required.
- The launcher creates a private runtime under your user account.
- It downloads tested Python dependencies and the Chromium browser used for PDF export.
- The first launch therefore needs internet access and can take several minutes.
- Later launches reuse the private runtime and start much faster.

The launcher prints and opens a URL such as `http://127.0.0.1:8000`. Use that URL only. **Do not open files inside the `app` folder or open `index.html` directly.**

Press **Ctrl+C** in the launcher window to stop the application.

## Work locally or connect

The app is useful before you connect to ExtraHop. In the local workspace you can:

- open **Datafeed Analysis** to upload, analyze, review, and export a classic PCAP;
- open **System Health** to load a unified summary CSV and use its charts, findings, detail table,
  CSV, PNG, PDF, and PowerPoint outputs.

Packetstore retrieval, live System Health collection, detailed API-data export, and administration
tools require a RevealX Enterprise or RevealX 360 connection. Those tools remain visible and
explain why they are disabled. Disconnecting returns the app to the local workspace rather than
making the local tools unavailable.

`Offline` describes the app's current connection state. It is not an ExtraHop deployment type and
does not imply that a connected Enterprise deployment is air-gapped. The launcher and local Python
service must stay running for local PCAP analysis, CSV import, and PDF export.

## Connect to ExtraHop

Open the connection menu and either select a saved connection or choose **Add new connection**.
New connections offer the existing RevealX 360 and RevealX Enterprise credential forms. After a
successful login, credentials are saved in macOS Keychain or Linux Secret Service. They are held
by the local Python service, are not sent to a third-party proxy, and are never saved in browser
storage.

You can also copy `.env.example` to `.env` beside this README and restart the app. The included
example shows one RevealX 360 and one Enterprise connection. A `.env` file contains plaintext
credentials, so use the operating-system credential store for normal use and protect any `.env`
file you create.

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

**Export PowerPoint** builds a turn-key, editable review deck whose native chart shapes and slide colors use the active chart theme. The optional export fields can be left empty; the app falls back to the report title, connected target, and report window.

Open **Chart theme** above the charts to switch between the built-in themes or set exact colors before exporting. Charts, titles, findings, recommendations, and appendix tables remain editable.

### PowerPoint typography

PowerPoint decks request **Source Sans 3**. Install `SourceSans3-Regular.ttf` and `SourceSans3-Bold.ttf` from the package's `fonts` folder before opening or editing a deck. PowerPoint substitutes another font when Source Sans 3 is unavailable, which can change text proportions. The browser-based deck generator does not embed fonts in the PowerPoint file.

Themes you save are written to the `chart-themes` folder beside this file, one small JSON file each. Copy that folder to back up your themes or to give them to someone else — drop the files into their `chart-themes` folder and they appear in the picker.

## Logs and privacy

The launcher prints the writable log directory during startup and diagnostics.

- `server.log` contains local startup and request status messages.
- `api-responses.jsonl` records failed API responses and network errors by default; logging can be changed or disabled in the UI.
- **Full** API logging can contain sensitive operational data even though credential-shaped fields are redacted. Review logs before sharing them.

## Datafeed Analysis

Open **Datafeed Analysis** to upload a classic PCAP without ExtraHop credentials. After connecting
to RevealX Enterprise or RevealX 360, you can also collect a bounded recent interval from the
connected system. Connected collection
requires packets to be available from Packetstore; many deployments do not include one. A
Packetstore can also receive a different feed from the Packet Sensor, so findings describe the
retrieved capture rather than proving Packet Sensor behavior.

The tool reports capture-level observations using cautious labels. Uniform short packet records
can indicate packet slicing or restricted packet access. Uploaded and downloaded captures are
temporary and are removed automatically after the job; bounded results expire after 30 minutes by
default. Packet bodies are not included in API response logs.

## System Health CSV import

Open **System Health** and choose **Load CSV** to work from a unified summary export without an
ExtraHop connection. Imported reports use the same summary, chart, finding, detail, and local export
rules as live reports, but they do not contain the raw API time-series rows needed by **All API
data**.

For safety and predictable rendering, imports are limited to 5 MiB, 1,000 sensor rows, the
canonical schema columns, 128 KiB per cell, and bounded embedded JSON. An invalid or oversized file
is rejected without replacing the report already on screen.

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

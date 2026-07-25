#!/usr/bin/env python3
"""Render Connected Appliances against a synthetic fleet and capture screenshots.

Serves the repository statically, stubs the ExtraHop API with a fixture, then
screenshots the list and topology views in both themes. Use it to eyeball
layout and to assert that the page itself never grows a scrollbar.

    python3 scripts/nodemap-visual-check.py [--out DIR] [--fixture FILE]
"""

import argparse
import functools
import http.server
import json
import pathlib
import threading

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent


def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def build_fixture():
    """A fleet shaped like the screenshot: mostly unreachable, mixed firmware."""
    models = ["EDA1100V", "EDA1100V_TRACE", "IDS1280V", "EFC1291V", "EDA6200"]
    firmwares = ["26.2.2.2005", "26.1.0.1477", "25.4.0.1102", "26.2.0.1901"]
    statuses = ["Unable to connect"] * 30 + ["Online"] * 15 + ["Requires additional configuration"] * 2

    fleet = [{
        "id": 1, "display_name": "Command Appliance", "hostname": "eca.corp.local",
        "platform": "command", "license_platform": "ECA", "firmware_version": "26.2.2.2005",
        "status_message": "Online", "uuid": "aaaa-bbbb-cccc-dddd", "product_modules": ["ndr", "npm"],
    }]

    for i in range(47):
        prefix = ["eda", "ids", "trace", "efc"][i % 4] if i % 7 == 0 else "eda"
        model = {"efc": "EFC1291V", "ids": "IDS1280V", "trace": "EDA1100V_TRACE"}.get(
            prefix, models[i % len(models)])
        fleet.append({
            "id": 100 + i,
            "display_name": f"{prefix}.range-{i:02d}.us-east-2",
            "hostname": f"host-{i}.appliance-hopcloud.extrahop",
            "platform": "discover",
            "license_platform": model,
            "firmware_version": firmwares[i % len(firmwares)],
            "status_message": statuses[i % len(statuses)],
            "uuid": f"{i:08x}-3eba-4c6e-aea3-59338d3d5981",
            "product_modules": [["ndr"], ["ndr", "npm"], ["npm"]][i % 3],
        })

    return fleet


STUB = """(fleet) => {
    window.state = window.state || {};
    window.state.connected = true;
    window.apiClient = { getAppliances: async () => fleet };
}"""

# The page must never scroll: the module owns its own scroll areas.
MEASURE = """() => {
    const main = document.querySelector('.main');
    const list = document.getElementById('listMainArea');
    const panel = document.getElementById('nodeDetailsPanelContent');
    return {
        pageScrolls: main.scrollHeight > main.clientHeight + 1,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
        rows: document.querySelectorAll('.appliance-row').length,
        groups: [...document.querySelectorAll('.group-row td')].map(td => td.textContent.trim()),
        summary: [...document.querySelectorAll('#nodemapSummary .stat')].map(s => s.textContent.trim()),
        panelOpen: document.getElementById('nodeDetailsPanel').classList.contains('is-open'),
        panelName: panel.textContent.includes('Name') ? panel.querySelector('.detail-value')?.textContent : null,
    };
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(REPO / "logs" / "nodemap-check"))
    parser.add_argument("--fixture")
    args = parser.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    fleet = json.loads(pathlib.Path(args.fixture).read_text()) if args.fixture else build_fixture()
    httpd, base = serve(REPO)
    findings = {}

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1600, "height": 950})
            page.route("**/backend/system-health/catalog",
                       lambda route: route.fulfill(status=200, content_type="application/json",
                                                   body=json.dumps({"models": []})))
            page.goto(base, wait_until="load")
            page.add_init_script("() => {}")
            page.evaluate(STUB, fleet)
            page.evaluate("() => window.moduleLoader.switchToModule('nodemap')")
            page.wait_for_selector(".appliance-row", timeout=15000)
            page.wait_for_timeout(400)

            findings["list"] = page.evaluate(MEASURE)
            page.screenshot(path=str(out / "list-light.png"))

            page.click(".appliance-row:nth-of-type(3)")
            page.wait_for_timeout(500)
            findings["list_with_panel"] = page.evaluate(MEASURE)
            page.screenshot(path=str(out / "list-details.png"))

            page.select_option("#nodemapGroupBy", "firmware")
            page.wait_for_timeout(300)
            findings["grouped_by_firmware"] = page.evaluate(MEASURE)
            page.screenshot(path=str(out / "list-by-firmware.png"))

            page.click("#nodemapViewToggle button[data-view='topology']")
            page.wait_for_timeout(700)
            findings["topology"] = page.evaluate(MEASURE)
            page.screenshot(path=str(out / "topology-light.png"))

            page.evaluate("() => document.documentElement.setAttribute('data-theme','dark')")
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / "topology-dark.png"))
            page.click("#nodemapViewToggle button[data-view='list']")
            page.wait_for_timeout(400)
            page.screenshot(path=str(out / "list-dark.png"))

            console = []
            page.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
            page.wait_for_timeout(200)
            findings["console_errors"] = console

            browser.close()
    finally:
        httpd.shutdown()

    print(json.dumps(findings, indent=2))
    print(f"\nScreenshots in {out}")


if __name__ == "__main__":
    main()

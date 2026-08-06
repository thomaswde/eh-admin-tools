#!/usr/bin/env python3
"""Query cpc lookback with a Packetstore appliance ID as a system object."""

import argparse
import getpass
import json
import os
import ssl
import time
import urllib.error
import urllib.request

MAX_RESPONSE = 1 << 20


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host", help="Console hostname or https:// URL")
    parser.add_argument("packetstore_id", type=int, help="Packetstore ID from GET /appliances")
    parser.add_argument("--ca-file", help="PEM CA bundle for an internal certificate")
    args = parser.parse_args()

    base = args.host.rstrip("/")
    if "://" not in base:
        base = f"https://{base}"
    if not base.startswith("https://"):
        parser.error("HTTPS is required")
    if base.endswith("/api/v1"):
        base = base[:-7]

    key = os.environ.get("EXTRAHOP_API_KEY") or getpass.getpass("API key: ")
    context = ssl.create_default_context(cafile=args.ca_file)

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{base}/api/v1{path}",
            data=data,
            headers={"Authorization": f"ExtraHop apikey={key}", "Content-Type": "application/json"},
            method="POST" if body is not None else "GET",
        )
        try:
            with urllib.request.urlopen(req, context=context, timeout=30) as response:
                raw = response.read(MAX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            detail = error.read(65536).decode("utf-8", "replace")
            raise SystemExit(f"HTTP {error.code}: {detail}") from error
        if len(raw) > MAX_RESPONSE:
            raise SystemExit("Response exceeded 1 MiB")
        return json.loads(raw)

    body = {
        "cycle": "auto",
        "from": -300000,
        "until": 0,
        "object_type": "system",
        "object_ids": [args.packetstore_id],
        "metric_category": "cpc",
        "metric_specs": [{"name": "est_lookback_sec"}],
    }
    first = request("/metrics", body)
    chunks = [] if isinstance(first, dict) and "xid" in first else [first]
    xid = first.get("xid") if isinstance(first, dict) else None
    if isinstance(xid, list):
        xid = xid[0] if len(xid) == 1 else None
    if xid is not None and not str(xid).isdecimal():
        raise SystemExit("Unexpected XID response")

    deadline = time.monotonic() + 120
    polls = 0
    while xid is not None:
        if polls >= 120 or time.monotonic() >= deadline:
            raise SystemExit("XID collection timed out")
        result = request(f"/metrics/next/{xid}")
        polls += 1
        if result == "again":
            time.sleep(1)
        elif result is None:
            break
        else:
            chunks.append(result)

    print(json.dumps({"request": body, "responses": chunks, "xid_polls": polls}, indent=2))


if __name__ == "__main__":
    main()

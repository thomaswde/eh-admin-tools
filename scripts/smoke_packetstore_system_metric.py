#!/usr/bin/env python3
"""Try Packetstore appliance IDs as system metric objects."""

import argparse
import getpass
import json
import os
import ssl
import time
import urllib.error
import urllib.request

MAX_RESPONSE = 1 << 20
MAX_STORES = 10


class ApiError(Exception):
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host", help="Console hostname or https:// URL")
    parser.add_argument("--limit", type=int, default=2, help="Packetstores to test (default: 2)")
    parser.add_argument("--ca-file", help="PEM CA bundle for an internal certificate")
    args = parser.parse_args()
    if not 1 <= args.limit <= MAX_STORES:
        parser.error(f"--limit must be between 1 and {MAX_STORES}")

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
            raise ApiError(f"HTTP {error.code}") from error
        if len(raw) > MAX_RESPONSE:
            raise ApiError("Response exceeded 1 MiB")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise ApiError("Invalid JSON response") from error

    try:
        appliances = request("/appliances")
    except (ApiError, urllib.error.URLError) as error:
        raise SystemExit(f"Appliance inventory failed: {error}") from error
    if not isinstance(appliances, list):
        raise SystemExit("Unexpected appliance inventory response")

    ids = []
    for appliance in appliances:
        value = appliance.get("id") if isinstance(appliance, dict) else None
        if (
            isinstance(appliance, dict)
            and appliance.get("platform") == "trace"
            and not isinstance(value, bool)
            and (isinstance(value, int) or (isinstance(value, str) and value.isdecimal()))
        ):
            ids.append(int(value))
    if not ids:
        raise SystemExit("No Packetstore IDs found")
    found = len(ids)
    ids = ids[: args.limit]

    tests = []
    for packetstore_id in ids:
        body = {
            "cycle": "auto",
            "from": -300000,
            "until": 0,
            "object_type": "system",
            "object_ids": [packetstore_id],
            "metric_category": "cpc",
            "metric_specs": [{"name": "est_lookback_sec"}],
        }
        item = {"packetstore_id": packetstore_id, "request": body}
        try:
            first = request("/metrics", body)
            chunks = [] if isinstance(first, dict) and "xid" in first else [first]
            xid = first.get("xid") if isinstance(first, dict) else None
            if isinstance(xid, list):
                xid = xid[0] if len(xid) == 1 else "invalid"
            if xid is not None and not str(xid).isdecimal():
                raise ApiError("Unexpected XID response")

            deadline = time.monotonic() + 120
            polls = 0
            while xid is not None:
                if polls >= 120 or time.monotonic() >= deadline:
                    raise ApiError("XID collection timed out")
                result = request(f"/metrics/next/{xid}")
                polls += 1
                if result == "again":
                    time.sleep(1)
                elif result is None:
                    break
                else:
                    chunks.append(result)
            item.update(responses=chunks, xid_polls=polls)
        except (ApiError, urllib.error.URLError) as error:
            item["error"] = str(error) if isinstance(error, ApiError) else type(error).__name__
        tests.append(item)

    print(json.dumps({"packetstores_found": found, "tests": tests}, indent=2))


if __name__ == "__main__":
    main()

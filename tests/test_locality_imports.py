import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.extrahop_client import ExtraHopApiError
from backend.locality_imports import (
    LocalityImportError,
    LocalityImportManager,
    LocalityImportSettings,
)


def settings(**changes):
    values = {
        "max_upload_bytes": 1024 * 1024,
        "max_rows": 100,
        "max_columns": 16,
        "max_cell_chars": 1024,
        "max_networks_per_row": 8,
        "concurrency": 2,
        "operation_deadline_seconds": 5,
        "max_jobs_per_connection": 10,
        "retention_days": 30,
        "journal_sync_rows": 2,
    }
    values.update(changes)
    return LocalityImportSettings(**values)


class ImportClient:
    def __init__(self):
        self.metadata = SimpleNamespace(
            public_dict=lambda: {"type": "enterprise", "host": "sensor.example"}
        )
        self.created = []

    async def request(self, method, endpoint, **kwargs):
        assert endpoint == "/api/v1/networklocalities"
        if method == "GET":
            return [
                {
                    "id": "9223372036854775806",
                    "name": "existing",
                    "networks": ["10.0.0.0/24"],
                }
            ]
        payload = json.loads(kwargs["body"])
        self.created.append(payload["name"])
        if payload["name"] == "bad":
            raise ExtraHopApiError("Rejected by ExtraHop", 422)
        if payload["name"] == "uncertain":
            raise ExtraHopApiError("Connection ended after send", 502)
        return {}


def test_import_parser_preserves_multiline_descriptions_and_quoted_network_lists(tmp_path):
    manager = LocalityImportManager(tmp_path, username="tester", settings=settings())
    content = (
        'Name,Network,Type,Description\r\n'
        '"Office, East","10.0.0.0/8, 192.168.0.0/16",yes,"First line\r\n'
        'Second ""quoted"" line"\r\n'
    ).encode()

    rows = manager._parse_csv(content)

    assert rows == [
        {
            "rowNumber": 2,
            "name": "Office, East",
            "networks": ["10.0.0.0/8", "192.168.0.0/16"],
            "external": True,
            "description": 'First line\r\nSecond "quoted" line',
        }
    ]


def test_import_persists_every_row_outcome_and_exports_after_restart(tmp_path):
    asyncio.run(_test_import_persists_every_row_outcome_and_exports_after_restart(tmp_path))


async def _test_import_persists_every_row_outcome_and_exports_after_restart(tmp_path):
    client = ImportClient()
    manager = LocalityImportManager(tmp_path / "cache", username="tester", settings=settings())
    content = (
        "Name,Network,Type,Description\n"
        "existing,10.1.0.0/24,internal,duplicate name\n"
        "good,10.2.0.0/24,internal,created\n"
        "same-network,10.2.0.0/24,external,duplicate upload network\n"
        ",10.3.0.0/24,internal,missing name\n"
        "bad,10.4.0.0/24,internal,rejected\n"
        "uncertain,10.5.0.0/24,external,ambiguous transport\n"
    ).encode()

    created = await manager.create("owner", client, content, filename="large.csv")
    await manager._active[created["id"]].task

    job = await manager.get(client.metadata.public_dict(), created["id"])
    assert job["state"] == "completed_with_errors"
    assert job["totalRows"] == 6
    assert job["processedRows"] == 6
    assert job["notAttempted"] == 0
    assert job["counts"] == {
        "created": 1,
        "failed": 1,
        "skipped": 2,
        "invalid": 1,
        "unknown": 1,
    }
    assert client.created == ["good", "bad", "uncertain"]

    filename, rows = manager.csv_rows(client.metadata.public_dict(), created["id"])
    exported = "".join(rows)
    assert filename.endswith("-outcomes.csv")
    assert "good,10.2.0.0/24,Internal,created,created,Created successfully." in exported
    assert "uncertain,10.5.0.0/24,External,ambiguous transport,unknown" in exported
    assert "same-network,10.2.0.0/24,External,duplicate upload network,skipped" in exported

    restarted = LocalityImportManager(tmp_path / "cache", username="tester", settings=settings())
    history = await restarted.list(client.metadata.public_dict())
    assert history["jobs"][0]["id"] == created["id"]
    assert history["jobs"][0]["counts"] == job["counts"]
    with pytest.raises(LocalityImportError) as isolated:
        await restarted.get({"type": "enterprise", "host": "other.example"}, created["id"])
    assert isolated.value.status_code == 404


class BlockingClient(ImportClient):
    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()

    async def request(self, method, endpoint, **kwargs):
        if method == "GET":
            return []
        self.started.set()
        await asyncio.Event().wait()


def test_cancelled_import_marks_inflight_rows_unknown_and_remaining_rows_not_attempted(tmp_path):
    asyncio.run(_test_cancelled_import_marks_inflight_rows_unknown_and_remaining_rows_not_attempted(tmp_path))


async def _test_cancelled_import_marks_inflight_rows_unknown_and_remaining_rows_not_attempted(tmp_path):
    client = BlockingClient()
    manager = LocalityImportManager(
        tmp_path / "cache",
        username="tester",
        settings=settings(concurrency=1),
    )
    content = b"Name,Network\nfirst,192.0.2.0/24\nsecond,198.51.100.0/24\n"
    created = await manager.create("owner", client, content)
    await asyncio.wait_for(client.started.wait(), timeout=1)
    await manager.cancel_owner("owner")

    job = await manager.get(client.metadata.public_dict(), created["id"])
    assert job["state"] == "cancelled"
    assert job["counts"]["unknown"] == 1
    assert job["notAttempted"] == 1
    _, rows = manager.csv_rows(client.metadata.public_dict(), created["id"])
    exported = "".join(rows)
    assert "first,192.0.2.0/24,Internal,,unknown" in exported
    assert "second,198.51.100.0/24,Internal,,not_attempted" in exported


@pytest.mark.parametrize(
    ("content", "status"),
    [
        (b"Name,Network\n" + b"a," + b"x" * 200 + b"\n", 422),
        (b"Name,Network\n" + b"a,10.0.0.0/24\n" * 101, 413),
    ],
)
def test_import_rejects_bounded_input_violations(tmp_path, content, status):
    manager = LocalityImportManager(tmp_path, username="tester", settings=settings(max_cell_chars=128))
    with pytest.raises(LocalityImportError) as error:
        manager._parse_csv(content)
    assert error.value.status_code == status

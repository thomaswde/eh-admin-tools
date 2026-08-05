from __future__ import annotations

import asyncio
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
from typing import Any, Iterable, Mapping
from uuid import uuid4

from backend.extrahop_client import ExtraHopApiError, ExtraHopClient
from backend.report_cache import cache_user_key, connection_cache_id, public_connection_metadata


SCHEMA_VERSION = 1
JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TERMINAL_STATES = {"completed", "completed_with_errors", "failed", "timed_out", "cancelled", "interrupted"}
RESULT_COUNTS = ("created", "failed", "skipped", "invalid", "unknown")


class LocalityImportError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class LocalityImportSettings:
    max_upload_bytes: int = 25 * 1024 * 1024
    max_rows: int = 50_000
    max_columns: int = 64
    max_cell_chars: int = 32 * 1024
    max_networks_per_row: int = 256
    concurrency: int = 4
    operation_deadline_seconds: float = 4 * 60 * 60
    max_jobs_per_connection: int = 50
    retention_days: int = 90
    journal_sync_rows: int = 25


@dataclass
class ActiveLocalityImport:
    owner: str
    connection_id: str
    directory: Path
    task: asyncio.Task[None]


class LocalityImportManager:
    def __init__(
        self,
        root: Path,
        *,
        username: str | None = None,
        settings: LocalityImportSettings | None = None,
    ) -> None:
        self.root = Path(root)
        self.user_key = cache_user_key(username)
        self.settings = settings or LocalityImportSettings()
        self._active: dict[str, ActiveLocalityImport] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        owner: str,
        client: ExtraHopClient,
        content: bytes,
        *,
        filename: str | None = None,
    ) -> dict[str, Any]:
        if len(content) > self.settings.max_upload_bytes:
            raise LocalityImportError(
                f"CSV upload exceeds the configured {self.settings.max_upload_bytes:,}-byte limit.",
                413,
            )
        rows = await asyncio.to_thread(self._parse_csv, content)
        if not rows:
            raise LocalityImportError("CSV contains no data rows.", 422)

        connection = client.metadata.public_dict()
        connection_id = connection_cache_id(connection)
        await asyncio.to_thread(self._prune, connection)
        job_id = uuid4().hex
        directory = self._connection_directory(connection) / job_id
        directory.mkdir(parents=True, exist_ok=False, mode=0o700)
        try:
            await asyncio.to_thread(self._write_source_rows, directory, rows)
            now = self._now()
            metadata = {
                "schemaVersion": SCHEMA_VERSION,
                "id": job_id,
                "filename": self._safe_filename(filename),
                "connection": public_connection_metadata(connection),
                "state": "queued",
                "createdAt": now,
                "startedAt": None,
                "finishedAt": None,
                "totalRows": len(rows),
                "processedRows": 0,
                "notAttempted": len(rows),
                "counts": {name: 0 for name in RESULT_COUNTS},
                "message": "Import is queued.",
            }
            await asyncio.to_thread(self._write_metadata, directory, metadata)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise

        task = asyncio.create_task(
            self._run_import(directory, client, rows),
            name=f"locality-import-{job_id}",
        )
        async with self._lock:
            self._active[job_id] = ActiveLocalityImport(owner, connection_id, directory, task)
        task.add_done_callback(lambda _task, value=job_id: asyncio.create_task(self._forget(value)))
        return self._public(metadata)

    async def _forget(self, job_id: str) -> None:
        async with self._lock:
            self._active.pop(job_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            tasks = [entry.task for entry in self._active.values() if not entry.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def cancel_owner(self, owner: str | None) -> None:
        if not owner:
            return
        async with self._lock:
            tasks = [
                entry.task
                for entry in self._active.values()
                if entry.owner == owner and not entry.task.done()
            ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def cancel(self, connection: Mapping[str, Any], job_id: str) -> dict[str, Any]:
        directory = self._job_directory(connection, job_id)
        async with self._lock:
            active = self._active.get(job_id)
        if active and active.connection_id == connection_cache_id(connection) and not active.task.done():
            active.task.cancel()
            await asyncio.gather(active.task, return_exceptions=True)
        metadata = await asyncio.to_thread(self._read_metadata, directory)
        return self._public(metadata)

    async def get(self, connection: Mapping[str, Any], job_id: str) -> dict[str, Any]:
        directory = self._job_directory(connection, job_id)
        metadata = await asyncio.to_thread(self._read_and_recover, directory)
        return self._public(metadata)

    async def list(self, connection: Mapping[str, Any]) -> dict[str, Any]:
        directory = self._connection_directory(connection)
        jobs = await asyncio.to_thread(self._list_jobs, directory)
        return {
            "jobs": [self._public(job) for job in jobs],
            "retentionDays": self.settings.retention_days,
            "maxJobs": self.settings.max_jobs_per_connection,
        }

    def csv_rows(
        self,
        connection: Mapping[str, Any],
        job_id: str,
    ) -> tuple[str, Iterable[str]]:
        directory = self._job_directory(connection, job_id)
        metadata = self._read_and_recover(directory)
        source_rows = self._read_json_lines(directory / "source.jsonl")
        results = {
            int(item["rowNumber"]): item
            for item in self._read_json_lines(directory / "results.jsonl")
            if isinstance(item.get("rowNumber"), int)
        }
        filename = f"network-locality-import-{job_id[:12]}-outcomes.csv"

        def generate() -> Iterable[str]:
            buffer = io.StringIO(newline="")
            writer = csv.writer(buffer, lineterminator="\r\n")

            def emit(values: list[Any]) -> str:
                buffer.seek(0)
                buffer.truncate(0)
                writer.writerow(values)
                return buffer.getvalue()

            yield emit(
                ["Row", "Name", "Networks", "Type", "Description", "Outcome", "Message"]
            )
            for source in source_rows:
                row_number = int(source["rowNumber"])
                result = results.get(row_number)
                outcome = result.get("outcome", "not_attempted") if result else "not_attempted"
                message = result.get("message", "Import ended before this row was attempted.") if result else (
                    "Import ended before this row was attempted."
                    if metadata["state"] in TERMINAL_STATES
                    else "Import has not attempted this row yet."
                )
                yield emit(
                    [
                        row_number,
                        self._csv_safe(source.get("name", "")),
                        self._csv_safe(", ".join(source.get("networks", []))),
                        "External" if source.get("external") else "Internal",
                        self._csv_safe(source.get("description", "")),
                        outcome,
                        self._csv_safe(message),
                    ]
                )

        return filename, generate()

    async def _run_import(
        self,
        directory: Path,
        client: ExtraHopClient,
        rows: list[dict[str, Any]],
    ) -> None:
        metadata = await asyncio.to_thread(self._read_metadata, directory)
        metadata.update(
            {
                "state": "running",
                "startedAt": self._now(),
                "message": "Checking existing network localities.",
            }
        )
        await asyncio.to_thread(self._write_metadata, directory, metadata)
        deadline = time.monotonic() + self.settings.operation_deadline_seconds
        result_path = directory / "results.jsonl"
        result_path.touch(mode=0o600, exist_ok=True)
        handle = result_path.open("a", encoding="utf-8", newline="\n")
        synced_rows = 0
        try:
            try:
                existing = await self._request_with_deadline(
                    client,
                    "GET",
                    "/api/v1/networklocalities",
                    deadline=deadline,
                )
                if not isinstance(existing, list):
                    raise LocalityImportError("ExtraHop returned an invalid network locality list.", 502)
            except asyncio.TimeoutError:
                metadata.update(state="timed_out", message="Timed out before existing localities could be checked.")
                return
            except Exception as error:
                metadata.update(
                    state="failed",
                    message=f"Could not check existing network localities: {self._error_message(error)}",
                )
                return

            names = {
                str(item.get("name", "")).strip().casefold()
                for item in existing
                if isinstance(item, dict) and str(item.get("name", "")).strip()
            }
            networks = {
                str(network).strip()
                for item in existing
                if isinstance(item, dict)
                for network in (item.get("networks") or [])
                if str(network).strip()
            }
            candidates: list[dict[str, Any]] = []
            for row in rows:
                validation_error = self._validate_row(row)
                if validation_error:
                    synced_rows += self._record_result(handle, metadata, row, "invalid", validation_error)
                    continue
                normalized_name = row["name"].casefold()
                duplicate_networks = sorted(set(row["networks"]) & networks)
                if normalized_name in names:
                    synced_rows += self._record_result(
                        handle,
                        metadata,
                        row,
                        "skipped",
                        "Skipped because a locality with the same name already exists.",
                    )
                    continue
                if duplicate_networks:
                    synced_rows += self._record_result(
                        handle,
                        metadata,
                        row,
                        "skipped",
                        f"Skipped because network already exists: {duplicate_networks[0]}",
                    )
                    continue
                names.add(normalized_name)
                networks.update(row["networks"])
                candidates.append(row)
                if synced_rows >= self.settings.journal_sync_rows:
                    self._sync(handle)
                    await asyncio.to_thread(self._write_metadata, directory, metadata)
                    synced_rows = 0

            metadata["message"] = f"Applying {len(candidates):,} new network localities."
            await asyncio.to_thread(self._write_metadata, directory, metadata)
            stop_message: str | None = None
            timed_out = False
            width = max(1, self.settings.concurrency)
            for start in range(0, len(candidates), width):
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                batch = candidates[start : start + width]
                for row in batch:
                    handle.write(
                        json.dumps(
                            {
                                "rowNumber": row["rowNumber"],
                                "outcome": "in_progress",
                                "message": "Request was started but has not reached a conclusive outcome.",
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
                self._sync(handle)
                tasks = [asyncio.create_task(self._create_one(client, row, deadline)) for row in batch]
                try:
                    batch_results = await asyncio.gather(*tasks)
                except asyncio.CancelledError:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    for row in batch:
                        synced_rows += self._record_result(
                            handle,
                            metadata,
                            row,
                            "unknown",
                            "Import stopped while this request was in flight; verify the row in ExtraHop before retrying.",
                        )
                    self._sync(handle)
                    await asyncio.to_thread(self._write_metadata, directory, metadata)
                    raise
                for row, outcome, message, terminal in batch_results:
                    synced_rows += self._record_result(handle, metadata, row, outcome, message)
                    if terminal and stop_message is None:
                        stop_message = message
                if synced_rows >= self.settings.journal_sync_rows:
                    self._sync(handle)
                    await asyncio.to_thread(self._write_metadata, directory, metadata)
                    synced_rows = 0
                if stop_message:
                    break

            if timed_out:
                metadata.update(state="timed_out", message="The import reached its absolute operation deadline.")
            elif stop_message:
                metadata.update(state="failed", message=f"Import stopped: {stop_message}")
            elif metadata["counts"]["failed"] or metadata["counts"]["unknown"] or metadata["counts"]["invalid"]:
                metadata.update(state="completed_with_errors", message="Import completed with outcomes that require review.")
            else:
                metadata.update(state="completed", message="Import completed.")
        except asyncio.CancelledError:
            metadata.update(state="cancelled", message="Import was cancelled; unattempted rows are identified in the outcome CSV.")
            raise
        except Exception as error:
            metadata.update(state="failed", message=f"Import failed: {self._error_message(error)}")
        finally:
            self._sync(handle)
            handle.close()
            metadata["finishedAt"] = self._now()
            metadata["notAttempted"] = max(0, metadata["totalRows"] - metadata["processedRows"])
            await asyncio.to_thread(self._write_metadata, directory, metadata)

    async def _create_one(
        self,
        client: ExtraHopClient,
        row: dict[str, Any],
        deadline: float,
    ) -> tuple[dict[str, Any], str, str, bool]:
        payload = {
            "name": row["name"],
            "networks": row["networks"],
            "external": row["external"],
            "description": row["description"],
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            await self._request_with_deadline(
                client,
                "POST",
                "/api/v1/networklocalities",
                deadline=deadline,
                body=body,
                content_type="application/json",
            )
            return row, "created", "Created successfully.", False
        except asyncio.TimeoutError:
            return row, "unknown", "Request timed out; verify this row in ExtraHop before retrying.", False
        except ExtraHopApiError as error:
            message = self._error_message(error)
            if error.status_code == 401:
                return row, "failed", message, True
            if error.status_code >= 500:
                return row, "unknown", f"{message} Verify this row in ExtraHop before retrying.", False
            return row, "failed", message, False
        except Exception as error:
            return row, "unknown", f"{self._error_message(error)} Verify this row in ExtraHop before retrying.", False

    async def _request_with_deadline(
        self,
        client: ExtraHopClient,
        method: str,
        endpoint: str,
        *,
        deadline: float,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> Any:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError
        return await asyncio.wait_for(
            client.request(method, endpoint, body=body, content_type=content_type),
            timeout=remaining,
        )

    def _record_result(
        self,
        handle: io.TextIOBase,
        metadata: dict[str, Any],
        row: dict[str, Any],
        outcome: str,
        message: str,
    ) -> int:
        result = {
            "rowNumber": row["rowNumber"],
            "outcome": outcome,
            "message": message,
        }
        handle.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        metadata["counts"][outcome] += 1
        metadata["processedRows"] += 1
        metadata["notAttempted"] = metadata["totalRows"] - metadata["processedRows"]
        return 1

    def _parse_csv(self, content: bytes) -> list[dict[str, Any]]:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise LocalityImportError("CSV must be UTF-8 encoded.", 422) from error
        try:
            reader = csv.reader(io.StringIO(text, newline=""), strict=True)
            header = next(reader, None)
            if header is None:
                return []
            if len(header) > self.settings.max_columns:
                raise LocalityImportError("CSV contains too many columns.", 422)
            normalized_header = [str(value).strip().casefold() for value in header]
            name_index = self._header_index(normalized_header, ("name",))
            network_index = self._header_index(normalized_header, ("cidr", "ip", "network"))
            external_index = self._header_index(normalized_header, ("external", "type"), required=False)
            description_index = self._header_index(normalized_header, ("description", "desc"), required=False)
            rows: list[dict[str, Any]] = []
            for row_number, columns in enumerate(reader, 2):
                if not any(columns):
                    continue
                if len(columns) > self.settings.max_columns:
                    raise LocalityImportError(f"CSV row {row_number} contains too many columns.", 422)
                if any(len(value) > self.settings.max_cell_chars for value in columns):
                    raise LocalityImportError(f"CSV row {row_number} contains an oversized cell.", 422)
                if len(rows) >= self.settings.max_rows:
                    raise LocalityImportError(
                        f"CSV exceeds the configured {self.settings.max_rows:,}-row limit.",
                        413,
                    )
                network_text = self._column(columns, network_index).strip()
                networks = [value.strip() for value in network_text.split(",") if value.strip()]
                if len(networks) > self.settings.max_networks_per_row:
                    raise LocalityImportError(
                        f"CSV row {row_number} exceeds the {self.settings.max_networks_per_row}-network limit.",
                        422,
                    )
                external_text = self._column(columns, external_index).strip().casefold()
                rows.append(
                    {
                        "rowNumber": row_number,
                        "name": self._column(columns, name_index).strip(),
                        "networks": networks,
                        "external": external_text in {"true", "external", "1", "yes"},
                        "description": self._column(columns, description_index).strip(),
                    }
                )
            return rows
        except csv.Error as error:
            raise LocalityImportError(f"CSV is malformed: {error}", 422) from error

    @staticmethod
    def _header_index(header: list[str], fragments: tuple[str, ...], *, required: bool = True) -> int | None:
        index = next((i for i, value in enumerate(header) if any(fragment in value for fragment in fragments)), None)
        if index is None and required:
            labels = " and ".join(value.upper() for value in fragments[:2])
            raise LocalityImportError(f"CSV must contain {labels} columns.", 422)
        return index

    @staticmethod
    def _column(columns: list[str], index: int | None) -> str:
        return "" if index is None or index >= len(columns) else str(columns[index])

    @staticmethod
    def _validate_row(row: Mapping[str, Any]) -> str | None:
        if not str(row.get("name", "")).strip():
            return "Name is required."
        if not row.get("networks"):
            return "At least one IP address or CIDR block is required."
        return None

    def _connection_directory(self, connection: Mapping[str, Any]) -> Path:
        return self.root / self.user_key / connection_cache_id(connection) / "locality-imports"

    def _job_directory(self, connection: Mapping[str, Any], job_id: str) -> Path:
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise LocalityImportError("Locality import was not found.", 404)
        directory = self._connection_directory(connection) / job_id
        if not directory.is_dir():
            raise LocalityImportError("Locality import was not found.", 404)
        return directory

    def _list_jobs(self, directory: Path) -> list[dict[str, Any]]:
        if not directory.is_dir():
            return []
        jobs = []
        for job_directory in directory.iterdir():
            if not job_directory.is_dir() or not JOB_ID_PATTERN.fullmatch(job_directory.name):
                continue
            try:
                jobs.append(self._read_and_recover(job_directory))
            except LocalityImportError:
                continue
        return sorted(jobs, key=lambda item: item.get("createdAt", ""), reverse=True)

    def _read_and_recover(self, directory: Path) -> dict[str, Any]:
        metadata = self._read_metadata(directory)
        active = self._active.get(str(metadata.get("id")))
        if active is not None and not active.task.done():
            return metadata
        changed = False
        if metadata.get("state") in {"queued", "running"}:
            metadata.update(
                state="interrupted",
                finishedAt=self._now(),
                message="The app stopped before the import finished; unattempted rows are identified in the outcome CSV.",
            )
            changed = True

        results_path = directory / "results.jsonl"
        latest = {
            int(item["rowNumber"]): item
            for item in self._read_json_lines(results_path)
            if isinstance(item.get("rowNumber"), int)
        }
        in_progress = [item for item in latest.values() if item.get("outcome") == "in_progress"]
        if metadata.get("state") in TERMINAL_STATES and in_progress:
            with results_path.open("a", encoding="utf-8", newline="\n") as handle:
                for item in in_progress:
                    replacement = {
                        "rowNumber": item["rowNumber"],
                        "outcome": "unknown",
                        "message": "The app stopped while this request was in flight; verify the row in ExtraHop before retrying.",
                    }
                    handle.write(json.dumps(replacement, ensure_ascii=False, separators=(",", ":")) + "\n")
                    latest[int(item["rowNumber"])] = replacement
                self._sync(handle)
            changed = True

        counts = {name: 0 for name in RESULT_COUNTS}
        for item in latest.values():
            outcome = item.get("outcome")
            if outcome in counts:
                counts[outcome] += 1
        processed_rows = sum(counts.values())
        if metadata.get("counts") != counts or metadata.get("processedRows") != processed_rows:
            metadata["counts"] = counts
            metadata["processedRows"] = processed_rows
            changed = True
        not_attempted = max(0, metadata["totalRows"] - processed_rows)
        if metadata.get("notAttempted") != not_attempted:
            metadata["notAttempted"] = not_attempted
            changed = True
        if changed:
            self._write_metadata(directory, metadata)
        return metadata

    def _read_metadata(self, directory: Path) -> dict[str, Any]:
        try:
            metadata = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise LocalityImportError("Locality import record is unavailable.", 404) from error
        if metadata.get("schemaVersion") != SCHEMA_VERSION or metadata.get("id") != directory.name:
            raise LocalityImportError("Locality import record is invalid.", 404)
        return metadata

    def _write_source_rows(self, directory: Path, rows: list[dict[str, Any]]) -> None:
        content = "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows
        ).encode("utf-8")
        self._write_atomic(directory / "source.jsonl", content)

    def _write_metadata(self, directory: Path, metadata: Mapping[str, Any]) -> None:
        content = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self._write_atomic(directory / "job.json", content)

    @staticmethod
    def _write_atomic(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temp_path = Path(temp_name)
        try:
            os.chmod(temp_path, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            temp_path.replace(path)
            os.chmod(path, 0o600)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _read_json_lines(path: Path) -> list[dict[str, Any]]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                lines = [line for line in handle if line.strip()]
        except FileNotFoundError:
            return []
        except OSError as error:
            raise LocalityImportError("Locality import outcomes are unavailable.", 500) from error
        items = []
        for index, line in enumerate(lines):
            try:
                item = json.loads(line)
            except json.JSONDecodeError as error:
                if index == len(lines) - 1:
                    break
                raise LocalityImportError("Locality import outcomes are unavailable.", 500) from error
            if isinstance(item, dict):
                items.append(item)
        return items

    def _prune(self, connection: Mapping[str, Any]) -> None:
        directory = self._connection_directory(connection)
        if not directory.is_dir():
            return
        now = datetime.now(timezone.utc)
        retained: list[tuple[str, Path]] = []
        for job_directory in directory.iterdir():
            if not job_directory.is_dir() or not JOB_ID_PATTERN.fullmatch(job_directory.name):
                continue
            try:
                metadata = self._read_and_recover(job_directory)
                created = datetime.fromisoformat(str(metadata["createdAt"]).replace("Z", "+00:00"))
            except (LocalityImportError, KeyError, ValueError):
                continue
            if metadata.get("state") in TERMINAL_STATES and now - created > timedelta(days=self.settings.retention_days):
                shutil.rmtree(job_directory, ignore_errors=True)
                continue
            retained.append((str(metadata.get("createdAt", "")), job_directory))
        retained.sort(reverse=True)
        for _, job_directory in retained[self.settings.max_jobs_per_connection - 1 :]:
            try:
                metadata = self._read_metadata(job_directory)
            except LocalityImportError:
                continue
            if metadata.get("state") in TERMINAL_STATES:
                shutil.rmtree(job_directory, ignore_errors=True)

    @staticmethod
    def _sync(handle: io.TextIOBase) -> None:
        handle.flush()
        os.fsync(handle.fileno())

    @staticmethod
    def _safe_filename(filename: str | None) -> str:
        name = Path(str(filename or "network-localities.csv")).name.strip()
        return name[:255] or "network-localities.csv"

    @staticmethod
    def _csv_safe(value: Any) -> str:
        text = str(value or "")
        return f"'{text}" if text.startswith(("=", "+", "-", "@")) else text

    @staticmethod
    def _error_message(error: Exception) -> str:
        message = str(error).strip() or error.__class__.__name__
        return message[:1000]

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _public(metadata: Mapping[str, Any]) -> dict[str, Any]:
        job_id = str(metadata["id"])
        return {
            key: metadata.get(key)
            for key in (
                "id",
                "filename",
                "state",
                "createdAt",
                "startedAt",
                "finishedAt",
                "totalRows",
                "processedRows",
                "notAttempted",
                "counts",
                "message",
            )
        } | {"resultsUrl": f"/backend/network-localities/imports/{job_id}/results.csv"}

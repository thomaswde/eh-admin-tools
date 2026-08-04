from __future__ import annotations

import asyncio
import csv
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from io import StringIO
import ipaddress
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import threading
import time
from typing import Any, AsyncIterator, Callable, Iterable

from backend.extrahop_client import ExtraHopApiError, ExtraHopClient

from .analyzer import (
    AnalysisCancelled,
    AnalysisProgress,
    AnalysisResult,
    AnalyzerLimits,
    PcapAnalysisError,
    analyze_pcaps,
)


MIB = 1024 * 1024
TERMINAL_STATES = {"completed", "failed", "cancelled"}
FINDING_ALIASES = {
    "reverse": "reverse_not_observed",
    "truncated": "capture_truncated",
    "sequence": "sequence_gap",
}
DASHBOARD_ROW_LIMIT = 25
CSV_SCOPES = frozenset({"all_findings", "reverse_not_observed", "sequence_gap"})
DEVICE_RESULT_FIELDS = ("id", "node_id", "display_name", "default_name", "ipaddr4", "ipaddr6")


class PcapJobError(Exception):
    def __init__(self, status_code: int, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class PcapJobSettings:
    max_upload_bytes: int = 256 * MIB
    upstream_window_limit: str = "25MB"
    max_window_bytes: int = 32 * MIB
    max_total_collection_bytes: int = 256 * MIB
    min_window_seconds: int = 5
    max_window_seconds: int = 300
    default_window_seconds: int = 30
    max_windows: int = 20
    max_interval_ms: int = 10 * 60 * 1000
    operation_deadline_seconds: int = 10 * 60
    retention_seconds: int = 30 * 60
    max_jobs: int = 8
    max_concurrent_jobs: int = 1
    max_result_page: int = 500
    max_enrichment_addresses: int = 2_000
    enrichment_batch_size: int = 50
    enrichment_page_size: int = 500
    max_enrichment_pages: int = 100
    max_enrichment_rows: int = 10_000
    enrichment_deadline_seconds: int = 30
    max_device_name_chars: int = 256
    analyzer_limits: AnalyzerLimits = field(
        default_factory=lambda: AnalyzerLimits(
            max_packets=2_000_000,
            max_flows=50_000,
            max_findings=50_000,
            max_sequence_intervals=200_000,
            max_record_bytes=4 * MIB,
            progress_interval=1_000,
        )
    )

    @classmethod
    def from_environment(cls) -> "PcapJobSettings":
        def integer(name: str, default: int, minimum: int = 1) -> int:
            return max(minimum, int(os.environ.get(name, default)))

        return cls(
            max_upload_bytes=integer("EH_PCAP_MAX_UPLOAD_BYTES", 256 * MIB),
            upstream_window_limit=os.environ.get("EH_PCAP_WINDOW_LIMIT", "25MB"),
            max_window_bytes=integer("EH_PCAP_MAX_WINDOW_BYTES", 32 * MIB),
            max_total_collection_bytes=integer("EH_PCAP_MAX_TOTAL_BYTES", 256 * MIB),
            min_window_seconds=integer("EH_PCAP_MIN_WINDOW_SECONDS", 5),
            max_window_seconds=integer("EH_PCAP_MAX_WINDOW_SECONDS", 300),
            default_window_seconds=integer("EH_PCAP_DEFAULT_WINDOW_SECONDS", 30),
            max_windows=integer("EH_PCAP_MAX_WINDOWS", 20),
            max_interval_ms=integer("EH_PCAP_MAX_INTERVAL_MS", 10 * 60 * 1000),
            operation_deadline_seconds=integer("EH_PCAP_DEADLINE_SECONDS", 10 * 60),
            retention_seconds=integer("EH_PCAP_RETENTION_SECONDS", 30 * 60, 60),
            max_jobs=integer("EH_PCAP_MAX_JOBS", 8),
            max_concurrent_jobs=integer("EH_PCAP_MAX_CONCURRENT_JOBS", 1),
            max_result_page=integer("EH_PCAP_MAX_RESULT_PAGE", 500),
            max_enrichment_addresses=integer("EH_PCAP_MAX_ENRICHMENT_ADDRESSES", 2_000),
            enrichment_batch_size=integer("EH_PCAP_ENRICHMENT_BATCH_SIZE", 50),
            enrichment_page_size=integer("EH_PCAP_ENRICHMENT_PAGE_SIZE", 500),
            max_enrichment_pages=integer("EH_PCAP_MAX_ENRICHMENT_PAGES", 100),
            max_enrichment_rows=integer("EH_PCAP_MAX_ENRICHMENT_ROWS", 10_000),
            enrichment_deadline_seconds=integer("EH_PCAP_ENRICHMENT_DEADLINE_SECONDS", 30),
            max_device_name_chars=integer("EH_PCAP_MAX_DEVICE_NAME_CHARS", 256),
            analyzer_limits=AnalyzerLimits(
                max_packets=integer("EH_PCAP_MAX_PACKETS", 2_000_000),
                max_flows=integer("EH_PCAP_MAX_FLOWS", 50_000),
                max_findings=integer("EH_PCAP_MAX_FINDINGS", 50_000),
                max_sequence_intervals=integer("EH_PCAP_MAX_SEQUENCE_INTERVALS", 200_000),
                max_record_bytes=integer("EH_PCAP_MAX_RECORD_BYTES", 4 * MIB),
                progress_interval=integer("EH_PCAP_PROGRESS_INTERVAL", 1_000),
            ),
        )


@dataclass
class PcapJob:
    id: str
    owner_session: str
    source_type: str
    created_at: float
    expires_at: float
    temp_dir: Path
    deadline: float
    state: str = "queued"
    completeness: str = "not_applicable"
    started_at: float | None = None
    completed_at: float | None = None
    progress: dict[str, Any] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)
    collection: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    error: dict[str, Any] | None = None
    result: AnalysisResult | None = None
    rows: list[dict[str, Any]] = field(default_factory=list)
    enrichment: dict[str, Any] = field(default_factory=dict)
    dashboard: dict[str, Any] | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task[None] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


def _utc_iso(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _camel_name(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        return {_camel_name(str(key)): _json_value(child) for key, child in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(child) for child in value]
    if isinstance(value, Path):
        return value.name
    return value


def _neutralize_csv(value: Any, *, numeric: bool = False) -> Any:
    if value is None:
        return ""
    if numeric or isinstance(value, (int, float)):
        return value
    text = str(value)
    return f"'{text}" if text.startswith(("=", "+", "-", "@")) else text


class PcapJobManager:
    def __init__(
        self,
        state_dir: Path,
        *,
        settings: PcapJobSettings | None = None,
        analyzer: Callable[..., AnalysisResult] = analyze_pcaps,
    ) -> None:
        self.state_dir = Path(state_dir)
        self.settings = settings or PcapJobSettings.from_environment()
        self.analyzer = analyzer
        self._jobs: dict[str, PcapJob] = {}
        self._semaphore = asyncio.Semaphore(self.settings.max_concurrent_jobs)

    async def startup(self) -> None:
        runtime_parent = self.state_dir.parent.resolve()
        resolved = self.state_dir.resolve()
        if resolved == runtime_parent or runtime_parent not in resolved.parents:
            raise RuntimeError("PCAP analyzer state directory is unsafe")
        await asyncio.to_thread(shutil.rmtree, resolved, True)
        resolved.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(resolved, 0o700)
        self._jobs.clear()

    async def shutdown(self) -> None:
        jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel_event.set()
            if job.task and not job.task.done() and job.state != "analyzing":
                job.task.cancel()
        tasks = [job.task for job in jobs if job.task]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.to_thread(shutil.rmtree, self.state_dir, True)
        self._jobs.clear()

    async def create_upload(
        self,
        owner_session: str,
        client: ExtraHopClient | None,
        chunks: AsyncIterator[bytes],
        *,
        declared_length: int | None,
    ) -> dict[str, Any]:
        if declared_length is not None and declared_length > self.settings.max_upload_bytes:
            raise PcapJobError(413, self._upload_limit_message())
        job = await self._new_job(owner_session, "upload")
        job.state = "uploading"
        job.progress = {"stage": "uploading", "bytesReceived": 0}
        destination = job.temp_dir / "input.pcap"
        total = 0
        try:
            with destination.open("xb") as handle:
                os.chmod(destination, 0o600)
                async for chunk in chunks:
                    if job.cancel_event.is_set():
                        raise AnalysisCancelled("Upload cancelled")
                    if time.monotonic() >= job.deadline:
                        raise PcapJobError(408, "The Datafeed Analysis operation deadline was reached during upload.")
                    total += len(chunk)
                    if total > self.settings.max_upload_bytes:
                        raise PcapJobError(413, self._upload_limit_message())
                    handle.write(chunk)
                    with job.lock:
                        job.progress["bytesReceived"] = total
            if job.cancel_event.is_set():
                raise AnalysisCancelled("Upload cancelled")
            if total == 0:
                raise PcapJobError(400, "The uploaded PCAP is empty.")
        except BaseException:
            await self._discard_job(job)
            raise

        job.source = {"type": "upload", "bytes": total}
        job.task = asyncio.create_task(self._run_upload(job, destination, client))
        return self.snapshot(job)

    async def create_collection(
        self,
        owner_session: str,
        client: ExtraHopClient,
        *,
        from_ms: int,
        until_ms: int,
        window_seconds: int | None,
    ) -> dict[str, Any]:
        windows = self._plan_windows(from_ms, until_ms, window_seconds)
        job = await self._new_job(owner_session, "extrahop")
        job.source = {
            "type": "extrahop",
            "deploymentType": client.metadata.type,
            "fromMs": from_ms,
            "untilMs": until_ms,
        }
        job.collection = {
            "plannedWindows": len(windows),
            "successfulWindows": 0,
            "emptyWindows": 0,
            "failedWindows": 0,
            "skippedWindows": 0,
            "bytesCollected": 0,
            "windows": [],
        }
        job.task = asyncio.create_task(self._run_collection(job, client, windows))
        return self.snapshot(job)

    def get(self, owner_session: str, job_id: str) -> dict[str, Any]:
        return self.snapshot(self._owned_job(owner_session, job_id))

    def results(
        self,
        owner_session: str,
        job_id: str,
        *,
        offset: int,
        limit: int,
        finding: str | None,
    ) -> dict[str, Any]:
        job = self._owned_job(owner_session, job_id)
        if job.state != "completed":
            raise PcapJobError(409, "Results are available only after the analysis completes.")
        rows = job.rows
        normalized_finding = FINDING_ALIASES.get(finding or "", finding)
        if normalized_finding:
            rows = [row for row in rows if normalized_finding in row.get("findingKinds", [])]
        else:
            rows = [row for row in rows if row.get("findingKinds")]
        safe_offset = max(0, offset)
        safe_limit = max(1, min(limit, self.settings.max_result_page))
        return {
            "items": rows[safe_offset : safe_offset + safe_limit],
            "total": len(rows),
            "offset": safe_offset,
            "limit": safe_limit,
        }

    def csv_rows(
        self,
        owner_session: str,
        job_id: str,
        *,
        scope: str = "all_findings",
    ) -> tuple[str, Iterable[str]]:
        job = self._owned_job(owner_session, job_id)
        if job.state != "completed":
            raise PcapJobError(409, "CSV is available only after the analysis completes.")
        if scope not in CSV_SCOPES:
            raise PcapJobError(422, "The requested CSV scope is not supported.")
        if scope == "all_findings":
            selected_rows = (row for row in job.rows if row.get("findingKinds"))
            filename_kind = "all-findings"
        else:
            selected_rows = (row for row in job.rows if scope in row.get("findingKinds", ()))
            filename_kind = "unidirectional-flows" if scope == "reverse_not_observed" else "sequence-gaps"
        columns = (
            "ipVersion",
            "protocol",
            "sourceAddress",
            "sourceDeviceName",
            "sourceDeviceMatchStatus",
            "sourcePort",
            "destinationAddress",
            "destinationDeviceName",
            "destinationDeviceMatchStatus",
            "destinationPort",
            "packetCount",
            "capturedBytes",
            "originalBytes",
            "truncatedPackets",
            "reverseObserved",
            "connectionEpochs",
            "sequenceGapObservations",
            "sequenceGapBytes",
            "firstTimestamp",
            "lastTimestamp",
            "findings",
        )
        numeric = {
            "ipVersion",
            "sourcePort",
            "destinationPort",
            "packetCount",
            "capturedBytes",
            "originalBytes",
            "truncatedPackets",
            "connectionEpochs",
            "sequenceGapObservations",
            "sequenceGapBytes",
            "firstTimestamp",
            "lastTimestamp",
        }

        def lines() -> Iterable[str]:
            buffer = StringIO()
            writer = csv.writer(buffer, lineterminator="\r\n")
            writer.writerow(columns)
            yield buffer.getvalue()
            for row in selected_rows:
                buffer.seek(0)
                buffer.truncate(0)
                writer.writerow(
                    [
                        _neutralize_csv(
                            self._csv_value(row, column),
                            numeric=column in numeric,
                        )
                        for column in columns
                    ]
                )
                yield buffer.getvalue()

        return f"datafeed-analysis-{filename_kind}-{job.id[:12]}.csv", lines()

    @staticmethod
    def _csv_value(row: dict[str, Any], column: str) -> Any:
        if column == "findings":
            return ",".join(row.get("findingKinds", []))
        if column.startswith("sourceDevice"):
            device = row.get("sourceDevice") or {}
            return device.get("displayName" if column.endswith("Name") else "matchStatus")
        if column.startswith("destinationDevice"):
            device = row.get("destinationDevice") or {}
            return device.get("displayName" if column.endswith("Name") else "matchStatus")
        return row.get(column)

    async def cancel(self, owner_session: str, job_id: str) -> dict[str, Any]:
        job = self._owned_job(owner_session, job_id)
        if job.state in TERMINAL_STATES:
            return self.snapshot(job)
        job.cancel_event.set()
        if job.task and not job.task.done() and job.state != "analyzing":
            job.task.cancel()
        return self.snapshot(job)

    async def cancel_owner(self, owner_session: str | None) -> None:
        if not owner_session:
            return
        owned = [job for job in self._jobs.values() if secrets.compare_digest(job.owner_session, owner_session)]
        for job in owned:
            job.cancel_event.set()
            if job.task and not job.task.done() and job.state != "analyzing":
                job.task.cancel()
        tasks = [job.task for job in owned if job.task]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for job in owned:
            self._jobs.pop(job.id, None)
            await self._cleanup_files(job)

    async def cancel_owner_collections(self, owner_session: str | None) -> None:
        if not owner_session:
            return
        owned = [
            job
            for job in self._jobs.values()
            if job.source_type == "extrahop"
            and job.state not in TERMINAL_STATES
            and secrets.compare_digest(job.owner_session, owner_session)
        ]
        for job in owned:
            job.cancel_event.set()
            if job.task and not job.task.done() and job.state != "analyzing":
                job.task.cancel()
        tasks = [job.task for job in owned if job.task]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def snapshot(self, job: PcapJob) -> dict[str, Any]:
        with job.lock:
            summary = _json_value(job.result.summary) if job.result else None
            progress = dict(job.progress)
            warnings = list(dict.fromkeys([*job.warnings, *(job.result.summary.warnings if job.result else ())]))
            return {
                "id": job.id,
                "sourceType": job.source_type,
                "state": job.state,
                "completeness": job.completeness,
                "createdAt": _utc_iso(job.created_at),
                "startedAt": _utc_iso(job.started_at),
                "completedAt": _utc_iso(job.completed_at),
                "expiresAt": _utc_iso(job.expires_at),
                "progress": progress,
                "source": dict(job.source),
                "collection": _json_value(job.collection),
                "warnings": warnings,
                "error": dict(job.error) if job.error else None,
                "summary": summary,
                "resultCount": len(job.rows),
                "enrichment": _json_value(job.enrichment),
                "dashboard": _json_value(job.dashboard),
            }

    async def _new_job(self, owner_session: str, source_type: str) -> PcapJob:
        await self._prune_expired()
        active = sum(job.state not in TERMINAL_STATES for job in self._jobs.values())
        if active >= self.settings.max_jobs:
            raise PcapJobError(429, "Too many Datafeed Analysis jobs are already active.")
        if len(self._jobs) >= self.settings.max_jobs:
            terminal = sorted(
                (job for job in self._jobs.values() if job.state in TERMINAL_STATES),
                key=lambda item: item.completed_at or item.created_at,
            )
            while terminal and len(self._jobs) >= self.settings.max_jobs:
                discarded = terminal.pop(0)
                self._jobs.pop(discarded.id, None)
                await self._cleanup_files(discarded)
        if len(self._jobs) >= self.settings.max_jobs:
            raise PcapJobError(429, "The Datafeed Analysis job limit has been reached.")
        job_id = secrets.token_urlsafe(24)
        temp_dir = self.state_dir / job_id
        temp_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        os.chmod(temp_dir, 0o700)
        now = time.time()
        job = PcapJob(
            id=job_id,
            owner_session=owner_session,
            source_type=source_type,
            created_at=now,
            expires_at=now + self.settings.retention_seconds,
            temp_dir=temp_dir,
            deadline=time.monotonic() + self.settings.operation_deadline_seconds,
        )
        self._jobs[job_id] = job
        return job

    async def _run_upload(
        self,
        job: PcapJob,
        destination: Path,
        client: ExtraHopClient | None,
    ) -> None:
        async with self._semaphore:
            job.started_at = time.time()
            try:
                await self._analyze(job, [destination])
                if client is not None:
                    await self._enrich(job, client, self._upload_activity_window(job))
                job.dashboard = self._build_dashboard(job)
                job.completeness = "complete"
                self._complete(job)
            except asyncio.CancelledError:
                self._cancelled(job)
            except AnalysisCancelled:
                self._cancelled(job) if job.cancel_event.is_set() else self._deadline_failed(job)
            except PcapAnalysisError as error:
                self._failed(job, str(error), "analysis_error")
            except Exception as error:
                self._failed(job, "PCAP analysis failed.", error.__class__.__name__)
            finally:
                await self._cleanup_files(job)

    async def _run_collection(
        self,
        job: PcapJob,
        client: ExtraHopClient,
        windows: list[tuple[int, int]],
    ) -> None:
        async with self._semaphore:
            job.started_at = time.time()
            job.state = "collecting"
            captures: list[Path] = []
            terminal_error: ExtraHopApiError | None = None
            try:
                for index, (from_ms, until_ms) in enumerate(windows):
                    if job.cancel_event.is_set():
                        raise AnalysisCancelled("Collection cancelled")
                    if time.monotonic() >= job.deadline:
                        job.collection["skippedWindows"] += len(windows) - index
                        job.warnings.append("The absolute collection deadline was reached before every window completed.")
                        break
                    destination = job.temp_dir / f"window-{index:03d}.pcap"
                    window_status = {"fromMs": from_ms, "untilMs": until_ms, "status": "collecting", "bytes": 0}
                    job.collection["windows"].append(window_status)
                    job.progress = {
                        "stage": "collecting",
                        "windowsCompleted": index,
                        "windowsTotal": len(windows),
                        "bytesCollected": job.collection["bytesCollected"],
                    }
                    try:
                        remaining_bytes = self.settings.max_total_collection_bytes - job.collection["bytesCollected"]
                        if remaining_bytes <= 0:
                            job.collection["skippedWindows"] += len(windows) - index
                            job.warnings.append(
                                "The total collection byte limit was reached; remaining windows were skipped."
                            )
                            break
                        response = await client.download_to_file(
                            "POST",
                            "/api/v1/packets/search",
                            destination=destination,
                            json_body={
                                "always_return_body": False,
                                "from": str(from_ms),
                                "until": str(until_ms),
                                "limit_bytes": self.settings.upstream_window_limit,
                                "limit_search_duration": "5m",
                                "output": "pcap",
                            },
                            max_bytes=min(self.settings.max_window_bytes, remaining_bytes),
                            deadline=job.deadline,
                            accept="application/vnd.tcpdump.pcap, application/octet-stream",
                        )
                    except ExtraHopApiError as error:
                        window_status["status"] = "failed"
                        window_status["error"] = str(error)
                        job.collection["failedWindows"] += 1
                        if error.status_code == 413:
                            job.collection["skippedWindows"] += len(windows) - index - 1
                            job.warnings.append(
                                "A packet-search response reached the local byte limit; remaining collection was stopped."
                            )
                            break
                        if error.status_code in {401, 402, 403, 422}:
                            terminal_error = error
                            job.collection["skippedWindows"] += len(windows) - index - 1
                            break
                        continue

                    window_status["bytes"] = response.bytes_written
                    if response.status_code == 204 or response.bytes_written == 0:
                        window_status["status"] = "empty"
                        job.collection["emptyWindows"] += 1
                        destination.unlink(missing_ok=True)
                    else:
                        window_status["status"] = "successful"
                        job.collection["successfulWindows"] += 1
                        job.collection["bytesCollected"] += response.bytes_written
                        captures.append(destination)
                    job.progress["windowsCompleted"] = index + 1
                    job.progress["bytesCollected"] = job.collection["bytesCollected"]

                if terminal_error:
                    if terminal_error.status_code == 422:
                        raise PcapJobError(
                            422,
                            "No packets are available. This deployment might not have a connected Packetstore or saved packets.",
                        )
                    raise PcapJobError(terminal_error.status_code, str(terminal_error))

                if captures:
                    await self._analyze(job, captures)
                else:
                    await self._analyze(job, [])
                await self._enrich(
                    job,
                    client,
                    (int(job.source["fromMs"]), int(job.source["untilMs"])),
                )
                job.dashboard = self._build_dashboard(job)
                incomplete = bool(job.collection["failedWindows"] or job.collection["skippedWindows"])
                job.completeness = "partial" if incomplete else "indeterminate"
                self._complete(job)
            except asyncio.CancelledError:
                self._cancelled(job)
            except AnalysisCancelled:
                self._cancelled(job) if job.cancel_event.is_set() else self._deadline_failed(job)
            except PcapJobError as error:
                self._failed(job, error.message, "collection_error", error.details)
            except PcapAnalysisError as error:
                self._failed(job, str(error), "analysis_error")
            except Exception as error:
                self._failed(job, "Packet collection or analysis failed.", error.__class__.__name__)
            finally:
                await self._cleanup_files(job)

    async def _analyze(self, job: PcapJob, captures: list[Path]) -> None:
        job.state = "analyzing"
        job.progress = {
            "stage": "analyzing",
            "filesProcessed": 0,
            "recordsSeen": 0,
            "tcpPackets": 0,
            "flowCount": 0,
        }

        def progress(update: AnalysisProgress) -> None:
            with job.lock:
                job.progress.update(_json_value(update))

        result = await asyncio.to_thread(
            self.analyzer,
            captures,
            limits=self.settings.analyzer_limits,
            cancelled=lambda: job.cancel_event.is_set() or time.monotonic() >= job.deadline,
            progress=progress,
        )
        job.result = result
        job.rows = self._build_rows(result)

    @staticmethod
    def _build_rows(result: AnalysisResult) -> list[dict[str, Any]]:
        rows = []
        for flow in result.flows:
            row = _json_value(flow)
            row["protocol"] = "tcp"
            row["flowKey"] = flow.flow_key
            kinds = []
            if not flow.reverse_observed:
                kinds.append("reverse_not_observed")
            if flow.truncated_packets:
                kinds.append("capture_truncated")
            if flow.sequence_gap_observations:
                kinds.append("sequence_gap")
            row["findingKinds"] = kinds
            rows.append(row)
        return rows

    async def _enrich(
        self,
        job: PcapJob,
        client: ExtraHopClient,
        activity_window: tuple[int, int] | None,
    ) -> None:
        candidates, total_addresses = self._candidate_addresses(job.rows)
        omitted = max(0, total_addresses - len(candidates))
        job.enrichment = {
            "status": "skipped",
            "addressesConsidered": len(candidates),
            "addressesMatched": 0,
            "addressesAmbiguous": 0,
            "addressesOmitted": omitted,
            "timeConstrained": activity_window is not None,
        }
        job.state = "enriching"
        job.progress = {
            "stage": "enriching",
            "addressesCompleted": 0,
            "addressesTotal": len(candidates),
        }
        if not candidates:
            job.enrichment["status"] = "complete"
            return

        stage_deadline = min(
            job.deadline,
            time.monotonic() + self.settings.enrichment_deadline_seconds,
        )
        if stage_deadline <= time.monotonic():
            job.enrichment["status"] = "unavailable"
            return

        try:
            matches, complete = await self._collect_device_matches(
                job,
                client,
                candidates,
                activity_window,
                stage_deadline,
            )
        except AnalysisCancelled:
            raise
        except (TimeoutError, ExtraHopApiError, ValueError, TypeError, json.JSONDecodeError):
            job.enrichment["status"] = "unavailable"
            return
        except Exception:
            # Enrichment is deliberately best effort. Unexpected client or response
            # failures remain isolated from the deterministic packet analysis.
            job.enrichment["status"] = "unavailable"
            return

        matched = 0
        ambiguous = 0
        decorations: dict[str, dict[str, Any]] = {}
        for address in candidates:
            decoration = self._resolve_device_match(address, matches.get(address, []))
            if decoration is None:
                continue
            decorations[address] = decoration
            if decoration["matchStatus"] == "ambiguous":
                ambiguous += 1
            elif decoration.get("displayName"):
                matched += 1

        for row in job.rows:
            source = decorations.get(row["sourceAddress"])
            destination = decorations.get(row["destinationAddress"])
            if source is not None:
                row["sourceDevice"] = dict(source)
            if destination is not None:
                row["destinationDevice"] = dict(destination)

        job.enrichment.update(
            {
                "status": "complete" if complete and omitted == 0 else "partial",
                "addressesMatched": matched,
                "addressesAmbiguous": ambiguous,
            }
        )

    async def _collect_device_matches(
        self,
        job: PcapJob,
        client: ExtraHopClient,
        candidates: list[str],
        activity_window: tuple[int, int] | None,
        deadline: float,
    ) -> tuple[dict[str, list[dict[str, Any]]], bool]:
        matches: dict[str, list[dict[str, Any]]] = {address: [] for address in candidates}
        seen: dict[str, set[tuple[Any, ...]]] = {address: set() for address in candidates}
        candidate_set = set(candidates)
        rows_fetched = 0
        pages_fetched = 0
        complete = True

        for batch_start in range(0, len(candidates), self.settings.enrichment_batch_size):
            batch = candidates[batch_start : batch_start + self.settings.enrichment_batch_size]
            offset = 0
            while True:
                if job.cancel_event.is_set():
                    raise AnalysisCancelled("Device enrichment cancelled")
                if pages_fetched >= self.settings.max_enrichment_pages:
                    return matches, False
                if rows_fetched >= self.settings.max_enrichment_rows:
                    return matches, False
                remaining_seconds = deadline - time.monotonic()
                if remaining_seconds <= 0:
                    raise TimeoutError("Device enrichment deadline reached")

                payload: dict[str, Any] = {
                    "filter": {
                        "operator": "or",
                        "rules": [
                            {"field": "ipaddr", "operand": address, "operator": "="} for address in batch
                        ],
                    },
                    "limit": self.settings.enrichment_page_size,
                    "offset": offset,
                    "result_fields": list(DEVICE_RESULT_FIELDS),
                }
                if activity_window is not None:
                    payload["active_from"], payload["active_until"] = activity_window

                try:
                    response = await asyncio.wait_for(
                        client.request(
                            "POST",
                            "/api/v1/devices/search",
                            body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                            content_type="application/json",
                        ),
                        timeout=remaining_seconds,
                    )
                    devices = (
                        response
                        if isinstance(response, list)
                        else response.get("devices")
                        if isinstance(response, dict)
                        else None
                    )
                    if not isinstance(devices, list) or not all(isinstance(device, dict) for device in devices):
                        raise ValueError("Device search returned an invalid response shape")
                except AnalysisCancelled:
                    raise
                except Exception:
                    if pages_fetched:
                        return matches, False
                    raise
                pages_fetched += 1

                remaining_rows = self.settings.max_enrichment_rows - rows_fetched
                accepted = devices[:remaining_rows]
                rows_fetched += len(accepted)
                if len(accepted) < len(devices):
                    complete = False

                for device in accepted:
                    for address in self._device_addresses(device, candidate_set):
                        identity = self._device_identity(device)
                        if identity in seen[address]:
                            continue
                        seen[address].add(identity)
                        matches[address].append(device)

                completed = min(len(candidates), batch_start + len(batch))
                job.progress.update(
                    {
                        "addressesCompleted": completed,
                        "pagesFetched": pages_fetched,
                        "rowsFetched": rows_fetched,
                    }
                )
                if len(devices) < self.settings.enrichment_page_size:
                    break
                if not complete or rows_fetched >= self.settings.max_enrichment_rows:
                    return matches, False
                offset += self.settings.enrichment_page_size

        return matches, complete

    @staticmethod
    def _device_addresses(device: dict[str, Any], candidates: set[str]) -> set[str]:
        matched: set[str] = set()
        for field_name in ("ipaddr4", "ipaddr6"):
            raw_value = device.get(field_name)
            values = raw_value if isinstance(raw_value, list) else [raw_value]
            for value in values:
                if not isinstance(value, str):
                    continue
                try:
                    address = str(ipaddress.ip_address(value.strip()))
                except ValueError:
                    continue
                if address in candidates:
                    matched.add(address)
        return matched

    @staticmethod
    def _device_identity(device: dict[str, Any]) -> tuple[Any, ...]:
        return (
            str(device.get("id")) if device.get("id") is not None else None,
            str(device.get("node_id")) if device.get("node_id") is not None else None,
            str(device.get("ipaddr4")),
            str(device.get("ipaddr6")),
            str(device.get("display_name")),
            str(device.get("default_name")),
        )

    def _resolve_device_match(
        self,
        address: str,
        devices: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        if not devices:
            return None
        named = [(device, self._meaningful_device_name(device, address)) for device in devices]
        useful = [(device, name) for device, name in named if name is not None]
        if len(devices) == 1 and useful:
            device, name = useful[0]
            decoration: dict[str, Any] = {
                "displayName": name,
                "matchStatus": "unique",
                "matchCount": 1,
            }
            if device.get("id") is not None:
                decoration["deviceId"] = str(device["id"])
            if device.get("node_id") is not None:
                decoration["nodeId"] = str(device["node_id"])
            return decoration

        normalized_names = {self._normalize_device_name(name) for _device, name in useful}
        if len(useful) == len(devices) and len(normalized_names) == 1:
            display_name = sorted((name for _device, name in useful), key=lambda item: (item.casefold(), item))[0]
            return {
                "displayName": display_name,
                "matchStatus": "common",
                "matchCount": len(devices),
            }
        if len(devices) > 1:
            return {"matchStatus": "ambiguous", "matchCount": len(devices)}
        return None

    def _meaningful_device_name(self, device: dict[str, Any], address: str) -> str | None:
        for field_name in ("display_name", "default_name"):
            value = device.get(field_name)
            if not isinstance(value, str):
                continue
            name = " ".join(value.split())
            if not name or len(name) > self.settings.max_device_name_chars:
                continue
            try:
                if str(ipaddress.ip_address(name)) == address:
                    continue
            except ValueError:
                pass
            return name
        return None

    @staticmethod
    def _normalize_device_name(name: str) -> str:
        return " ".join(name.split()).casefold()

    def _candidate_addresses(self, rows: list[dict[str, Any]]) -> tuple[list[str], int]:
        affected = [row for row in rows if row.get("findingKinds")]
        priority_rows = [
            *self._top_reverse(affected),
            *self._top_sequence_gaps(affected),
            *sorted(affected, key=lambda row: str(row.get("flowKey", ""))),
        ]
        addresses: list[str] = []
        seen: set[str] = set()
        for row in priority_rows:
            for field_name in ("sourceAddress", "destinationAddress"):
                try:
                    address = str(ipaddress.ip_address(str(row.get(field_name, ""))))
                except ValueError:
                    continue
                if address in seen:
                    continue
                seen.add(address)
                if len(addresses) < self.settings.max_enrichment_addresses:
                    addresses.append(address)
        return addresses, len(seen)

    @staticmethod
    def _top_reverse(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            (row for row in rows if "reverse_not_observed" in row.get("findingKinds", ())),
            key=lambda row: (
                -int(row.get("packetCount", 0)),
                -int(row.get("capturedBytes", 0)),
                str(row.get("flowKey", "")),
            ),
        )[:DASHBOARD_ROW_LIMIT]

    @staticmethod
    def _top_sequence_gaps(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(
            (row for row in rows if "sequence_gap" in row.get("findingKinds", ())),
            key=lambda row: (
                -int(row.get("sequenceGapBytes", 0)),
                -int(row.get("sequenceGapObservations", 0)),
                -int(row.get("packetCount", 0)),
                str(row.get("flowKey", "")),
            ),
        )[:DASHBOARD_ROW_LIMIT]

    def _build_dashboard(self, job: PcapJob) -> dict[str, Any]:
        if job.result is None:
            raise RuntimeError("A dashboard requires a completed analysis result")
        summary = job.result.summary
        return {
            "schemaVersion": 1,
            "findingCounts": {
                "affectedFlows": summary.affected_flow_count,
                "reverseNotObservedFlows": summary.reverse_not_observed_flows,
                "sequenceGapFlows": summary.sequence_gap_flow_count,
                "sequenceGapObservations": summary.sequence_gap_observations,
                "sequenceGapBytes": summary.sequence_gap_bytes,
                "truncatedFlows": summary.truncated_flow_count,
            },
            "topReverse": [dict(row) for row in self._top_reverse(job.rows)],
            "topSequenceGaps": [dict(row) for row in self._top_sequence_gaps(job.rows)],
            "enrichment": dict(job.enrichment),
        }

    @staticmethod
    def _upload_activity_window(job: PcapJob) -> tuple[int, int] | None:
        if job.result is None:
            return None
        first = job.result.summary.capture_first_timestamp
        last = job.result.summary.capture_last_timestamp
        if first is None or last is None:
            return None
        active_from = math.floor(first * 1000)
        active_until = max(active_from + 1, math.floor(last * 1000) + 1)
        return active_from, active_until

    def _plan_windows(
        self,
        from_ms: int,
        until_ms: int,
        window_seconds: int | None,
    ) -> list[tuple[int, int]]:
        if from_ms < 0 or until_ms < 0 or until_ms <= from_ms:
            raise PcapJobError(422, "Collection requires an absolute interval with fromMs before untilMs.")
        if until_ms - from_ms > self.settings.max_interval_ms:
            raise PcapJobError(422, "The requested packet interval exceeds the configured maximum.")
        seconds = self.settings.default_window_seconds if window_seconds is None else window_seconds
        if not self.settings.min_window_seconds <= seconds <= self.settings.max_window_seconds:
            raise PcapJobError(422, "The collection window size is outside the configured bounds.")
        width_ms = seconds * 1000
        windows = []
        cursor = from_ms
        # The local contract is a half-open [from_ms, until_ms) interval. ExtraHop
        # packet-search boundaries are millisecond values, so each request uses an
        # inclusive end one millisecond before the next request begins.
        while cursor < until_ms:
            window_until = min(until_ms - 1, cursor + width_ms - 1)
            windows.append((cursor, window_until))
            cursor = window_until + 1
        if len(windows) > self.settings.max_windows:
            raise PcapJobError(422, "The requested interval requires too many packet-search windows.")
        return windows

    def _owned_job(self, owner_session: str, job_id: str) -> PcapJob:
        job = self._jobs.get(job_id)
        if not job or not secrets.compare_digest(job.owner_session, owner_session):
            raise PcapJobError(404, "Datafeed Analysis job was not found.")
        if time.time() >= job.expires_at:
            raise PcapJobError(410, "Datafeed Analysis job has expired.")
        return job

    async def _prune_expired(self) -> None:
        now = time.time()
        expired = [job for job in self._jobs.values() if job.state in TERMINAL_STATES and now >= job.expires_at]
        for job in expired:
            self._jobs.pop(job.id, None)
            await self._cleanup_files(job)

    async def _discard_job(self, job: PcapJob) -> None:
        self._jobs.pop(job.id, None)
        job.cancel_event.set()
        await self._cleanup_files(job)

    async def _cleanup_files(self, job: PcapJob) -> None:
        await asyncio.to_thread(shutil.rmtree, job.temp_dir, True)

    def _complete(self, job: PcapJob) -> None:
        job.state = "completed"
        job.completed_at = time.time()
        job.expires_at = job.completed_at + self.settings.retention_seconds
        job.progress = {"stage": "completed", "percent": 100}

    def _cancelled(self, job: PcapJob) -> None:
        job.state = "cancelled"
        job.completeness = "partial" if job.result else "not_applicable"
        job.completed_at = time.time()
        job.expires_at = job.completed_at + self.settings.retention_seconds
        job.progress = {"stage": "cancelled"}

    def _deadline_failed(self, job: PcapJob) -> None:
        self._failed(
            job,
            "The absolute Datafeed Analysis operation deadline was reached.",
            "deadline_exceeded",
        )

    def _failed(
        self,
        job: PcapJob,
        message: str,
        error_type: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        job.state = "failed"
        job.completed_at = time.time()
        job.expires_at = job.completed_at + self.settings.retention_seconds
        job.error = {"message": message, "type": error_type, "details": details or {}}
        job.progress = {"stage": "failed"}

    def _upload_limit_message(self) -> str:
        return f"The uploaded PCAP exceeds the configured {self.settings.max_upload_bytes:,}-byte limit."

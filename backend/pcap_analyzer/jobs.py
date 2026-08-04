from __future__ import annotations

import asyncio
import csv
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from io import StringIO
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
                    total += len(chunk)
                    if total > self.settings.max_upload_bytes:
                        raise PcapJobError(413, self._upload_limit_message())
                    handle.write(chunk)
                    with job.lock:
                        job.progress["bytesReceived"] = total
            if total == 0:
                raise PcapJobError(400, "The uploaded PCAP is empty.")
        except BaseException:
            await self._discard_job(job)
            raise

        job.source = {"type": "upload", "bytes": total}
        job.task = asyncio.create_task(self._run_upload(job, destination))
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
        safe_offset = max(0, offset)
        safe_limit = max(1, min(limit, self.settings.max_result_page))
        return {
            "items": rows[safe_offset : safe_offset + safe_limit],
            "total": len(rows),
            "offset": safe_offset,
            "limit": safe_limit,
        }

    def csv_rows(self, owner_session: str, job_id: str) -> tuple[str, Iterable[str]]:
        job = self._owned_job(owner_session, job_id)
        if job.state != "completed":
            raise PcapJobError(409, "CSV is available only after the analysis completes.")
        columns = (
            "ipVersion",
            "protocol",
            "sourceAddress",
            "sourcePort",
            "destinationAddress",
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
            for row in job.rows:
                buffer.seek(0)
                buffer.truncate(0)
                writer.writerow(
                    [
                        _neutralize_csv(
                            ",".join(row.get("findingKinds", [])) if column == "findings" else row.get(column),
                            numeric=column in numeric,
                        )
                        for column in columns
                    ]
                )
                yield buffer.getvalue()

        return f"datafeed-analysis-{job.id[:12]}.csv", lines()

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
        tasks = [job.task for job in owned if job.task and job.state != "analyzing"]
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
        )
        self._jobs[job_id] = job
        return job

    async def _run_upload(self, job: PcapJob, destination: Path) -> None:
        async with self._semaphore:
            job.started_at = time.time()
            try:
                await self._analyze(job, [destination])
                job.completeness = "complete"
                self._complete(job)
            except asyncio.CancelledError:
                self._cancelled(job)
            except AnalysisCancelled:
                self._cancelled(job)
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
            deadline = time.monotonic() + self.settings.operation_deadline_seconds
            captures: list[Path] = []
            terminal_error: ExtraHopApiError | None = None
            try:
                for index, (from_ms, until_ms) in enumerate(windows):
                    if job.cancel_event.is_set():
                        raise AnalysisCancelled("Collection cancelled")
                    if time.monotonic() >= deadline:
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
                            deadline=deadline,
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
                incomplete = bool(job.collection["failedWindows"] or job.collection["skippedWindows"])
                job.completeness = "partial" if incomplete else "indeterminate"
                self._complete(job)
            except asyncio.CancelledError:
                self._cancelled(job)
            except AnalysisCancelled:
                self._cancelled(job)
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
            cancelled=job.cancel_event.is_set,
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

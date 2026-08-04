"""Bounded, deterministic analysis of classic PCAP packet evidence.

The analyzer deliberately has no knowledge of HTTP, ExtraHop sessions, or jobs.  It
accepts one or more classic-PCAP inputs and returns a canonical result that callers
can project into API, browser, or export representations.
"""

from __future__ import annotations

import ipaddress
import os
import struct
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Callable, Iterable, TypeAlias


PCAPNG_MAGIC = b"\x0a\x0d\x0d\x0a"
LINKTYPE_ETHERNET = 1
TCP_PROTOCOL = 6
TCP_SYN = 0x02
TCP_FIN = 0x01
TCP_RST = 0x04
SEQUENCE_MODULUS = 1 << 32
SEQUENCE_HALF = 1 << 31


class PcapAnalysisError(Exception):
    """Base class for expected analyzer failures."""


class InvalidCaptureError(PcapAnalysisError):
    """Raised when a source is not a structurally valid classic PCAP."""


class UnsupportedCaptureError(PcapAnalysisError):
    """Raised when a valid capture uses an unsupported format or link type."""


class AnalysisLimitError(PcapAnalysisError):
    """Raised before a configured resource bound would be exceeded."""


class AnalysisCancelled(PcapAnalysisError):
    """Raised when the caller's cancellation callback requests cancellation."""


@dataclass(frozen=True)
class AnalyzerLimits:
    """Hard bounds for one analysis operation."""

    max_packets: int = 1_000_000
    max_flows: int = 100_000
    max_findings: int = 10_000
    max_sequence_intervals: int = 1_000_000
    max_record_bytes: int = 16 * 1024 * 1024
    progress_interval: int = 1_000

    def validate(self) -> None:
        for name, value in vars(self).items():
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True)
class AnalysisProgress:
    files_processed: int
    records_seen: int
    tcp_packets: int
    flow_count: int


@dataclass(frozen=True)
class Finding:
    """A bounded observation, never a claim that packet loss occurred."""

    kind: str
    severity: str
    message: str
    flow_key: str | None = None
    epoch: int | None = None
    start_sequence: int | None = None
    end_sequence: int | None = None
    length: int | None = None


@dataclass(frozen=True)
class FlowResult:
    ip_version: int
    source_address: str
    source_port: int
    destination_address: str
    destination_port: int
    packet_count: int
    captured_bytes: int
    original_bytes: int
    truncated_packets: int
    first_timestamp: float
    last_timestamp: float
    reverse_observed: bool
    connection_epochs: int
    sequence_gap_observations: int
    sequence_gap_bytes: int

    @property
    def flow_key(self) -> str:
        source = f"[{self.source_address}]" if self.ip_version == 6 else self.source_address
        destination = f"[{self.destination_address}]" if self.ip_version == 6 else self.destination_address
        return f"{source}:{self.source_port} -> {destination}:{self.destination_port}/tcp"


@dataclass(frozen=True)
class AnalysisSummary:
    files_processed: int
    records_seen: int
    tcp_packets: int
    non_tcp_packets: int
    unsupported_packets: int
    parse_errors: int
    truncated_records: int
    captured_bytes: int
    original_bytes: int
    flow_count: int
    affected_flow_count: int
    reverse_not_observed_flows: int
    truncated_flow_count: int
    sequence_gap_flow_count: int
    sequence_gap_observations: int
    sequence_gap_bytes: int
    capture_first_timestamp: float | None
    capture_last_timestamp: float | None
    findings_omitted: int
    uniform_slice_length: int | None
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class AnalysisResult:
    summary: AnalysisSummary
    flows: tuple[FlowResult, ...]
    findings: tuple[Finding, ...]


CaptureInput: TypeAlias = str | os.PathLike[str] | bytes | bytearray | memoryview | BinaryIO
CancelCallback: TypeAlias = Callable[[], bool]
ProgressCallback: TypeAlias = Callable[[AnalysisProgress], None]


@dataclass(frozen=True)
class _FlowKey:
    ip_version: int
    source: bytes
    source_port: int
    destination: bytes
    destination_port: int

    def reverse(self) -> _FlowKey:
        return _FlowKey(
            self.ip_version,
            self.destination,
            self.destination_port,
            self.source,
            self.source_port,
        )

    def sort_key(self) -> tuple[object, ...]:
        return (self.ip_version, self.source, self.source_port, self.destination, self.destination_port)


@dataclass(frozen=True)
class _SequenceObservation:
    timestamp: float
    ordinal: int
    sequence: int
    extent: int
    flags: int


@dataclass
class _FlowAccumulator:
    key: _FlowKey
    packet_count: int = 0
    captured_bytes: int = 0
    original_bytes: int = 0
    truncated_packets: int = 0
    first_timestamp: float = float("inf")
    last_timestamp: float = float("-inf")
    observations: list[_SequenceObservation] = field(default_factory=list)


@dataclass(frozen=True)
class _ParsedTcp:
    key: _FlowKey
    sequence: int
    flags: int
    declared_payload_length: int


@dataclass(frozen=True)
class _Gap:
    epoch: int
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass
class _Counters:
    files_processed: int = 0
    records_seen: int = 0
    tcp_packets: int = 0
    non_tcp_packets: int = 0
    unsupported_packets: int = 0
    parse_errors: int = 0
    truncated_records: int = 0
    captured_bytes: int = 0
    original_bytes: int = 0
    capture_first_timestamp: float | None = None
    capture_last_timestamp: float | None = None


class _PacketParseError(Exception):
    pass


class _UnsupportedPacket(Exception):
    pass


class _NonTcpPacket(Exception):
    pass


def analyze_pcaps(
    inputs: Iterable[CaptureInput],
    *,
    limits: AnalyzerLimits | None = None,
    cancelled: CancelCallback | None = None,
    progress: ProgressCallback | None = None,
) -> AnalysisResult:
    """Analyze classic PCAP inputs into stable directional TCP-flow results.

    Inputs are combined into one job-level aggregation. ``cancelled`` is checked at
    least once per packet and during final sequence processing. ``progress`` is
    invoked at each configured packet interval, after every source, and once at the
    end. Limit and cancellation conditions fail explicitly rather than returning a
    result that could be mistaken for complete analysis.
    """

    active_limits = limits or AnalyzerLimits()
    active_limits.validate()
    counters = _Counters()
    flows: dict[_FlowKey, _FlowAccumulator] = {}
    truncated_lengths: Counter[int] = Counter()
    sequence_intervals = 0
    ordinal = 0

    for source_index, source in enumerate(inputs):
        _check_cancelled(cancelled)
        stream, close_stream, source_name = _open_source(source, source_index)
        try:
            endian, timestamp_divisor = _read_global_header(stream, source_name)
            while True:
                _check_cancelled(cancelled)
                record_header = stream.read(16)
                if not record_header:
                    break
                if len(record_header) != 16:
                    raise InvalidCaptureError(f"{source_name}: truncated PCAP record header")
                timestamp_seconds, timestamp_fraction, captured_length, original_length = struct.unpack(
                    f"{endian}IIII", record_header
                )
                if counters.records_seen >= active_limits.max_packets:
                    raise AnalysisLimitError(f"packet limit ({active_limits.max_packets}) exceeded")
                if captured_length > active_limits.max_record_bytes:
                    raise AnalysisLimitError(
                        f"{source_name}: record length {captured_length} exceeds limit "
                        f"({active_limits.max_record_bytes})"
                    )
                packet = stream.read(captured_length)
                if len(packet) != captured_length:
                    raise InvalidCaptureError(f"{source_name}: truncated PCAP record data")

                counters.records_seen += 1
                counters.captured_bytes += captured_length
                counters.original_bytes += original_length
                ordinal += 1
                record_truncated = captured_length < original_length
                if record_truncated:
                    counters.truncated_records += 1
                    truncated_lengths[captured_length] += 1
                timestamp = timestamp_seconds + timestamp_fraction / timestamp_divisor
                if counters.capture_first_timestamp is None:
                    counters.capture_first_timestamp = timestamp
                    counters.capture_last_timestamp = timestamp
                else:
                    counters.capture_first_timestamp = min(counters.capture_first_timestamp, timestamp)
                    counters.capture_last_timestamp = max(counters.capture_last_timestamp or timestamp, timestamp)

                try:
                    parsed = _parse_ethernet_tcp(packet)
                except _NonTcpPacket:
                    counters.non_tcp_packets += 1
                except _UnsupportedPacket:
                    counters.unsupported_packets += 1
                except _PacketParseError:
                    counters.parse_errors += 1
                else:
                    accumulator = flows.get(parsed.key)
                    if accumulator is None:
                        if len(flows) >= active_limits.max_flows:
                            raise AnalysisLimitError(f"flow limit ({active_limits.max_flows}) exceeded")
                        accumulator = _FlowAccumulator(parsed.key)
                        flows[parsed.key] = accumulator
                    accumulator.packet_count += 1
                    accumulator.captured_bytes += captured_length
                    accumulator.original_bytes += original_length
                    accumulator.truncated_packets += int(record_truncated)
                    accumulator.first_timestamp = min(accumulator.first_timestamp, timestamp)
                    accumulator.last_timestamp = max(accumulator.last_timestamp, timestamp)
                    extent = parsed.declared_payload_length + bool(parsed.flags & TCP_SYN) + bool(parsed.flags & TCP_FIN)
                    # A zero-extent RST is retained because it is a defensible
                    # connection-epoch boundary even though it contributes no
                    # sequence-space interval.
                    if extent or parsed.flags & TCP_RST:
                        if sequence_intervals >= active_limits.max_sequence_intervals:
                            raise AnalysisLimitError(
                                f"sequence interval limit ({active_limits.max_sequence_intervals}) exceeded"
                            )
                        accumulator.observations.append(
                            _SequenceObservation(timestamp, ordinal, parsed.sequence, int(extent), parsed.flags)
                        )
                        sequence_intervals += 1
                    counters.tcp_packets += 1

                if progress and counters.records_seen % active_limits.progress_interval == 0:
                    progress(_progress(counters, len(flows)))
        finally:
            if close_stream:
                stream.close()
        counters.files_processed += 1
        if progress:
            progress(_progress(counters, len(flows)))

    flow_results: list[FlowResult] = []
    findings: list[Finding] = []
    findings_omitted = 0
    sequence_gap_observations = 0

    for key in sorted(flows, key=_FlowKey.sort_key):
        _check_cancelled(cancelled)
        accumulator = flows[key]
        epochs, gaps = _analyze_sequence_observations(accumulator.observations, cancelled)
        sequence_gap_observations += len(gaps)
        reverse_observed = key.reverse() in flows
        source_address = str(ipaddress.ip_address(key.source))
        destination_address = str(ipaddress.ip_address(key.destination))
        provisional = FlowResult(
            ip_version=key.ip_version,
            source_address=source_address,
            source_port=key.source_port,
            destination_address=destination_address,
            destination_port=key.destination_port,
            packet_count=accumulator.packet_count,
            captured_bytes=accumulator.captured_bytes,
            original_bytes=accumulator.original_bytes,
            truncated_packets=accumulator.truncated_packets,
            first_timestamp=accumulator.first_timestamp,
            last_timestamp=accumulator.last_timestamp,
            reverse_observed=reverse_observed,
            connection_epochs=epochs,
            sequence_gap_observations=len(gaps),
            sequence_gap_bytes=sum(gap.length for gap in gaps),
        )
        flow_results.append(provisional)
        for gap in gaps:
            finding = Finding(
                kind="tcp_sequence_gap_observed",
                severity="warning",
                message=(
                    f"Observed an uncovered TCP sequence range of {gap.length} byte(s); "
                    "this is packet-capture evidence and does not by itself prove network loss."
                ),
                flow_key=provisional.flow_key,
                epoch=gap.epoch,
                start_sequence=gap.start % SEQUENCE_MODULUS,
                end_sequence=gap.end % SEQUENCE_MODULUS,
                length=gap.length,
            )
            if len(findings) < active_limits.max_findings:
                findings.append(finding)
            else:
                findings_omitted += 1

    warnings: list[str] = []
    uniform_slice_length = _detect_uniform_slicing(counters, truncated_lengths)
    if uniform_slice_length is not None:
        warning = (
            f"Capture slicing is suspected: nearly all records were truncated at a uniform "
            f"captured length of {uniform_slice_length} bytes. This can reflect packet-access "
            "privileges or capture policy rather than the observed network feed."
        )
        warnings.append(warning)
        finding = Finding(kind="uniform_capture_slicing_suspected", severity="warning", message=warning)
        if len(findings) < active_limits.max_findings:
            findings.append(finding)
        else:
            findings_omitted += 1

    reverse_not_observed = sum(not flow.reverse_observed for flow in flow_results)
    truncated_flow_count = sum(bool(flow.truncated_packets) for flow in flow_results)
    sequence_gap_flow_count = sum(bool(flow.sequence_gap_observations) for flow in flow_results)
    affected_flow_count = sum(
        (not flow.reverse_observed) or bool(flow.truncated_packets) or bool(flow.sequence_gap_observations)
        for flow in flow_results
    )
    summary = AnalysisSummary(
        files_processed=counters.files_processed,
        records_seen=counters.records_seen,
        tcp_packets=counters.tcp_packets,
        non_tcp_packets=counters.non_tcp_packets,
        unsupported_packets=counters.unsupported_packets,
        parse_errors=counters.parse_errors,
        truncated_records=counters.truncated_records,
        captured_bytes=counters.captured_bytes,
        original_bytes=counters.original_bytes,
        flow_count=len(flow_results),
        affected_flow_count=affected_flow_count,
        reverse_not_observed_flows=reverse_not_observed,
        truncated_flow_count=truncated_flow_count,
        sequence_gap_flow_count=sequence_gap_flow_count,
        sequence_gap_observations=sequence_gap_observations,
        sequence_gap_bytes=sum(flow.sequence_gap_bytes for flow in flow_results),
        capture_first_timestamp=counters.capture_first_timestamp,
        capture_last_timestamp=counters.capture_last_timestamp,
        findings_omitted=findings_omitted,
        uniform_slice_length=uniform_slice_length,
        warnings=tuple(warnings),
    )
    if progress:
        progress(_progress(counters, len(flows)))
    return AnalysisResult(summary, tuple(flow_results), tuple(findings))


def _open_source(source: CaptureInput, source_index: int) -> tuple[BinaryIO, bool, str]:
    if isinstance(source, (bytes, bytearray, memoryview)):
        from io import BytesIO

        return BytesIO(bytes(source)), True, f"input {source_index + 1}"
    if isinstance(source, (str, os.PathLike)):
        path = Path(source)
        return path.open("rb"), True, str(path)
    if not hasattr(source, "read"):
        raise TypeError("PCAP inputs must be paths, bytes, or binary streams")
    return source, False, getattr(source, "name", f"input {source_index + 1}")


def _read_global_header(stream: BinaryIO, source_name: str) -> tuple[str, float]:
    header = stream.read(24)
    if len(header) < 4:
        raise InvalidCaptureError(f"{source_name}: missing PCAP global header")
    magic = header[:4]
    if magic == PCAPNG_MAGIC:
        raise UnsupportedCaptureError(f"{source_name}: PCAPNG is not supported; provide classic PCAP")
    formats = {
        b"\xd4\xc3\xb2\xa1": ("<", 1_000_000.0),
        b"\xa1\xb2\xc3\xd4": (">", 1_000_000.0),
        b"\x4d\x3c\xb2\xa1": ("<", 1_000_000_000.0),
        b"\xa1\xb2\x3c\x4d": (">", 1_000_000_000.0),
    }
    if magic not in formats:
        raise InvalidCaptureError(f"{source_name}: unsupported or invalid PCAP magic")
    if len(header) != 24:
        raise InvalidCaptureError(f"{source_name}: truncated PCAP global header")
    endian, timestamp_divisor = formats[magic]
    version_major, version_minor, _zone, _sigfigs, _snaplen, network = struct.unpack(f"{endian}HHIIII", header[4:])
    if (version_major, version_minor) != (2, 4):
        raise UnsupportedCaptureError(
            f"{source_name}: unsupported PCAP version {version_major}.{version_minor}; expected 2.4"
        )
    if network != LINKTYPE_ETHERNET:
        raise UnsupportedCaptureError(
            f"{source_name}: unsupported PCAP link type {network}; only Ethernet ({LINKTYPE_ETHERNET}) is supported"
        )
    return endian, timestamp_divisor


def _parse_ethernet_tcp(packet: bytes) -> _ParsedTcp:
    if len(packet) < 14:
        raise _PacketParseError
    ether_type = struct.unpack("!H", packet[12:14])[0]
    if ether_type == 0x0800:
        return _parse_ipv4_tcp(packet, 14)
    if ether_type == 0x86DD:
        return _parse_ipv6_tcp(packet, 14)
    raise _UnsupportedPacket


def _parse_ipv4_tcp(packet: bytes, offset: int) -> _ParsedTcp:
    if len(packet) < offset + 20:
        raise _PacketParseError
    first, _dscp, total_length, _ident, fragment, _ttl, protocol, _checksum, source, destination = struct.unpack(
        "!BBHHHBBH4s4s", packet[offset : offset + 20]
    )
    version = first >> 4
    header_length = (first & 0x0F) * 4
    if version != 4 or header_length < 20 or total_length < header_length:
        raise _PacketParseError
    if len(packet) < offset + header_length:
        raise _PacketParseError
    if fragment & 0x3FFF:
        raise _UnsupportedPacket
    if protocol != TCP_PROTOCOL:
        raise _NonTcpPacket
    return _parse_tcp(packet, offset + header_length, total_length - header_length, 4, source, destination)


def _parse_ipv6_tcp(packet: bytes, offset: int) -> _ParsedTcp:
    if len(packet) < offset + 40:
        raise _PacketParseError
    version_word, payload_length, next_header, _hop_limit, source, destination = struct.unpack(
        "!IHBB16s16s", packet[offset : offset + 40]
    )
    if version_word >> 28 != 6:
        raise _PacketParseError
    if next_header != TCP_PROTOCOL:
        if next_header in {0, 43, 44, 50, 51, 60, 135}:
            raise _UnsupportedPacket
        raise _NonTcpPacket
    return _parse_tcp(packet, offset + 40, payload_length, 6, source, destination)


def _parse_tcp(
    packet: bytes,
    offset: int,
    declared_transport_length: int,
    ip_version: int,
    source: bytes,
    destination: bytes,
) -> _ParsedTcp:
    if declared_transport_length < 20 or len(packet) < offset + 20:
        raise _PacketParseError
    source_port, destination_port, sequence, _ack, offset_flags = struct.unpack("!HHIIH", packet[offset : offset + 14])
    header_length = ((offset_flags >> 12) & 0x0F) * 4
    if header_length < 20 or declared_transport_length < header_length or len(packet) < offset + header_length:
        raise _PacketParseError
    flags = offset_flags & 0x01FF
    return _ParsedTcp(
        _FlowKey(ip_version, source, source_port, destination, destination_port),
        sequence,
        flags,
        declared_transport_length - header_length,
    )


def _analyze_sequence_observations(
    observations: list[_SequenceObservation], cancelled: CancelCallback | None
) -> tuple[int, list[_Gap]]:
    if not observations:
        return 1, []
    ordered = sorted(observations, key=lambda item: (item.timestamp, item.ordinal))
    epochs: list[list[_SequenceObservation]] = []
    current: list[_SequenceObservation] = []
    closed = False
    initial_syn: int | None = None
    has_non_syn = False

    for index, observation in enumerate(ordered):
        if index % 4_096 == 0:
            _check_cancelled(cancelled)
        syn = bool(observation.flags & TCP_SYN)
        duplicate_opening_syn = syn and initial_syn == observation.sequence and not has_non_syn and not closed
        if current and (closed or (syn and not duplicate_opening_syn)):
            epochs.append(current)
            current = []
            closed = False
            initial_syn = None
            has_non_syn = False
        current.append(observation)
        if syn and initial_syn is None:
            initial_syn = observation.sequence
        if not syn:
            has_non_syn = True
        if observation.flags & (TCP_FIN | TCP_RST):
            closed = True
    if current:
        epochs.append(current)

    gaps: list[_Gap] = []
    for epoch_number, epoch in enumerate(epochs, start=1):
        intervals: list[tuple[int, int]] = []
        reference: int | None = None
        for index, observation in enumerate(epoch):
            if index % 4_096 == 0:
                _check_cancelled(cancelled)
            if observation.extent == 0:
                continue
            start = observation.sequence if reference is None else _unwrap_sequence(observation.sequence, reference)
            end = start + observation.extent
            reference = end if reference is None else max(reference, end)
            intervals.append((start, end))
        intervals.sort()
        merged: list[list[int]] = []
        for start, end in intervals:
            if not merged or start > merged[-1][1]:
                merged.append([start, end])
            else:
                merged[-1][1] = max(merged[-1][1], end)
        for left, right in zip(merged, merged[1:]):
            gaps.append(_Gap(epoch_number, left[1], right[0]))
    return len(epochs), gaps


def _unwrap_sequence(sequence: int, reference: int) -> int:
    reference_modulo = reference % SEQUENCE_MODULUS
    delta = (sequence - reference_modulo + SEQUENCE_HALF) % SEQUENCE_MODULUS - SEQUENCE_HALF
    return reference + delta


def _detect_uniform_slicing(counters: _Counters, lengths: Counter[int]) -> int | None:
    minimum_sample = 20
    if counters.records_seen < minimum_sample or counters.truncated_records < minimum_sample or not lengths:
        return None
    common_length, common_count = lengths.most_common(1)[0]
    if common_length > 128:
        return None
    if counters.truncated_records / counters.records_seen < 0.9:
        return None
    if common_count / counters.truncated_records < 0.9:
        return None
    return common_length


def _check_cancelled(cancelled: CancelCallback | None) -> None:
    if cancelled and cancelled():
        raise AnalysisCancelled("analysis cancelled")


def _progress(counters: _Counters, flow_count: int) -> AnalysisProgress:
    return AnalysisProgress(counters.files_processed, counters.records_seen, counters.tcp_packets, flow_count)

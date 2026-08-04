import ipaddress
import struct

import pytest

from backend.pcap_analyzer import (
    AnalysisCancelled,
    AnalysisLimitError,
    AnalyzerLimits,
    InvalidCaptureError,
    UnsupportedCaptureError,
    analyze_pcaps,
)


def _tcp_header(source_port, destination_port, sequence, flags, payload=b""):
    offset_flags = (5 << 12) | flags
    return struct.pack("!HHIIHHHH", source_port, destination_port, sequence, 0, offset_flags, 8192, 0, 0) + payload


def _ethernet(payload, ether_type):
    return b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b" + struct.pack("!H", ether_type) + payload


def _ipv4_tcp(
    source="192.0.2.1",
    destination="198.51.100.2",
    source_port=12345,
    destination_port=443,
    sequence=100,
    flags=0x10,
    payload=b"",
):
    tcp = _tcp_header(source_port, destination_port, sequence, flags, payload)
    ip = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        20 + len(tcp),
        1,
        0,
        64,
        6,
        0,
        ipaddress.ip_address(source).packed,
        ipaddress.ip_address(destination).packed,
    )
    return _ethernet(ip + tcp, 0x0800)


def _ipv6_tcp(
    source="2001:db8::1",
    destination="2001:db8::2",
    source_port=23456,
    destination_port=8443,
    sequence=500,
    flags=0x10,
    payload=b"",
):
    tcp = _tcp_header(source_port, destination_port, sequence, flags, payload)
    ip = struct.pack(
        "!IHBB16s16s",
        6 << 28,
        len(tcp),
        6,
        64,
        ipaddress.ip_address(source).packed,
        ipaddress.ip_address(destination).packed,
    )
    return _ethernet(ip + tcp, 0x86DD)


def _ipv4_non_tcp(protocol=17):
    payload = b"\x00" * 8
    ip = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        20 + len(payload),
        1,
        0,
        64,
        protocol,
        0,
        ipaddress.ip_address("192.0.2.1").packed,
        ipaddress.ip_address("198.51.100.2").packed,
    )
    return _ethernet(ip + payload, 0x0800)


def _pcap(records=(), *, link_type=1, endian="<"):
    magic = b"\xd4\xc3\xb2\xa1" if endian == "<" else b"\xa1\xb2\xc3\xd4"
    result = bytearray(magic + struct.pack(f"{endian}HHiiii", 2, 4, 0, 0, 65535, link_type))
    for index, record in enumerate(records, start=1):
        if isinstance(record, tuple):
            packet, original_length = record
        else:
            packet, original_length = record, len(record)
        result.extend(struct.pack(f"{endian}IIII", index, index * 100, len(packet), original_length))
        result.extend(packet)
    return bytes(result)


def test_ipv4_and_ipv6_tcp_are_aggregated_and_stably_sorted():
    later_sorting_ipv4 = _ipv4_tcp(source="203.0.113.8", source_port=9, payload=b"a")
    first_sorting_ipv4 = _ipv4_tcp(source="192.0.2.1", source_port=8, payload=b"bb")
    ipv6 = _ipv6_tcp(payload=b"ccc")

    result = analyze_pcaps([_pcap([later_sorting_ipv4, ipv6, first_sorting_ipv4])])

    assert result.summary.tcp_packets == 3
    assert result.summary.flow_count == 3
    assert [(row.ip_version, row.source_address) for row in result.flows] == [
        (4, "192.0.2.1"),
        (4, "203.0.113.8"),
        (6, "2001:db8::1"),
    ]


def test_reverse_direction_is_computed_after_all_input_files():
    forward = _ipv4_tcp(payload=b"request")
    reverse = _ipv4_tcp(
        source="198.51.100.2",
        destination="192.0.2.1",
        source_port=443,
        destination_port=12345,
        payload=b"reply",
    )

    result = analyze_pcaps([_pcap([forward]), _pcap([reverse])])

    assert result.summary.files_processed == 2
    assert result.summary.reverse_not_observed_flows == 0
    assert all(flow.reverse_observed for flow in result.flows)


def test_record_truncation_is_first_class_and_declared_extent_avoids_false_gap():
    full_first = _ipv4_tcp(sequence=100, payload=b"x" * 100)
    sliced_first = full_first[:64]
    second = _ipv4_tcp(sequence=200, payload=b"y" * 10)

    result = analyze_pcaps([_pcap([(sliced_first, len(full_first)), second])])

    flow = result.flows[0]
    assert result.summary.truncated_records == 1
    assert flow.truncated_packets == 1
    assert flow.captured_bytes == 64 + len(second)
    assert flow.original_bytes == len(full_first) + len(second)
    assert flow.sequence_gap_observations == 0
    assert result.summary.affected_flow_count == 1
    assert result.summary.truncated_flow_count == 1
    assert result.summary.sequence_gap_flow_count == 0


def test_uniform_small_record_slicing_is_warned_with_safe_minimum_sample():
    full_packet = _ipv4_tcp(payload=b"x" * 100)
    sliced_records = [(full_packet[:64], len(full_packet)) for _ in range(20)]

    result = analyze_pcaps([_pcap(sliced_records)])

    assert result.summary.uniform_slice_length == 64
    assert "privileges or capture policy" in result.summary.warnings[0]
    assert result.findings[-1].kind == "uniform_capture_slicing_suspected"

    too_few = analyze_pcaps([_pcap(sliced_records[:19])])
    assert too_few.summary.uniform_slice_length is None


def test_retransmission_reordering_and_overlap_do_not_create_sequence_gaps():
    packets = [
        _ipv4_tcp(sequence=100, payload=b"a" * 100),
        _ipv4_tcp(sequence=300, payload=b"c" * 100),
        _ipv4_tcp(sequence=100, payload=b"a" * 100),  # retransmission
        _ipv4_tcp(sequence=350, payload=b"d" * 100),  # overlap
        _ipv4_tcp(sequence=200, payload=b"b" * 100),  # reordered arrival
    ]

    result = analyze_pcaps([_pcap(packets)])

    assert result.flows[0].sequence_gap_observations == 0
    assert not [item for item in result.findings if item.kind == "tcp_sequence_gap_observed"]


def test_uncovered_sequence_range_is_labeled_as_observation_and_findings_are_bounded():
    packets = [
        _ipv4_tcp(sequence=100, payload=b"a" * 10),
        _ipv4_tcp(sequence=120, payload=b"b" * 10),
        _ipv4_tcp(sequence=140, payload=b"c" * 10),
    ]

    result = analyze_pcaps([_pcap(packets)], limits=AnalyzerLimits(max_findings=1))

    assert result.flows[0].sequence_gap_observations == 2
    assert result.flows[0].sequence_gap_bytes == 20
    assert result.summary.affected_flow_count == 1
    assert result.summary.sequence_gap_flow_count == 1
    assert result.summary.sequence_gap_bytes == 20
    assert len(result.findings) == 1
    assert result.summary.findings_omitted == 1
    assert "does not by itself prove network loss" in result.findings[0].message


def test_syn_fin_connection_epochs_and_sequence_consumption():
    packets = [
        _ipv4_tcp(sequence=100, flags=0x02),
        _ipv4_tcp(sequence=101, flags=0x10, payload=b"x" * 10),
        _ipv4_tcp(sequence=111, flags=0x11),
        _ipv4_tcp(sequence=1000, flags=0x02),
        _ipv4_tcp(sequence=1001, flags=0x10, payload=b"y" * 5),
    ]

    result = analyze_pcaps([_pcap(packets)])

    assert result.flows[0].connection_epochs == 2
    assert result.flows[0].sequence_gap_observations == 0


def test_rst_closes_an_epoch_even_without_a_following_syn():
    packets = [
        _ipv4_tcp(sequence=100, payload=b"x" * 10),
        _ipv4_tcp(sequence=110, flags=0x14),
        _ipv4_tcp(sequence=500, payload=b"new connection without captured SYN"),
    ]

    result = analyze_pcaps([_pcap(packets)])

    assert result.flows[0].connection_epochs == 2
    assert result.flows[0].sequence_gap_observations == 0


def test_sequence_wraparound_is_merged_without_a_false_gap():
    packets = [
        _ipv4_tcp(sequence=0xFFFFFFF0, payload=b"x" * 16),
        _ipv4_tcp(sequence=0, payload=b"y" * 16),
    ]

    result = analyze_pcaps([_pcap(packets)])

    assert result.flows[0].sequence_gap_observations == 0


def test_empty_capture_and_explicit_packet_counters():
    empty = analyze_pcaps([_pcap()])
    assert empty.summary.records_seen == 0
    assert empty.summary.capture_first_timestamp is None
    assert empty.summary.capture_last_timestamp is None
    assert empty.flows == ()

    arp = _ethernet(b"\x00" * 28, 0x0806)
    malformed_ipv4 = _ethernet(b"\x45" + b"\x00" * 9, 0x0800)
    counted = analyze_pcaps([_pcap([_ipv4_non_tcp(), arp, malformed_ipv4])])
    assert counted.summary.non_tcp_packets == 1
    assert counted.summary.unsupported_packets == 1
    assert counted.summary.parse_errors == 1
    assert counted.summary.tcp_packets == 0


def test_capture_bounds_use_every_record_across_input_files():
    arp = _ethernet(b"\x00" * 28, 0x0806)
    result = analyze_pcaps([_pcap([arp, _ipv4_tcp()]), _pcap([_ipv6_tcp()])])

    assert result.summary.capture_first_timestamp == pytest.approx(1.0001)
    assert result.summary.capture_last_timestamp == pytest.approx(2.0002)
    assert result.summary.affected_flow_count == 2
    assert result.summary.reverse_not_observed_flows == 2


def test_pcapng_unsupported_link_type_and_corrupt_pcap_fail_clearly():
    with pytest.raises(UnsupportedCaptureError, match="PCAPNG"):
        analyze_pcaps([b"\x0a\x0d\x0d\x0a" + b"\x00" * 20])

    with pytest.raises(UnsupportedCaptureError, match="link type 101"):
        analyze_pcaps([_pcap(link_type=101)])

    corrupt = _pcap() + struct.pack("<IIII", 1, 0, 20, 20) + b"short"
    with pytest.raises(InvalidCaptureError, match="truncated PCAP record data"):
        analyze_pcaps([corrupt])


@pytest.mark.parametrize(
    ("limits", "packets", "message"),
    [
        (AnalyzerLimits(max_packets=1), [_ipv4_tcp(), _ipv4_tcp()], "packet limit"),
        (
            AnalyzerLimits(max_flows=1),
            [_ipv4_tcp(source_port=1), _ipv4_tcp(source_port=2)],
            "flow limit",
        ),
        (
            AnalyzerLimits(max_sequence_intervals=1),
            [_ipv4_tcp(sequence=1, payload=b"a"), _ipv4_tcp(sequence=2, payload=b"b")],
            "sequence interval limit",
        ),
    ],
)
def test_hard_resource_limits_fail_explicitly(limits, packets, message):
    with pytest.raises(AnalysisLimitError, match=message):
        analyze_pcaps([_pcap(packets)], limits=limits)


def test_cancellation_and_progress_callbacks_are_cooperative():
    progress_updates = []
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks >= 4

    limits = AnalyzerLimits(progress_interval=1)
    with pytest.raises(AnalysisCancelled, match="cancelled"):
        analyze_pcaps(
            [_pcap([_ipv4_tcp(payload=b"a"), _ipv4_tcp(payload=b"b")])],
            limits=limits,
            cancelled=cancelled,
            progress=progress_updates.append,
        )

    assert progress_updates
    assert progress_updates[0].records_seen == 1

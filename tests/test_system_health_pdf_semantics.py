import unittest

from backend import system_health_pdf as pdf


def sensor(sensor_id: str, name: str, trigger_drops: float | None) -> dict:
    return {
        "id": sensor_id,
        "name": name,
        "online": True,
        "model": "EDA",
        "packetPeak": None,
        "packetCapacity": 0,
        "throughputGbps": None,
        "throughputCapacity": 0,
        "triggerCyclesPeak": None,
        "triggerCyclesAvail": None,
        "triggerUtilization": None,
        "triggerDropsTotal": trigger_drops,
        "advancedCapacity": 0,
        "standardCapacity": 0,
        "analysis": {},
        "collectionStatus": {},
        "healthConditions": [],
    }


class SystemHealthPdfMissingValueTests(unittest.TestCase):
    def test_trigger_drop_total_preserves_measured_zero_and_missing(self):
        report = {"sensor_summaries": [sensor("zero", "Zero sensor", 0), sensor("missing", "Missing sensor", None)]}

        rows = pdf.system_health_pdf_rows(report)
        rows_by_id = {row["id"]: row for row in rows}

        self.assertEqual(rows_by_id["zero"]["trigger_drops"], 0.0)
        self.assertIsNone(rows_by_id["missing"]["trigger_drops"])

        summary = pdf.system_health_pdf_summary(rows, report)
        self.assertIn("<span>Trigger Drops</span><b>0 / 1</b>", summary)
        self.assertIn("Sensors with drops / reporting (1 unavailable)", summary)

    def test_trigger_drop_card_is_na_when_no_sensor_reported_a_total(self):
        report = {
            "sensor_summaries": [sensor("missing", "Missing sensor", None)],
        }

        summary = pdf.system_health_pdf_summary(pdf.system_health_pdf_rows(report), report)

        self.assertIn("<span>Trigger Drops</span><b>N/A</b>", summary)
        self.assertIn("Sensors with drops / reporting (1 unavailable)", summary)

    def test_packetstore_page_renders_unavailable_counters_without_inventing_zero(self):
        rows = [
            {
                "name": "Missing counters",
                "role": "packetstore",
                "packet_drops": None,
                "secrets": None,
                "secret_drops": None,
                "slow_write_drops": None,
                "interface_drops": None,
                "blocks_dropped": None,
            },
            {
                "name": "Measured zero",
                "role": "packetstore",
                "packet_drops": 0,
                "secrets": 0,
                "secret_drops": 0,
                "slow_write_drops": 0,
                "interface_drops": 0,
                "blocks_dropped": 0,
            },
        ]

        output = pdf.system_health_pdf_packetstore_page(rows, 1, 1, "30sec")

        self.assertIn("Packets unavailable (drop counter unavailable)", output)
        self.assertIn("Secrets unavailable (drop and total counters unavailable)", output)
        self.assertIn("Slow-write unavailable · interface unavailable · blocks unavailable", output)
        self.assertIn("Packets unavailable (0 dropped)", output)
        self.assertIn("Secrets unavailable (0 of 0 dropped)", output)
        self.assertIn("Slow-write 0 · interface 0 · blocks 0", output)

    def test_cover_risk_cards_are_na_when_all_required_inputs_are_unavailable(self):
        sensor_rows = [
            {
                "packet_peak": 0,
                "packet_capacity": 100,
                "throughput_gbps": 0,
                "throughput_capacity": 10,
                "trigger_drops": None,
                "metric_status": {"pkts": "empty", "bytes": "timed_out"},
            }
        ]
        packetstore_rows = [
            {
                "packet_drops": None,
                "slow_write_drops": None,
                "interface_drops": None,
                "blocks_dropped": None,
                "secret_drops": None,
            }
        ]

        summary = pdf.system_health_pdf_summary(sensor_rows, {}, packetstore_rows)

        self.assertIn("<span>Packet Risk</span><b>N/A</b>", summary)
        self.assertIn("<span>Throughput Watch</span><b>N/A</b>", summary)
        self.assertIn("<span>PCAP Loss</span><b>N/A</b>", summary)
        self.assertEqual(summary.count("(1 unavailable)"), 4)

    def test_cover_risk_cards_keep_measured_zero_as_reporting(self):
        sensor_rows = [
            {
                "packet_peak": 0,
                "packet_capacity": 100,
                "throughput_gbps": 0,
                "throughput_capacity": 10,
                "trigger_drops": 0,
                "metric_status": {"pkts": "zero_valued", "bytes": "zero_valued"},
            }
        ]
        packetstore_rows = [
            {
                "packet_drops": 0,
                "slow_write_drops": 0,
                "interface_drops": 0,
                "blocks_dropped": 0,
                "secret_drops": 0,
            }
        ]

        summary = pdf.system_health_pdf_summary(sensor_rows, {}, packetstore_rows)

        self.assertIn("<span>Packet Risk</span><b>0 / 1</b>", summary)
        self.assertIn("<span>Throughput Watch</span><b>0 / 1</b>", summary)
        self.assertIn("<span>Trigger Drops</span><b>0 / 1</b>", summary)
        self.assertIn("<span>PCAP Loss</span><b>0 / 1</b>", summary)
        self.assertNotIn("unavailable)", summary)

    def test_cover_risk_cards_disclose_partial_reporting_denominators(self):
        reporting_sensor = {
            "packet_peak": 0,
            "packet_capacity": 100,
            "throughput_gbps": 0,
            "throughput_capacity": 10,
            "trigger_drops": 0,
            "metric_status": {"pkts": "zero_valued", "bytes": "zero_valued"},
        }
        unavailable_sensor = {
            **reporting_sensor,
            "trigger_drops": None,
            "metric_status": {"pkts": "empty", "bytes": "empty"},
        }
        measured_packetstore = {
            "packet_drops": 0,
            "slow_write_drops": 0,
            "interface_drops": 0,
            "blocks_dropped": 0,
            "secret_drops": 0,
        }
        unavailable_packetstore = {field: None for field in measured_packetstore}

        summary = pdf.system_health_pdf_summary(
            [reporting_sensor, unavailable_sensor],
            {},
            [measured_packetstore, unavailable_packetstore],
        )

        self.assertIn("<span>Packet Risk</span><b>0 / 1</b>", summary)
        self.assertIn("<span>Throughput Watch</span><b>0 / 1</b>", summary)
        self.assertIn("<span>Trigger Drops</span><b>0 / 1</b>", summary)
        self.assertIn("<span>PCAP Loss</span><b>0 / 1</b>", summary)
        self.assertEqual(summary.count("(1 unavailable)"), 4)


if __name__ == "__main__":
    unittest.main()

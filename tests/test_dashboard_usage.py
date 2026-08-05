import json
import unittest

from backend.dashboard_usage import collect_dashboard_usage, summarize_dashboard_views


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def request(self, method, endpoint, **kwargs):
        self.calls.append((method, endpoint, kwargs))
        return self.responses.pop(0)


class DashboardUsageTests(unittest.IsolatedAsyncioTestCase):
    async def test_collects_hourly_dashboard_views_with_one_absolute_window(self):
        unsafe_id = 9007199254740993
        client = FakeClient([{
            "cycle": "1hr",
            "node_id": "0",
            "stats": [
                {
                    "oid": "0",
                    "time": 1_780_000_000_000,
                    "duration": 86_400_000,
                    "values": [[
                        {
                            "key": {"key_type": "intval", "intval": unsafe_id},
                            "value": 2,
                        },
                        {
                            "key": {"key_type": "intval", "intval": -3},
                            "value": 1,
                        },
                    ]],
                },
                {
                    "oid": "0",
                    "time": 1_780_086_400_000,
                    "duration": 86_400_000,
                    "values": [[{
                        "key": {"key_type": "intval", "intval": str(unsafe_id)},
                        "value": 4,
                    }]],
                },
            ],
        }])

        result = await collect_dashboard_usage(
            client,
            lookback_days=30,
            now_ms=1_780_200_000_000,
        )

        self.assertEqual(result["fromMs"], 1_780_200_000_000 - 30 * 86_400_000)
        self.assertEqual(result["untilMs"], 1_780_200_000_000)
        self.assertEqual(result["cycle"], "1hr")
        self.assertEqual(
            result["lastViewedByDashboardId"][str(unsafe_id)],
            {
                "dashboardId": str(unsafe_id),
                "lastViewedBucketStartMs": 1_780_086_400_000,
                "lastViewedBucketEndMs": 1_780_172_800_000,
                "viewsInWindow": 6,
            },
        )
        self.assertIn("-3", result["lastViewedByDashboardId"])

        method, endpoint, kwargs = client.calls[0]
        self.assertEqual((method, endpoint), ("POST", "/api/v1/metrics"))
        request = json.loads(kwargs["body"])
        self.assertEqual(request["object_ids"], [0])
        self.assertEqual(request["metric_category"], "ui")
        self.assertEqual(request["metric_specs"], [{"name": "_bi_dashboard_views_id"}])
        self.assertEqual(request["from"], result["fromMs"])
        self.assertEqual(request["until"], result["untilMs"])

    async def test_drains_bounded_continuation_results(self):
        client = FakeClient([
            {"xid": "9007199254740993", "num_results": 1},
            "again",
            {
                "stats": [{
                    "oid": "0",
                    "time": 1000,
                    "duration": 1000,
                    "values": [[]],
                }],
            },
        ])

        async def no_sleep(_delay):
            return None

        result = await collect_dashboard_usage(
            client,
            lookback_days=1,
            now_ms=100_000,
            sleep=no_sleep,
        )

        self.assertEqual(result["lastViewedByDashboardId"], {})
        self.assertEqual(
            [endpoint for _method, endpoint, _kwargs in client.calls],
            [
                "/api/v1/metrics",
                "/api/v1/metrics/next/9007199254740993",
                "/api/v1/metrics/next/9007199254740993",
            ],
        )

    def test_ignores_malformed_keys_and_non_positive_counts(self):
        summary = summarize_dashboard_views([{
            "stats": [{
                "time": 100,
                "duration": 10,
                "values": [[
                    {"key": {"key_type": "string", "strval": "not-an-id"}, "value": 4},
                    {"key": {"key_type": "intval", "intval": 7}, "value": 0},
                    {"key": {"key_type": "intval", "intval": 8}, "value": 2},
                ]],
            }],
        }])

        self.assertEqual(list(summary), ["8"])


if __name__ == "__main__":
    unittest.main()

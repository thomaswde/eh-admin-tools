import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backend.connection_store import (
    ConnectionStorageError,
    ConnectionStore,
    KEYRING_ACCOUNT,
    KEYRING_SERVICE,
)


class FakeKeyring:
    def __init__(self):
        self.passwords = {}

    def get_password(self, service, account):
        return self.passwords.get((service, account))

    def set_password(self, service, account, password):
        self.passwords[(service, account)] = password


class FailingKeyring:
    def get_password(self, service, account):
        del service, account
        raise RuntimeError("no secure backend")

    def set_password(self, service, account, password):
        del service, account, password
        raise RuntimeError("no secure backend")


class ConnectionStoreTests(unittest.TestCase):
    def test_shipped_env_example_contains_one_connection_of_each_type(self):
        repository_root = Path(__file__).resolve().parents[1]
        store = ConnectionStore(
            repository_root,
            env_path=repository_root / ".env.example",
            keyring_backend=FakeKeyring(),
        )

        catalog = store.list_connections()

        self.assertTrue(catalog["groupByDeployment"])
        self.assertEqual(
            [item["type"] for item in catalog["connections"]],
            ["360", "enterprise"],
        )

    def test_saves_secrets_to_keyring_and_lists_only_public_metadata(self):
        with TemporaryDirectory() as directory:
            keyring = FakeKeyring()
            store = ConnectionStore(
                Path(directory),
                env_path=Path(directory) / ".env",
                keyring_backend=keyring,
            )
            saved = store.save(
                {
                    "type": "360",
                    "tenant": "Example-Tenant",
                    "apiId": "client-id",
                    "apiSecret": "super-secret",
                }
            )

            catalog = store.list_connections()
            self.assertEqual(saved["tenant"], "example-tenant")
            self.assertEqual(catalog["connections"], [saved])
            self.assertNotIn("apiId", json.dumps(catalog))
            self.assertNotIn("super-secret", json.dumps(catalog))

            keychain_payload = keyring.passwords[(KEYRING_SERVICE, KEYRING_ACCOUNT)]
            self.assertIn("client-id", keychain_payload)
            self.assertIn("super-secret", keychain_payload)

    def test_loads_and_groups_360_then_enterprise_connections_from_env(self):
        with TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "EH_CONNECTION_ENTERPRISE_1_HOST=sensor-b.example.test",
                        "EH_CONNECTION_ENTERPRISE_1_API_KEY=enterprise-key",
                        "EH_CONNECTION_360_2_TENANT=zulu",
                        "EH_CONNECTION_360_2_API_ID=zulu-id",
                        "EH_CONNECTION_360_2_API_SECRET=zulu-secret",
                        "EH_CONNECTION_360_1_TENANT=alpha",
                        "EH_CONNECTION_360_1_API_ID=alpha-id",
                        "EH_CONNECTION_360_1_API_SECRET=alpha-secret",
                    ]
                ),
                encoding="utf-8",
            )
            store = ConnectionStore(
                Path(directory),
                env_path=env_path,
                keyring_backend=FakeKeyring(),
            )

            catalog = store.list_connections()

            self.assertTrue(catalog["groupByDeployment"])
            self.assertEqual(
                [(item["type"], item["label"]) for item in catalog["connections"]],
                [
                    ("360", "alpha"),
                    ("360", "zulu"),
                    ("enterprise", "sensor-b.example.test"),
                ],
            )
            self.assertEqual(catalog["env"]["connectionCount"], 3)

    def test_env_connection_overrides_same_destination_from_keyring(self):
        with TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "EH_CONNECTION_ENTERPRISE_1_HOST=sensor.example.test",
                        "EH_CONNECTION_ENTERPRISE_1_API_KEY=env-key",
                        "EH_CONNECTION_ENTERPRISE_1_VERIFY_TLS=false",
                    ]
                ),
                encoding="utf-8",
            )
            keyring = FakeKeyring()
            store = ConnectionStore(
                Path(directory),
                env_path=env_path,
                keyring_backend=keyring,
            )
            saved = store.save(
                {
                    "type": "enterprise",
                    "host": "sensor.example.test",
                    "apiKey": "keychain-key",
                }
            )

            catalog = store.list_connections()
            resolved = store.get(saved["id"])

            self.assertEqual(len(catalog["connections"]), 1)
            self.assertEqual(catalog["connections"][0]["source"], "env")
            self.assertEqual(catalog["connections"][0]["sources"], ["env", "keychain"])
            self.assertEqual(resolved["apiKey"], "env-key")
            self.assertFalse(resolved["verifyTls"])

    def test_enterprise_labels_are_normalized_to_hostname_or_ip(self):
        with TemporaryDirectory() as directory:
            store = ConnectionStore(
                Path(directory),
                env_path=Path(directory) / ".env",
                keyring_backend=FakeKeyring(),
            )

            saved = store.save(
                {
                    "type": "enterprise",
                    "host": "https://Sensor.Example.Test:8443/",
                    "apiKey": "key",
                }
            )

            self.assertEqual(saved["host"], "sensor.example.test:8443")
            self.assertEqual(saved["label"], "sensor.example.test:8443")
            self.assertEqual(store.get(saved["id"])["host"], "sensor.example.test:8443")

    def test_invalid_env_entry_is_skipped_without_exposing_values(self):
        with TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "EH_CONNECTION_360_1_TENANT=invalid/tenant",
                        "EH_CONNECTION_360_1_API_ID=id",
                        "EH_CONNECTION_360_1_API_SECRET=do-not-expose",
                    ]
                ),
                encoding="utf-8",
            )
            store = ConnectionStore(
                Path(directory),
                env_path=env_path,
                keyring_backend=FakeKeyring(),
            )

            catalog = store.list_connections()

            self.assertEqual(catalog["connections"], [])
            self.assertEqual(len(catalog["warnings"]), 1)
            self.assertNotIn("do-not-expose", json.dumps(catalog))

    def test_keyring_failure_does_not_hide_env_connections(self):
        with TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "EH_CONNECTION_360_1_TENANT=tenant",
                        "EH_CONNECTION_360_1_API_ID=id",
                        "EH_CONNECTION_360_1_API_SECRET=secret",
                    ]
                ),
                encoding="utf-8",
            )
            store = ConnectionStore(
                Path(directory),
                env_path=env_path,
                keyring_backend=FailingKeyring(),
            )

            catalog = store.list_connections()

            self.assertEqual(len(catalog["connections"]), 1)
            self.assertFalse(catalog["secureStorage"]["available"])
            with self.assertRaises(ConnectionStorageError):
                store.save(
                    {
                        "type": "enterprise",
                        "host": "sensor.example.test",
                        "apiKey": "key",
                    }
                )


if __name__ == "__main__":
    unittest.main()

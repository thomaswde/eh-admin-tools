import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


VALID_COLORS = {
    "bg": "#ffffff",
    "text": "#261f63",
    "low": "#00aaef",
    "mid": "#f05918",
    "high": "#ec0089",
}


class ChartThemeApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.themes_dir = Path(self.temp.name) / "chart-themes"
        patcher = patch.object(main, "resolve_chart_themes_dir", lambda: self.themes_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)
        self.client = self.enterContext(TestClient(main.app, base_url="http://127.0.0.1"))

    def save(self, theme_id, name="Corporate", colors=None):
        return self.client.put(
            f"/backend/chart-themes/{theme_id}",
            json={"name": name, "colors": colors or VALID_COLORS},
        )

    def test_lists_empty_before_any_theme_is_saved(self):
        response = self.client.get("/backend/chart-themes")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["themes"], [])
        self.assertTrue(body["writable"])
        self.assertTrue(body["directory"].endswith("chart-themes"))

    def test_saves_theme_as_readable_json_file(self):
        response = self.save("corporate-blue")
        self.assertEqual(response.status_code, 200)

        path = self.themes_dir / "corporate-blue.json"
        self.assertTrue(path.is_file())
        self.assertEqual(
            json.loads(path.read_text(encoding="utf-8")),
            {"id": "corporate-blue", "name": "Corporate", "colors": VALID_COLORS},
        )

    def test_saved_theme_round_trips_through_the_list(self):
        self.save("corporate-blue")
        themes = self.client.get("/backend/chart-themes").json()["themes"]
        self.assertEqual(
            themes,
            [{"id": "corporate-blue", "name": "Corporate", "colors": VALID_COLORS}],
        )

    def test_rejects_ids_that_would_escape_the_themes_directory(self):
        for theme_id in ["../secret", "a/b", "..", "Corporate", "with space"]:
            with self.subTest(theme_id=theme_id):
                response = self.save(theme_id)
                self.assertIn(response.status_code, (400, 404))
        self.assertFalse(any(Path(self.temp.name).glob("*.json")))

    def test_rejects_built_in_theme_ids(self):
        for theme_id in ["light", "dark", "mono", "auto", "draft"]:
            with self.subTest(theme_id=theme_id):
                response = self.save(theme_id)
                self.assertEqual(response.status_code, 400)
                self.assertIn("built-in", response.json()["detail"]["message"])

    def test_rejects_colors_that_are_not_six_digit_hex(self):
        for bad in ["red", "#fff", "#12345g", "", "javascript:alert(1)"]:
            with self.subTest(color=bad):
                colors = {**VALID_COLORS, "bg": bad}
                self.assertEqual(self.save("theme-a", colors=colors).status_code, 422)

    def test_rejects_unknown_color_slots(self):
        colors = {**VALID_COLORS, "sneaky": "#000000"}
        self.assertEqual(self.save("theme-a", colors=colors).status_code, 422)

    def test_deletes_a_saved_theme(self):
        self.save("corporate-blue")
        self.assertEqual(self.client.delete("/backend/chart-themes/corporate-blue").status_code, 200)
        self.assertFalse((self.themes_dir / "corporate-blue.json").exists())

    def test_deleting_a_missing_theme_reports_not_found(self):
        self.assertEqual(self.client.delete("/backend/chart-themes/nope").status_code, 404)

    def test_a_corrupt_theme_file_is_skipped_rather_than_breaking_the_list(self):
        self.save("good-theme")
        self.themes_dir.joinpath("broken.json").write_text("{not json", encoding="utf-8")
        self.themes_dir.joinpath("incomplete.json").write_text('{"name": "x"}', encoding="utf-8")

        themes = self.client.get("/backend/chart-themes").json()["themes"]
        self.assertEqual([theme["id"] for theme in themes], ["good-theme"])


class ChartThemeDirectoryTests(unittest.TestCase):
    def test_distribution_layout_puts_themes_beside_the_readme(self):
        with patch.object(main, "APP_ROOT", Path("/opt/eh-admin-tools/app")), \
                patch.dict(main.os.environ, {}, clear=False):
            main.os.environ.pop("EH_CHART_THEMES_DIR", None)
            self.assertEqual(
                main.resolve_chart_themes_dir(),
                Path("/opt/eh-admin-tools/chart-themes"),
            )

    def test_environment_override_wins(self):
        with patch.dict(main.os.environ, {"EH_CHART_THEMES_DIR": "/tmp/themes"}):
            self.assertEqual(main.resolve_chart_themes_dir(), Path("/tmp/themes"))


class PdfStyleColorTests(unittest.TestCase):
    """The browser resolves the theme; the PDF only validates and renames."""

    def test_uses_the_palette_the_browser_resolved(self):
        palette = {
            "bg": "#101010",
            "text": "#fafafa",
            "muted": "#9a9a9a",
            "subtle": "#cccccc",
            "grid": "#303030",
            "track": "#202020",
            "altRow": "#181818",
            "low": "#111111",
            "mid": "#222222",
            "high": "#333333",
        }
        colors = main.system_health_pdf_style_colors({"colors": palette, "transparent": True})

        self.assertEqual(colors["bg"], "#101010")
        self.assertEqual(colors["border"], palette["grid"])
        self.assertEqual(colors["card_bg"], palette["altRow"])
        self.assertEqual(colors["accent"], palette["low"])
        self.assertTrue(colors["transparent"])

    def test_falls_back_per_key_when_the_palette_is_incomplete_or_invalid(self):
        colors = main.system_health_pdf_style_colors({"colors": {"bg": "not-a-color", "high": "#123456"}})
        self.assertEqual(colors["bg"], main.SYSTEM_HEALTH_PDF_FALLBACK_COLORS["bg"])
        self.assertEqual(colors["high"], "#123456")
        self.assertFalse(colors["transparent"])

    def test_missing_style_renders_the_light_theme(self):
        colors = main.system_health_pdf_style_colors(None)
        for key, value in main.SYSTEM_HEALTH_PDF_FALLBACK_COLORS.items():
            self.assertEqual(colors[key], value)


if __name__ == "__main__":
    unittest.main()

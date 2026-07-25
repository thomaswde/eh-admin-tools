"""Muted dark-theme explorations for the System Health PPTX export.

Two directions, same four slides. Both drop the hot magenta/tangerine pair
in favour of a sapphire-cast canvas, plum for severity, and cyan for data.

  A — PLUM + BRONZE : warning keeps its own warm hue (desaturated tangerine)
  B — SAPPHIRE SLATE: warning is demoted to neutral; plum is the only accent
"""
from pptx import Presentation
from pptx.util import Inches

import mock
from mock import cover, glance, attention, capacity, gradient_png, W, H

# Shared muted foundation: canvas built from Sapphire, not neutral black.
BASE = dict(
    bg="131127",        # sapphire darkened ~78%
    band="1B1836",      # panel / banded row
    track="241F44",     # bar track, drifting toward plum
    rule="2E2851",      # hairlines
    ink="F1EFF8",
    body="C6C1DC",
    muted="8B85AB",
    gray="645C8A",      # no-data / absent — 3.0:1, the AA floor for graphics
    ok="4FA9D4",        # cyan, desaturated for dark
    logo="assets/eh-logo-white.png",
)

# Accents are contrast-checked against the canvas (WCAG AA body text = 4.5:1)
DARK_A = dict(BASE, name="DARK-A",
              crit="CE78A6",     # plum lifted to 5.1:1
              warn="C1996B")     # tangerine desaturated to bronze, 5.9:1

DARK_B = dict(BASE, name="DARK-B",
              crit="CE78A6",     # plum is the only accent that carries alarm
              warn="A9A2C6")     # warning demoted to neutral, 4.9:1


def build(theme, out):
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(W), Inches(H)
    cover(prs, theme, "grad.png")
    glance(prs, theme)
    attention(prs, theme)
    capacity(prs, theme)
    prs.save(out)
    print("wrote", out)


if __name__ == "__main__":
    gradient_png("grad.png")
    build(DARK_A, "dark-muted.pptx")
    build(DARK_B, "dark-minimal.pptx")

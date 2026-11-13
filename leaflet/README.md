# AI PR Reviewer — printable leaflet

A one-page **A4 leaflet** for the AI Pull Request Reviewer — a stakeholder-
friendly summary that shows what it is, the three ways a review starts, how to
read the verdict, why we should use it, and a short dashboard quick-reference,
all in a single sheet.

Top of the sheet shows the headline numbers: **~3 min typical review** and
**~€0.04 typical cost**.

There is also a plain-Markdown quick reference at
[`docs/ai-pr-reviewer-cheatsheet.md`](../docs/ai-pr-reviewer-cheatsheet.md) and
the full usage guide at
[`docs/ai-pr-reviewer-usage-guide.md`](../docs/ai-pr-reviewer-usage-guide.md).
CLI commands and operator configuration intentionally live in those docs, not
on the leaflet.

## Print / export to PDF

The leaflet is a single self-contained HTML file — no build step, no external
fonts or assets. Open `ai-pr-reviewer-leaflet.html` in a browser and print:

| Setting | Value |
| --- | --- |
| Paper size | **A4** |
| Margins | **None** (the sheet is already sized to A4) |
| Background graphics | **On** (`print backgrounds`) |
| Scale | 100 % / Default |
| Pages | **1** |

In Chrome/Edge: **Print… → Destination: Save as PDF** gives a PDF copy.
In a browser preview the page is centered with a shadow so it is easy to tell
apart from the browser background; printing strips the shadow.

## Editing

- All styling uses the tokens in the `:root` block of the `<style>` section:
  primary blue `#007BC0`, deep blue `#004975`, panel `#EFF1F2`, and a
  SuperGraphic strip.
- The design intentionally mirrors the Marp slide themes so the leaflet and
  the docs share one look.
- Emoji keep the verdicts scannable with no image assets.
- The numbers at the top (~3 min / ~€0.04) come from the aggregated job data in
  `../dev/jobs/*/status.json` — refresh them when the model mix changes.

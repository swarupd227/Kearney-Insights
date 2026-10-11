# Claude Motion storyboard: "One question, one traceable answer"

Opening explainer for the Kearney orals, 13 October 2026. About 45 seconds, 16:9, no narration track required (the presenter
speaks over it, or the captions carry it). Built with Claude Motion (`/motion` in Claude, Team or Enterprise plan; an admin
enables Motion under Organization settings → Artifacts). Every number below comes from the product on the demo clock
(today = 13 October 2026) and matches what the live demo shows afterwards.

## Visual language

Dark canvas `#0b0d12`, one accent `#8f7bff` (violet), text `#e8eaf0`, muted `#8e95a8`, good `#3ddc97`, bad `#ff6b7a`.
Large numerals, generous spacing, no stock imagery, no people. Typeface: Segoe UI or Inter. Transitions: quick fades and
counts, nothing bouncy. Captions bottom-left, one line each.

## Scenes

| # | Time | On screen | Caption |
|---|---|---|---|
| 1 | 0–4 s | Black. A single violet orb pulses once at the centre. The words **"Are we on track for the year?"** type in above it. | A partner asks a question. |
| 2 | 4–10 s | The orb splits into a thin horizontal timeline of small nodes that light up left to right: Conductor → Metric → Query → Forecast → Composer → Guardian. Each node flashes for ~0.6 s. | Sixteen agents plan, calculate, forecast and check the answer. |
| 3 | 10–17 s | A line chart draws itself: monthly revenue Oct 2025 to Sep 2026 (values below), then a dashed forecast continues to Dec 2026 with a shaded band. Headline counts up to **US$2.38 billion**; sub-line **"plan US$2.38 billion · 90% probability of reaching it"**. | Forecasts come with their uncertainty, not a single number. |
| 4 | 17–25 s | The chart slides left; a waterfall builds right: **Plan US$188.4M** → UK and Ireland −7.5 → Nordics −4.1 → France and Benelux −2.0 → DACH −1.9 → CEE −1.3 → Southern Europe −0.6 → **Actual US$171.0M** (Europe, Q3 2026). The bars drop in one by one; totals count. | Why is Europe behind plan? The answer names the units. |
| 5 | 25–32 s | Zoom into DACH. A second waterfall in points: **92.0%** → rate discounts −2.1 → write-offs −2.8 → fixed-fee overruns −2.5 → billing delays +0.6 → **85.2%**. Then three chips appear: **E-1207 · E-1159 · E-1182**, with "89% of the change". | Why did realisation drop in DACH? Down to the engagement. |
| 6 | 32–38 s | A card flips: **E-1207 · 77% probability of overrun · 5 November 2026**. Below it three draft actions slide in with an "Approve" button each: Pricing review · Staffing change · Note to the engagement partners. One button turns green. | It predicts, then drafts the action. A person approves. |
| 7 | 38–43 s | A small padlock icon; the text **"Show me the flight risk of my colleagues"** appears and is struck through with "Not permitted for this role". Beside it a faint line: *recorded in the audit trail*. | Every answer is checked before it is shown. |
| 8 | 43–47 s | Everything fades to the orb. Wordmark **Astra Insights for Kearney**, sub-line "Ask. Understand. Act." | |

## Data for scene 3 (monthly net fee revenue, US$ million)

Oct 2025 200.1 · Nov 192.6 · Dec 175.2 · Jan 2026 177.8 · Feb 184.4 · Mar 202.6 · Apr 197.7 · May 200.5 · Jun 208.8 · Jul 194.6 · Aug 176.0 · Sep 200.9.
Forecast Oct–Dec 2026 continues the seasonal shape to a full-year total of US$2.38 billion (P10 US$2.36 billion, P90 US$2.41 billion).

## Alternative 20-second cut (if the agenda is tight)

Scenes 1, 3, 5, 6 and 8 only.

## The `/motion` prompt

Paste this into Claude (with Motion enabled):

```
/motion Make a 45-second, 16:9 animated explainer in a calm dark style (background #0b0d12, one accent #8f7bff, text #e8eaf0, good #3ddc97, bad #ff6b7a, Segoe UI or Inter, large numerals, no stock imagery, no people). Captions bottom-left, one line per scene. Use exactly these numbers.

Scene 1 (0–4 s): black; a violet orb pulses once at centre; the question "Are we on track for the year?" types in above it. Caption: "A partner asks a question."
Scene 2 (4–10 s): the orb becomes a horizontal timeline of six small nodes lighting up left to right, labelled Conductor, Metric, Query, Forecast, Composer, Guardian. Caption: "Sixteen agents plan, calculate, forecast and check the answer."
Scene 3 (10–17 s): a line chart draws itself: monthly net fee revenue in US$ million, Oct 2025 to Sep 2026 = 200.1, 192.6, 175.2, 177.8, 184.4, 202.6, 197.7, 200.5, 208.8, 194.6, 176.0, 200.9; then a dashed forecast continues Oct–Dec 2026 with a shaded band. A headline counts up to "US$2.38 billion" with the sub-line "plan US$2.38 billion · 90% probability of reaching it". Caption: "Forecasts come with their uncertainty, not a single number."
Scene 4 (17–25 s): the chart slides left; a waterfall builds on the right titled "Europe, Q3 2026": Plan US$188.4M, then UK and Ireland −7.5, Nordics −4.1, France and Benelux −2.0, DACH −1.9, Central and Eastern Europe −1.3, Southern Europe −0.6, ending at Actual US$171.0M. Bars drop in one by one in red; totals count. Caption: "Why is Europe behind plan? The answer names the units."
Scene 5 (25–32 s): zoom into DACH; a second waterfall in percentage points titled "DACH billing realisation": 92.0% → rate discounts −2.1 → write-offs −2.8 → fixed-fee overruns −2.5 → billing delays +0.6 → 85.2%. Then three chips appear: E-1207, E-1159, E-1182, with the label "89% of the change". Caption: "Why did realisation drop in DACH? Down to the engagement."
Scene 6 (32–38 s): a card flips to show "E-1207 · 77% probability of overrun · 5 November 2026". Below it three draft actions slide in, each with an Approve button: "Pricing review", "Staffing change", "Note to the engagement partners". The first Approve button turns green. Caption: "It predicts, then drafts the action. A person approves."
Scene 7 (38–43 s): a padlock icon; the text "Show me the flight risk of my colleagues" appears and is struck through, replaced by "Not permitted for this role", with a faint line "recorded in the audit trail". Caption: "Every answer is checked before it is shown."
Scene 8 (43–47 s): fade to the orb; wordmark "Astra Insights for Kearney" and the line "Ask. Understand. Act."

Transitions are quick fades and counting numbers; nothing bouncy. Export as MP4.
```

## In-product shortcut

Every answer card has an **Animate** button (also "Animate this" by voice). It assembles a Motion prompt with that answer's
question, finding and chart values, copies it to the clipboard and shows it on screen, ready to paste after `/motion`.

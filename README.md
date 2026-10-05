# FLEX Member Enrollment Dashboard — SAC Custom Widget

A custom widget for SAP Analytics Cloud showing the FLEX member enrollment cycle by **Group (A–F) and employer**. It shows how far along each Group's employers are, how many members still need to complete, defaults, daily completions, and, for one selected employer, what its members are selecting.

Design decisions and history: [`../flex-member-enrollment-report/REQUIREMENTS.md`](../flex-member-enrollment-report/REQUIREMENTS.md). Shared Gold changes: [`../flex-member-enrollment-report/GOLD_CHANGES.md`](../flex-member-enrollment-report/GOLD_CHANGES.md).

## Status

**Built against mock data, not yet connected or pushed.** It reads the **existing** row-level model `AM_MEMBER_ENROLLMENT_DETAIL`, the same one `sac-member-detail-widget` uses, and does all counting in the widget. Decided 2026-10-05: no new views, and no cube or AM changes. The only Datasphere change is the in-place Gold edits in [`GOLD_CHANGES.md`](../flex-member-enrollment-report/GOLD_CHANGES.md): Wave = "Group A"–"Group F" for FLEX members, and the existing `Employer` column filled as "Name (Number)".

## What it shows

- **KPI tiles:** set up, completed (%), started-not-completed (%), not started (%), still to complete, defaulted, and multiple attempts.
- **Needs-attention callout:** the employer in an open Group with the most members still to complete.
- **Group / employer table:** one summary row per Group (window, set up, progress bar, remaining, defaulted, status pill) with employer rows underneath when the Group is expanded. CPEI employers (LSC 61134, LSF 60262, CASSIA 60287) appear as display-only "CPEI · offline" rows, excluded from every total and %.
- **Employer detail card:** appears automatically when the data in view contains exactly one employer. It shows the full status breakdown, the health plan mix of completed members, and other elections (HSA, FSA health and dependent care, supplemental life ×3, retirement pretax and Roth, vision) as count, % of completed members, and average amount.
- **Completions by day:** daily bars plus a cumulative line, under a mini timeline of each Group's window. The x-axis is **fixed** to the FLEX calendar (Oct 13 – Nov 24) and never auto-scales. A dashed marker shows today.

## No in-widget interaction (by design)

SAC's Optimized-story View mode never delivers click/change events to a custom widget (see `../sac-ae-snap-report-widget/README.md`, "Known limitation"). So:

- **Groups expand from the calendar.** With no filter set, open Groups (today within the window) show their employers, while upcoming and closed Groups show one summary line. "Today" is the viewer's own local date.
- **Focus comes from native SAC Input Controls** on `Wave` (the FLEX Group) and `Employer`, placed on the story next to the widget. When only one Group has data in view, only that Group expands. When only one employer is in view, the employer card appears.

## Data binding

**One binding, `memberDetail`, on `AM_MEMBER_ENROLLMENT_DETAIL`:** one row per member per cycle. The widget keeps only FLEX rows (Wave starting `Group `), excludes `Is_Portico_Employee = "Yes"`, and uses the latest `EventDate`. It needs no story filter. Member IDs are bound for counting but never displayed.

In the Builder panel, **add Measures first, then Dimensions, each in exactly this order.** Dimensions 0–12 match the Detail widget's order; `Employer` is added last.

| # | Measure | # | Dimension |
|---|---|---|---|
| 0 | Total_Attempts | 0 | Member |
| 1 | HSA_Election_Amount | 1 | Wave |
| 2 | FSA_Health_Election_Amount | 2 | Enrollment_Status |
| 3 | FSA_Dependent_Election_Amount | 3 | Defaulted |
| 4 | SuppLife_Member_Amount | 4 | Defaulted_Timing |
| 5 | SuppLife_Spouse_Amount | 5 | Membership_Type |
| 6 | SuppLife_Dependent_Amount | 6 | Member_Health_Coverage |
| 7 | Retirement_Pretax_Amount | 7 | Vision_Plan |
| 8 | Retirement_Roth_Amount | 8 | Set_Up_Date |
| | | 9 | Completed_Date |
| | | 10 | Abandoned_Date |
| | | 11 | Is_Portico_Employee |
| | | 12 | EventDate |
| | | 13 | Employer |

Counting rules match the shared cube's: multiple attempts = `Total_Attempts > 1`; electing = amount `<> 0` among completed members, with average = sum / electors; vision elected = `Vision_Plan` not blank. Retirement shows dollars (amount fields), the same as the Member Operational widget.

**Before binding:** confirm `Employer` appears as a dimension in `AM_MEMBER_ENROLLMENT_DETAIL`'s Model Properties, and that SAC delivers every FLEX member row (a few thousand) without truncating. If the counts look capped, check the widget's result-set limit.

## Open items in the widget

- **Health plan labels.** `HEALTH_PLAN_LABELS` covers Select Copay, Value Copay, Medicare Supplement, Waived and Declined. Other codes show as their raw code with a "(code)" tag, never dropped. Case variants are merged.
- **Group F** has no dates yet. It shows "Dates TBD" and stays off the timeline. Update `GROUP_CALENDAR` here and Gold's `Wave_Window` together.
- **Unknown values are never silently dropped.** An unrecognized Group or `Enrollment_Status` triggers a data warning at the bottom of the widget. Otherwise that area is hidden, with no caveat or open-items text on the dashboard.

## Files

- `widget.json`: the manifest. Properties `width`, `height` and `simulatedToday` (testing only: forces "today", format `YYYY-MM-DD`; leave blank in SAC). One `memberDetail` binding and one `refresh` method.
- `main.js`: the `<com-porticobenefits-flexmemberenrollment>` element. It falls back to built-in mock data when nothing is bound.
- `preview.html`: local harness. Its Group, Employer and date controls sit **outside** the widget, standing in for SAC Input Controls. They filter the mock rows the way SAC filters the model and push them through the widget's update hook.
- `icon.svg`: the same icon as the rest of the Member suite.

## Deploying

1. Create the GitHub repo `sac-flex-member-widget` and enable Pages (branch `main`, `/root`).
2. Push these files.
3. In SAC, add a **new** custom widget from `widget.json`. It's version 1.0.0 and has never been placed, so a major version is fine. Once it's placed on a story, only bump minor or patch versions.

Whenever `main.js` changes, recompute the `integrity` hash, update `widget.json`, and re-upload it in SAC. **Always hash the committed file, never the working copy.** Line endings in the working copy (`core.autocrlf=true`, Python writes on Windows) can differ from the blob Git stores and GitHub Pages serves. Order: commit `main.js`, then hash the committed blob, then update and commit `widget.json`:

```bash
git show HEAD:main.js | openssl dgst -sha384 -binary | openssl base64 -A
```
' < main.js | openssl dgst -sha384 -binary | openssl base64 -A` instead.

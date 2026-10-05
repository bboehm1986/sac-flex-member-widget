/*
    FLEX Member Enrollment — SAC Custom Widget

    Dashboard for the FLEX member enrollment cycle (Groups A-F, each with
    its own enrollment window). The main lens is what the employers within
    each Group are doing: progress, how many members still need to
    complete, and what they're selecting. Design history and decisions:
    ../flex-member-enrollment-report/REQUIREMENTS.md.

    ONE data binding, "memberDetail", bound to the EXISTING row-level
    model AM_MEMBER_ENROLLMENT_DETAIL (thin wrapper on
    GLD_AE_Member_Enrollment), the same model sac-member-detail-widget
    uses. One row per member per cycle. All counting is done here, in
    the widget. Decided 2026-10-05: no new views and no cube/AM changes.
    The only Datasphere change is the in-place Gold edits in
    ../flex-member-enrollment-report/GOLD_CHANGES.md: Wave = "Group A".."Group F"
    for FLEX members, and Employer = "Name (Number)".

    Rows kept: Wave "Group X" (FLEX), Is_Portico_Employee <> "Yes", and
    the latest EventDate among FLEX rows (the current cycle). Member IDs
    are never displayed; the model is PII-bearing, the dashboard is not.

    Builder panel: add MEASURES first, then DIMENSIONS, each in EXACTLY
    this order. SAC binds by position, not by name. Dimensions 0-12 are
    the same order as sac-member-detail-widget, with Employer added last.

      Dimensions (14): Member, Wave, Enrollment_Status, Defaulted,
                       Defaulted_Timing, Membership_Type,
                       Member_Health_Coverage, Vision_Plan, Set_Up_Date,
                       Completed_Date, Abandoned_Date, Is_Portico_Employee,
                       EventDate, Employer
      Measures (9):    Total_Attempts, HSA_Election_Amount,
                       FSA_Health_Election_Amount,
                       FSA_Dependent_Election_Amount,
                       SuppLife_Member_Amount, SuppLife_Spouse_Amount,
                       SuppLife_Dependent_Amount, Retirement_Pretax_Amount,
                       Retirement_Roth_Amount

    Counting rules (same as the shared cube, so numbers agree):
      - Multiple attempts = Total_Attempts > 1.
      - Electing = amount <> 0, among COMPLETED members only. Average =
        sum / electing count. Retirement shows dollars, the same as the
        Member Operational widget (amount fields only).
      - Vision elected = Vision_Plan not blank.

    No in-widget interaction at all. SAC's Optimized-story View mode never
    delivers click/change events to a custom widget (see
    ../sac-ae-snap-report-widget/README.md, "Known limitation"). Instead:
      - Groups expand or collapse from the calendar: an open Group shows
        its employers, while upcoming and closed Groups show one summary
        row. A Group that is the only one with data (i.e. picked in a
        Wave Input Control) also expands.
      - The employer card with plan selections appears automatically when
        the data contains exactly ONE employer, i.e. an Employer Input
        Control is set to one employer.

    Dates: SAC sends date labels locale-formatted ("Oct 20, 2026"), not
    ISO. _parseDate() accepts ISO, YYYYMMDD and locale strings and always
    builds LOCAL-midnight dates (new Date(y, m, d)). Never new Date("2026-
    10-20"), which parses as UTC midnight and shifts a day west of UTC.
    The timeline axis is fixed to the FLEX calendar window and never
    auto-scales to whatever dates happen to have data.
*/
(function () {
    "use strict";

    // ---- FLEX calendar (presentation constant) ----
    // Also present as strings in Gold's Wave_Window. CHANGE BOTH TOGETHER.
    // Group F's dates are TBD (null) until confirmed.
    const GROUP_CALENDAR = [
        { group: "Group A", start: "2026-10-13", end: "2026-10-29", decisions: "2026-09-15" },
        { group: "Group B", start: "2026-10-20", end: "2026-11-05", decisions: "2026-09-22" },
        { group: "Group C", start: "2026-10-27", end: "2026-11-12", decisions: "2026-09-29" },
        { group: "Group D", start: "2026-11-03", end: "2026-11-19", decisions: "2026-10-06" },
        { group: "Group E", start: "2026-11-10", end: "2026-11-24", decisions: "2026-10-13" },
        { group: "Group F", start: null, end: null, decisions: null },
    ];
    // Groups confirmed to have no employers this cycle (shown, never dropped).
    const GROUPS_WITHOUT_EMPLOYERS = ["Group B"];

    // CPEI employers enroll offline, so they have no online requests and no
    // rows in the model. They are shown as display-only placeholder rows,
    // excluded from every total and %.
    const CPEI_PLACEHOLDERS = [
        { group: "Group C", name: "LSC", number: "61134" },
        { group: "Group D", name: "LSF", number: "60262" },
        { group: "Group D", name: "CASSIA", number: "60287" },
    ];

    const COMPLETED = ["Success"];
    const STARTED = ["Abandoned", "In Progress", "Needs Follow-up"];
    const NOT_STARTED = ["Not Started"];
    const STATUS_LABELS = { "Success": "Completed", "Abandoned": "Started, not completed", "In Progress": "In progress", "Needs Follow-up": "Needs follow-up", "Not Started": "Not started" };

    // Health plan codes (Member_Health_Coverage) arrive with case variants
    // (ESCP/escp, selectCopay/selectcopay, ...), so keys are lowercase.
    // Unknown codes are SHOWN with their raw code, never dropped.
    // SAP BPLAN codes: official T5UCA texts from Blair's BPLAN extract,
    // 2026-10-05. Medicare names are SAP's abbreviated texts written out
    // ("Medi Std UHC ESI" -> plan type "Medicare Standard" + carrier).
    // Enrollment-app codes (selectCopay etc.) map to the same names.
    // Still unconfirmed, so shown as codes: healthB and medSupp (app codes
    // with conflicting meanings in older PorticoAnalytics SQL).
    const HEALTH_PLAN_LABELS = {
        brnz: "Bronze+",
        escp: "Essential Copay 2500",
        gold: "Gold+",
        pltn: "Platinum+",
        slcp: "Select Copay",
        slhd: "Select HDHP 2000",
        slvr: "Silver+",
        vlcp: "Value Copay",
        vlhd: "Value HDHP 4000",
        waiv: "Waived Health Plan",
        fmsn: "Foreign Missionary Atena Int.",
        emap: "Medicare Economy · Humana",
        emue: "Medicare Economy · UHC ESI",
        pmap: "Medicare Premium · Humana",
        pmue: "Medicare Premium · UHC ESI",
        smap: "Medicare Standard · Humana",
        smue: "Medicare Standard · UHC ESI",
        selectcopay: "Select Copay",
        valuecopay: "Value Copay",
        waived: "Waived Health Plan",
        declined: "Declined",
    };

    // Dimension / measure positions (must match the Builder order above).
    const D = { MEMBER: 0, WAVE: 1, STATUS: 2, DEFAULTED: 3, HEALTH: 6, VISION: 7, COMPLETED_DATE: 9, PORTICO: 11, EVENT_DATE: 12, EMPLOYER: 13 };
    const DIM_COUNT = 14;
    const M = { ATTEMPTS: 0, HSA: 1, FSAH: 2, FSAD: 3, SLM: 4, SLS: 5, SLD: 6, RP: 7, RR: 8 };
    const MEASURE_COUNT = 9;
    const ELECTION_KEYS = ["HSA", "FSAH", "FSAD", "SLM", "SLS", "SLD", "RP", "RR"];

    // ---- Mock data (same row shape as a real SAC ResultSet) ----
    function row(dims, measures) {
        const out = {};
        for (let i = 0; i < DIM_COUNT; i++) { const d = dims[i] == null ? "" : dims[i]; out["dimensions_" + i] = { id: d, label: d }; }
        for (let i = 0; i < MEASURE_COUNT; i++) { const m = measures[i]; out["measures_" + i] = { raw: m == null ? null : m, formatted: m == null ? "" : String(m) }; }
        return out;
    }
    function localeLabel(d) {
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    // Mock population as of Oct 28, 2026. Groups D and E are shown as
    // already set up (all Not Started) so the preview can exercise their
    // rows; whether FLEX requests exist before a window opens is unknown.
    // [group, number, name, completed, abandoned, inProgress, followUp, notStarted, defaulted, multi]
    const MOCK_EMPLOYERS = [
        ["Group A", "60083", "LSSI", 302, 18, 14, 9, 77, 0, 41],
        ["Group C", "60190", "LMM", 48, 12, 11, 7, 532, 0, 9],
        ["Group C", "60007", "BHOA", 12, 4, 3, 2, 159, 0, 2],
        ["Group D", "61147", "Ascentria", 0, 0, 0, 0, 340, 0, 0],
        ["Group D", "61148", "Ascentria", 0, 0, 0, 0, 85, 0, 0],
        ["Group D", "61144", "AKCF", 0, 0, 0, 0, 120, 0, 0],
        ["Group E", "61083", "MSLCC", 0, 0, 0, 0, 150, 0, 0],
        ["Group E", "60089", "LCSNW", 0, 0, 0, 0, 230, 0, 0],
        ["Group E", "60149", "LMWI", 0, 0, 0, 0, 310, 0, 0],
        ["Group E", "60430", "BC", 0, 0, 0, 0, 75, 0, 0],
        ["Group E", "60181", "LMMERCY", 0, 0, 0, 0, 260, 0, 0],
        ["Group E", "60417", "LMMERCY", 0, 0, 0, 0, 90, 0, 0],
        ["Group E", "61146", "LMMERCY", 0, 0, 0, 0, 45, 0, 0],
    ];
    const MOCK_STARTS = { "Group A": new Date(2026, 9, 13), "Group C": new Date(2026, 9, 27) };

    function buildMockData() {
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const pick = (pairs) => { const x = rnd(); let acc = 0; for (const [v, p] of pairs) { acc += p; if (x < acc) return v; } return pairs[pairs.length - 1][0]; };
        const PLANS = [["selectCopay", 0.38], ["selectcopay", 0.06], ["valueCopay", 0.27], ["SLHD", 0.17], ["medSupp", 0.05], ["waived", 0.07]];
        const amt = (rate, avg) => (rnd() < rate ? Math.round(avg * (0.6 + rnd() * 0.8)) : 0);
        const none = [0, 0, 0, 0, 0, 0, 0, 0];
        const data = [];
        let id = 900000;
        const lastDay = new Date(2026, 9, 27);
        MOCK_EMPLOYERS.forEach(([g, no, name, s, a, ip, f, ns, dflt, multi]) => {
            const employer = name + " (" + no + ")";
            let multiLeft = multi;
            const member = (status, defaulted, completedDate, amounts, plan, vision) => {
                const attempts = status === "Not Started" ? 0 : multiLeft-- > 0 ? 2 + Math.floor(rnd() * 2) : 1;
                data.push(row([String(id++), g, status, defaulted, "N/A", "", plan, vision, "", completedDate, "", "No", "Jan 1, 2027", employer],
                    [attempts].concat(amounts)));
            };
            const start = MOCK_STARTS[g];
            for (let i = 0; i < s; i++) {
                const days = Math.round((lastDay - start) / 864e5);
                const d = new Date(start);
                d.setDate(d.getDate() + Math.min(days, Math.floor(Math.pow(rnd(), 1.3) * (days + 1))));
                member("Success", "No", localeLabel(d),
                    [amt(0.16, 1450), amt(0.21, 980), amt(0.07, 3600), amt(0.32, 52000), amt(0.12, 26000), amt(0.10, 10000), amt(0.28, 3100), amt(0.09, 2400)],
                    pick(PLANS), rnd() < 0.62 ? "basic" : "");
            }
            for (let i = 0; i < a; i++) member("Abandoned", "No", "", none, "", "");
            for (let i = 0; i < ip; i++) member("In Progress", "No", "", none, "", "");
            for (let i = 0; i < f; i++) member("Needs Follow-up", "No", "", none, "", "");
            for (let i = 0; i < ns; i++) member("Not Started", i < dflt ? "Yes" : "No", "", none, "", "");
        });
        // Rows the widget must ignore: a Traditional member, a Portico
        // employee, and a prior-cycle FLEX row.
        data.push(row(["1", "Wave 1", "Success", "No", "N/A", "", "selectCopay", "", "", "Oct 20, 2026", "", "No", "Jan 1, 2027", "Grace Lutheran (70001)"], [1, 500]));
        data.push(row(["2", "Group A", "Success", "No", "N/A", "", "selectCopay", "", "", "Oct 20, 2026", "", "Yes", "Jan 1, 2027", "Portico (53095)"], [1, 500]));
        data.push(row(["3", "Group A", "Success", "No", "N/A", "", "selectCopay", "", "", "Oct 20, 2025", "", "No", "Jan 1, 2026", "LSSI (60083)"], [1, 500]));
        return { data };
    }
    const MOCK_DATA = buildMockData();

    // ---- Template ----
    const template = document.createElement("template");
    template.innerHTML = `
        <style>
            :host {
                display: block;
                box-sizing: border-box;
                font-family: "72", "Segoe UI", Arial, sans-serif;
                /* Light mode only, same glassmorphism system as the rest of
                   the suite (each shadow root is isolated, so it's copied). */
                --mesh-1: rgba(106, 92, 240, 0.16);
                --mesh-2: rgba(47, 111, 224, 0.12);
                --mesh-3: rgba(20, 151, 111, 0.10);
                --surface: rgba(255, 255, 255, 0.58);
                --surface-2: rgba(23, 26, 35, 0.055);
                --border: rgba(255, 255, 255, 0.65);
                --text: #171a23;
                --text-soft: #5b6072;
                --accent: #6a5cf0;
                --accent-bg: rgba(106, 92, 240, 0.14);
                --success: #14976f;
                --success-bg: rgba(20, 151, 111, 0.14);
                --warning: #a5700c;
                --warning-bg: rgba(165, 112, 12, 0.14);
                --info: #2f6fe0;
                --info-bg: rgba(47, 111, 224, 0.14);
                --danger: #c94b4b;
                --danger-bg: rgba(201, 75, 75, 0.14);
                --started: #e19a2b;
                --glass-blur: blur(20px) saturate(180%);
                --shadow-card: 0 1px 1px rgba(23,26,35,0.03), 0 4px 12px -2px rgba(23,26,35,0.07), 0 14px 28px -10px rgba(23,26,35,0.10);
            }
            * { box-sizing: border-box; }
            .dashboard {
                width: 100%; height: 100%; overflow: auto;
                background:
                    radial-gradient(at 12% 8%, var(--mesh-1) 0%, transparent 45%),
                    radial-gradient(at 88% 14%, var(--mesh-2) 0%, transparent 45%),
                    radial-gradient(at 50% 100%, var(--mesh-3) 0%, transparent 50%),
                    #f4f5fa;
                color: var(--text); border-radius: 18px; padding: 18px;
            }
            .tile, .panel, .badge { backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); }
            @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                .tile, .panel { background: rgba(255,255,255,0.94) !important; }
            }
            .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
            .eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-soft); margin-bottom: 4px; }
            .topbar h1 { font-size: 19px; font-weight: 700; margin: 0; display: inline; }
            .titlewrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
            .badge { font-size: 10.5px; font-weight: 600; padding: 3px 9px; border-radius: 100px; border: 1px solid; white-space: nowrap; }
            .badge.accent { color: var(--accent); border-color: rgba(106,92,240,0.35); background: var(--accent-bg); }
            .asof { font-size: 11px; color: var(--text-soft); margin-top: 2px; }

            .section-title { font-size: 11.5px; font-weight: 700; color: var(--text-soft); text-transform: uppercase; letter-spacing: 0.05em; margin: 20px 0 8px; }
            .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px; box-shadow: var(--shadow-card); }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; }
            .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 11px; display: flex; flex-direction: column; gap: 4px; box-shadow: var(--shadow-card); }
            .tile .label { font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-soft); }
            .tile .value { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
            .tile .sub { font-size: 10.5px; color: var(--text-soft); }
            .callout { font-size: 12px; color: var(--text); margin: 12px 0 0; padding: 8px 12px; border-radius: 10px; background: var(--warning-bg); }
            .callout.info { background: var(--info-bg); }

            .legend { display: flex; gap: 14px; font-size: 10.5px; color: var(--text-soft); margin: 0 0 6px 2px; }
            .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
            .g-row { display: grid; grid-template-columns: minmax(0, 1.8fr) 62px minmax(0, 1.3fr) 74px 70px 112px; gap: 10px; align-items: center; padding: 8px 6px; border-bottom: 1px solid var(--surface-2); font-size: 12.5px; }
            .g-row.head { font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-soft); border-bottom: 1px solid rgba(23,26,35,0.12); }
            .g-row.parent { font-weight: 700; }
            .g-row.child { padding-left: 22px; }
            .g-row.child.placeholder { color: var(--text-soft); }
            .g-row.note { padding-left: 22px; font-size: 11.5px; color: var(--text-soft); display: block; }
            .g-row .sub { font-size: 10.5px; font-weight: 400; color: var(--text-soft); }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .bar { height: 6px; border-radius: 4px; background: var(--surface-2); overflow: hidden; display: flex; }
            .progress { display: flex; align-items: center; gap: 8px; }
            .progress .bar { flex: 1; }
            .progress .pct { width: 34px; text-align: right; font-size: 11px; color: var(--text-soft); font-weight: 400; }
            .pill { display: inline-block; font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 100px; white-space: nowrap; }
            .pill.success { color: var(--success); background: var(--success-bg); }
            .pill.danger { color: var(--danger); background: var(--danger-bg); }
            .pill.neutral { color: var(--text-soft); background: var(--surface-2); }
            .pill.info { color: var(--info); background: var(--info-bg); }

            .card { margin-top: 16px; }
            .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
            .card-title { font-size: 17px; font-weight: 700; }
            .card-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
            .mini-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-soft); margin: 0 0 8px; }
            .kv { display: grid; grid-template-columns: minmax(0, 1fr) 96px 46px; gap: 8px; align-items: center; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--surface-2); }
            .kv:last-child { border-bottom: none; }
            .kv .bar div { background: var(--accent); }
            .kv .code { font-size: 10px; color: var(--text-soft); }
            .elect { display: grid; grid-template-columns: minmax(0, 1fr) 54px 46px 70px; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--surface-2); }
            .elect.head { font-size: 9.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-soft); }
            .elect:last-child { border-bottom: none; }
            .card-sep { height: 1px; background: rgba(23,26,35,0.08); margin: 16px 0 14px; }
            .hint { margin-top: 16px; font-size: 12px; color: var(--text-soft); padding: 10px 14px; border: 1px dashed rgba(23,26,35,0.18); border-radius: 12px; }

            .chart-svg { width: 100%; display: block; }
            .axis { font-size: 9px; fill: var(--text-soft); }
            .lane-label { font-size: 9px; fill: var(--text-soft); }
            .notice { margin-top: 16px; background: var(--warning-bg); border: 1px solid rgba(165,112,12,0.3); border-radius: 14px; padding: 10px 14px; font-size: 11.5px; }
        </style>
        <div class="dashboard">
            <div class="topbar">
                <div>
                    <div class="eyebrow">FLEX Member Enrollment — 2027 plan year</div>
                    <div class="titlewrap">
                        <h1 id="title">Groups and Employers</h1>
                        <span class="badge accent" id="dataBadge">Mock Data — Preview</span>
                    </div>
                    <div class="asof" id="asof"></div>
                </div>
            </div>
            <div class="grid" id="kpis"></div>
            <div id="callout"></div>

            <div class="section-title">Progress by Group and employer</div>
            <div class="panel">
                <div class="legend">
                    <span><span class="swatch" style="background:var(--success)"></span>Completed</span>
                    <span><span class="swatch" style="background:var(--started)"></span>Started, not completed</span>
                    <span><span class="swatch" style="background:var(--surface-2);border:1px solid rgba(23,26,35,0.15)"></span>Not started</span>
                </div>
                <div class="g-row head"><span>Group / employer</span><span class="num">Set up</span><span>Progress</span><span class="num">Remaining</span><span class="num">Defaulted</span><span class="num">Status</span></div>
                <div id="groups"></div>
            </div>

            <div id="employerCard"></div>

            <div class="section-title">Completions by day</div>
            <div class="panel"><div id="timeline"></div></div>

            <div class="notice" id="notice"></div>
        </div>
    `;

    class FlexMemberEnrollment extends HTMLElement {
        constructor() {
            super();
            this._shadowRoot = this.attachShadow({ mode: "open" });
            this._shadowRoot.appendChild(template.content.cloneNode(true));
            this._props = { width: 960, height: 1100, simulatedToday: "" };
            this._data = MOCK_DATA;
            this._usingMockData = true;
        }

        connectedCallback() { this._render(); }

        onCustomWidgetBeforeUpdate(changedProperties) {
            this._props = Object.assign({}, this._props, changedProperties);
        }

        onCustomWidgetAfterUpdate(changedProperties) {
            if ("width" in changedProperties) this.style.width = changedProperties.width + "px";
            if ("height" in changedProperties) this.style.height = changedProperties.height + "px";
            if ("memberDetail" in changedProperties) { this._data = changedProperties.memberDetail; this._usingMockData = false; }
            this._render();
        }

        onCustomWidgetDestroy() { /* nothing held */ }

        refresh() { this._render(); }

        // Local preview only (preview.html): feed filtered mock data without
        // flipping the badge to "Live".
        _applyPreviewData(data) { this._data = data; this._usingMockData = true; this._render(); }

        // ---- Parsing helpers ----
        _dim(r, i) {
            const d = r["dimensions_" + i];
            if (!d) return "";
            if (d.id === "@NullMember" || d.label === "(Null)" || d.label === "(No Value)") return "";
            const v = d.label != null && d.label !== "" ? d.label : d.id;
            return v == null ? "" : String(v);
        }
        _measure(r, i) {
            const m = r["measures_" + i];
            return m && m.raw != null && m.raw !== "" ? Number(m.raw) : 0;
        }
        // Gold's Employer is "Name (Number)", or "No employer on request".
        _employer(label) {
            const m = /^(.*) \(([^()]+)\)$/.exec(label || "");
            if (m) return { key: m[2], number: m[2], name: m[1] };
            if (!label) return { key: "__none__", number: "", name: "Employer not in data" };
            return { key: "__" + label, number: "", name: label };
        }

        // One object per FLEX member in the current cycle, parsed once per
        // data update and shared by every panel.
        _members() {
            if (this._memberCache && this._memberCache.src === this._data) return this._memberCache.list;
            const rows = ((this._data && this._data.data) || []).filter((r) => /^Group /.test(this._dim(r, D.WAVE)) && this._dim(r, D.PORTICO) !== "Yes");
            let latest = null;
            const parsed = rows.map((r) => {
                const ev = this._parseDate(this._dim(r, D.EVENT_DATE));
                if (ev && (!latest || ev > latest)) latest = ev;
                return { r, ev };
            });
            const list = parsed.filter((p) => !latest || !p.ev || p.ev.getTime() === latest.getTime()).map(({ r }) => {
                const emp = this._employer(this._dim(r, D.EMPLOYER));
                const amounts = {};
                Object.keys(M).forEach((k) => { amounts[k] = this._measure(r, M[k]); });
                return {
                    group: this._dim(r, D.WAVE), status: this._dim(r, D.STATUS), defaulted: this._dim(r, D.DEFAULTED) === "Yes",
                    health: this._dim(r, D.HEALTH), vision: this._dim(r, D.VISION), completedDate: this._dim(r, D.COMPLETED_DATE),
                    empKey: emp.key, empNumber: emp.number, empName: emp.name, amounts,
                };
            });
            this._memberCache = { src: this._data, list };
            return list;
        }

        // Local-midnight date from ISO, YYYYMMDD, or a locale label.
        _parseDate(v) {
            if (!v) return null;
            const s = String(v).trim();
            let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
            if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
            m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
            if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
            const t = Date.parse(s);
            if (isNaN(t)) return null;
            const d = new Date(t);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        }
        _key(d) {
            return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        }
        _today() {
            const sim = this._parseDate(this._props.simulatedToday);
            if (sim) return sim;
            const n = new Date();
            return new Date(n.getFullYear(), n.getMonth(), n.getDate());
        }
        _fmtDay(d) { return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }

        _groupStatus(cal, today) {
            if (!cal || !cal.start) return { label: "Dates TBD", tone: "neutral", open: false };
            const start = this._parseDate(cal.start), end = this._parseDate(cal.end);
            if (today < start) return { label: "Opens " + this._fmtDay(start), tone: "neutral", open: false };
            if (today > end) return { label: "Closed " + this._fmtDay(end), tone: "neutral", open: false, closed: true };
            const left = Math.round((end - today) / 864e5);
            if (left === 0) return { label: "Closes today", tone: "danger", open: true };
            if (left <= 2) return { label: left === 1 ? "Closes tomorrow" : "Closes in 2 days", tone: "danger", open: true };
            return { label: "Open · " + left + " days left", tone: "success", open: true };
        }

        _emptyCounts() { return { total: 0, completed: 0, started: 0, notStarted: 0, other: 0, defaulted: 0, multi: 0, byStatus: {} }; }
        _add(target, src) {
            ["total", "completed", "started", "notStarted", "other", "defaulted", "multi"].forEach((k) => { target[k] += src[k]; });
            Object.keys(src.byStatus).forEach((s) => { target.byStatus[s] = (target.byStatus[s] || 0) + src.byStatus[s]; });
        }

        _parseStatus() {
            const groups = {};
            GROUP_CALENDAR.forEach((c) => { groups[c.group] = { employers: {}, totals: this._emptyCounts() }; });
            const unknownGroups = new Set(), unknownStatuses = new Set();
            this._members().forEach((m) => {
                if (!groups[m.group]) { unknownGroups.add(m.group); return; }
                const emps = groups[m.group].employers;
                if (!emps[m.empKey]) emps[m.empKey] = Object.assign(this._emptyCounts(), { key: m.empKey, number: m.empNumber, name: m.empName, group: m.group });
                const e = emps[m.empKey];
                e.total += 1;
                e.byStatus[m.status] = (e.byStatus[m.status] || 0) + 1;
                if (COMPLETED.includes(m.status)) e.completed += 1;
                else if (STARTED.includes(m.status)) e.started += 1;
                else if (NOT_STARTED.includes(m.status)) e.notStarted += 1;
                else { e.other += 1; unknownStatuses.add(m.status || "(blank)"); }
                if (m.defaulted) e.defaulted += 1;
                if (m.amounts.ATTEMPTS > 1) e.multi += 1;
            });
            Object.values(groups).forEach((g) => { Object.values(g.employers).forEach((e) => this._add(g.totals, e)); });
            return { groups, unknownGroups: [...unknownGroups], unknownStatuses: [...unknownStatuses] };
        }

        _parseDaily() {
            const byDay = {};
            this._members().forEach((m) => {
                if (!COMPLETED.includes(m.status) || !GROUP_CALENDAR.some((c) => c.group === m.group)) return;
                const d = this._parseDate(m.completedDate);
                if (!d) return;
                const k = this._key(d);
                byDay[k] = (byDay[k] || 0) + 1;
            });
            return byDay;
        }

        // Elections among the employer's COMPLETED members. Electing =
        // amount <> 0, the same rule as the shared cube's ElectionSummary.
        _parseElections(empKey) {
            const out = { completed: 0, vision: 0 };
            ELECTION_KEYS.forEach((k) => { out[k] = { n: 0, sum: 0 }; });
            this._members().forEach((m) => {
                if (m.empKey !== empKey || !COMPLETED.includes(m.status)) return;
                out.completed += 1;
                ELECTION_KEYS.forEach((k) => {
                    const v = m.amounts[k];
                    if (v !== 0) { out[k].n += 1; out[k].sum += v; }
                });
                if (m.vision) out.vision += 1;
            });
            return out;
        }

        _parseHealthPlans(empKey) {
            const byCode = {};
            this._members().forEach((m) => {
                if (m.empKey !== empKey || !COMPLETED.includes(m.status)) return;
                const raw = m.health || "(blank)";
                const k = raw.toLowerCase();
                if (!byCode[k]) byCode[k] = { label: HEALTH_PLAN_LABELS[k] || raw, labeled: !!HEALTH_PLAN_LABELS[k], code: raw, n: 0 };
                byCode[k].n += 1;
            });
            return Object.values(byCode).sort((a, b) => b.n - a.n);
        }

        // ---- Render helpers ----
        _fmt(n) { return Math.round(n).toLocaleString(); }
        _money(n) { return "$" + Math.round(n).toLocaleString(); }
        _pct(n, d) { return d ? Math.round((n / d) * 100) + "%" : "–"; }
        _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
        _tile(label, value, sub) {
            return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || "&nbsp;"}</div></div>`;
        }
        _bar(c) {
            if (!c.total) return `<div class="bar"></div>`;
            const w = (n) => ((n / c.total) * 100).toFixed(2) + "%";
            return `<div class="bar"><div style="width:${w(c.completed)};background:var(--success)"></div><div style="width:${w(c.started + c.other)};background:var(--started)"></div></div>`;
        }
        _progress(c) {
            return `<span class="progress">${this._bar(c)}<span class="pct">${this._pct(c.completed, c.total)}</span></span>`;
        }

        // ---- Rendering ----
        _render() {
            const root = this._shadowRoot;
            const today = this._today();
            const { groups, unknownGroups, unknownStatuses } = this._parseStatus();
            const allEmployers = [];
            Object.values(groups).forEach((g) => allEmployers.push(...Object.values(g.employers)));
            const groupsWithRows = GROUP_CALENDAR.filter((c) => Object.keys(groups[c.group].employers).length > 0).map((c) => c.group);
            const single = allEmployers.length === 1 ? allEmployers[0] : null;

            root.getElementById("dataBadge").textContent = this._usingMockData ? "Mock Data — Preview" : "Live";
            root.getElementById("asof").textContent = "As of " + today.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" }) + (this._props.simulatedToday ? " (simulated date)" : "");
            root.getElementById("title").textContent = single ? single.name + " (" + (single.number || "no number") + ")" : groupsWithRows.length === 1 ? groupsWithRows[0] + " employers" : "Groups and Employers";

            // KPIs (online employers only; CPEI placeholders have no rows).
            const T = this._emptyCounts();
            allEmployers.forEach((e) => this._add(T, e));
            root.getElementById("kpis").innerHTML = [
                this._tile("Set up", this._fmt(T.total), "members to enroll online"),
                this._tile("Completed", this._fmt(T.completed), this._pct(T.completed, T.total) + " complete"),
                this._tile("Started, not completed", this._fmt(T.started + T.other), this._pct(T.started + T.other, T.total) + " abandoned or in progress"),
                this._tile("Not started", this._fmt(T.notStarted), this._pct(T.notStarted, T.total) + " not started"),
                this._tile("Still to complete", this._fmt(T.total - T.completed), "set up minus completed"),
                this._tile("Defaulted", this._fmt(T.defaulted), "Default tag applied"),
                this._tile("Multiple attempts", this._fmt(T.multi), "members with 2+ attempts"),
            ].join("");

            // Callout: the employer in an open Group with the most members left.
            let worst = null;
            GROUP_CALENDAR.forEach((c) => {
                const st = this._groupStatus(c, today);
                if (!st.open) return;
                Object.values(groups[c.group].employers).forEach((e) => {
                    const left = e.total - e.completed;
                    if (left > 0 && (!worst || left > worst.left)) worst = { e, left, group: c.group, st };
                });
            });
            // "Focused" = only one Group has rows, i.e. a Group (or Employer)
            // Input Control is set. Early in the cycle this can also happen
            // unfiltered, which is harmless: that Group is the open one.
            const focusedGroup = groupsWithRows.length === 1 ? groupsWithRows[0] : null;
            const anyOpen = GROUP_CALENDAR.some((c) => this._groupStatus(c, today).open);
            let callout = "";
            if (worst && !single) {
                callout = `<div class="callout">Needs attention: <b>${this._esc(worst.e.name)} (${this._esc(worst.e.number)})</b> in ${worst.group} has ${this._fmt(worst.left)} members still to complete. ${worst.group} ${worst.st.label.toLowerCase()}.</div>`;
            } else if (!single && !anyOpen) {
                const next = GROUP_CALENDAR.filter((c) => c.start && this._parseDate(c.start) > today).sort((a, b) => this._parseDate(a.start) - this._parseDate(b.start))[0];
                callout = `<div class="callout info">No Group is open today.${next ? " Next: " + next.group + " opens " + this._fmtDay(this._parseDate(next.start)) + "." : ""} Pick a Group in the Wave filter to see its employers.</div>`;
            }
            root.getElementById("callout").innerHTML = callout;

            // Group / employer table.
            let html = "";
            GROUP_CALENDAR.forEach((c) => {
                const g = groups[c.group];
                const st = this._groupStatus(c, today);
                const emps = Object.values(g.employers).sort((a, b) => (b.total - b.completed) - (a.total - a.completed));
                const placeholders = single || (focusedGroup && focusedGroup !== c.group) ? [] : CPEI_PLACEHOLDERS.filter((p) => p.group === c.group);
                const noEmployers = GROUPS_WITHOUT_EMPLOYERS.includes(c.group);
                // Focused: expand only the focused Group. Otherwise the
                // calendar decides: open Groups expand.
                const expand = focusedGroup ? focusedGroup === c.group : st.open;
                const win = c.start ? this._fmtDay(this._parseDate(c.start)) + " – " + this._fmtDay(this._parseDate(c.end)) : "Dates TBD";
                const empCount = emps.length + placeholders.length;
                const offline = placeholders.length ? " · " + placeholders.length + " offline (CPEI)" : "";
                const meta = noEmployers ? "no employers assigned" : emps.length ? emps.length + (emps.length === 1 ? " employer" : " employers") + offline + (expand ? "" : " · collapsed") : "no members in view yet" + offline;
                const t = g.totals;
                html += `<div class="g-row parent"><span>${c.group} <span class="sub">· ${win} · ${meta}</span></span>`
                    + `<span class="num">${t.total ? this._fmt(t.total) : "–"}</span>`
                    + `<span>${t.total ? this._progress(t) : ""}</span>`
                    + `<span class="num">${t.total ? this._fmt(t.total - t.completed) : "–"}</span>`
                    + `<span class="num">${t.total ? this._fmt(t.defaulted) : "–"}</span>`
                    + `<span class="num"><span class="pill ${noEmployers ? "neutral" : st.tone}">${st.label}</span></span></div>`;
                if (!expand) return;
                if (noEmployers) { html += `<div class="g-row note">No employers are assigned to ${c.group} this cycle.</div>`; return; }
                if (!emps.length && !placeholders.length) { html += `<div class="g-row note">No members in view yet. Rows appear once enrollment requests exist for this Group.</div>`; }
                emps.forEach((e) => {
                    html += `<div class="g-row child"><span>${this._esc(e.name)} <span class="sub">${this._esc(e.number)}</span></span>`
                        + `<span class="num">${this._fmt(e.total)}</span>`
                        + `<span>${this._progress(e)}</span>`
                        + `<span class="num">${this._fmt(e.total - e.completed)}</span>`
                        + `<span class="num">${this._fmt(e.defaulted)}</span>`
                        + `<span class="num sub">${e.multi ? this._fmt(e.multi) + " multi-attempt" : ""}</span></div>`;
                });
                placeholders.forEach((p) => {
                    html += `<div class="g-row child placeholder"><span>${p.name} <span class="sub">${p.number}</span> <span class="pill neutral">CPEI · offline</span></span>`
                        + `<span class="num">–</span><span class="sub">Enrolling through the offline CPEI process</span><span class="num">–</span><span class="num">–</span><span class="num sub">excluded</span></div>`;
                });
            });
            root.getElementById("groups").innerHTML = html;

            // Employer card (exactly one employer in view) or a hint.
            root.getElementById("employerCard").innerHTML = single ? this._employerCardHtml(single, today) :
                `<div class="hint">Pick one employer in the Employer filter to see its full status breakdown and plan selections (health plan, HSA, FSA, supplemental life, retirement, vision).</div>`;

            root.getElementById("timeline").innerHTML = this._timelineHtml(this._parseDaily(), today);

            // Data warning: only shown when the data contains values this
            // widget doesn't recognize, so nothing is dropped silently. No
            // other caveat or open-items text on the dashboard (Blair, 2026-10-05).
            const notes = [];
            if (unknownGroups.length) notes.push("Rows with an unrecognized Group were left out: " + unknownGroups.map((x) => this._esc(x)).join(", ") + ".");
            if (unknownStatuses.length) notes.push("Unrecognized enrollment status counted as started: " + unknownStatuses.map((x) => this._esc(x)).join(", ") + ".");
            const notice = root.getElementById("notice");
            notice.innerHTML = notes.join("<br>");
            notice.style.display = notes.length ? "" : "none";
        }

        _employerCardHtml(e, today) {
            const cal = GROUP_CALENDAR.find((c) => c.group === e.group);
            const st = this._groupStatus(cal, today);
            const win = cal && cal.start ? this._fmtDay(this._parseDate(cal.start)) + " – " + this._fmtDay(this._parseDate(cal.end)) : "dates TBD";

            const statusRows = ["Success", "Abandoned", "In Progress", "Needs Follow-up", "Not Started"].concat(Object.keys(e.byStatus).filter((s) => !STATUS_LABELS[s]))
                .map((s) => {
                    const n = e.byStatus[s] || 0;
                    const w = e.total ? (n / e.total) * 100 : 0;
                    return `<div class="kv"><span>${this._esc(STATUS_LABELS[s] || s)}</span><div class="bar"><div style="width:${w.toFixed(2)}%"></div></div><span class="num">${this._fmt(n)}</span></div>`;
                }).join("")
                + `<div class="kv"><span>Defaulted</span><span></span><span class="num">${this._fmt(e.defaulted)}</span></div>`
                + `<div class="kv"><span>Multiple attempts</span><span></span><span class="num">${this._fmt(e.multi)}</span></div>`;

            const plans = this._parseHealthPlans(e.key);
            const planTotal = plans.reduce((s, p) => s + p.n, 0);
            const planRows = plans.length ? plans.map((p) => `<div class="kv"><span>${this._esc(p.label)}${p.labeled ? "" : ` <span class="code">(code)</span>`}</span><div class="bar"><div style="width:${((p.n / planTotal) * 100).toFixed(2)}%"></div></div><span class="num">${this._fmt(p.n)}</span></div>`).join("")
                : `<div class="sub" style="font-size:12px;color:var(--text-soft)">No completed health plan selections yet.</div>`;

            const el = this._parseElections(e.key);
            const line = (label, k) => {
                const x = el[k];
                return `<div class="elect"><span>${label}</span><span class="num">${this._fmt(x.n)}</span><span class="num">${this._pct(x.n, e.completed)}</span><span class="num">${x.n ? this._money(x.sum / x.n) : "–"}</span></div>`;
            };
            const vision = `<div class="elect"><span>Vision</span><span class="num">${this._fmt(el.vision)}</span><span class="num">${this._pct(el.vision, e.completed)}</span><span class="num">–</span></div>`;
            const head = `<div class="elect head"><span>Election</span><span class="num">Members</span><span class="num">Of done</span><span class="num">Avg</span></div>`;
            const block = (title, lines) => `<div><div class="mini-title">${title}</div>${head}${lines}</div>`;
            const elections = !el.completed ? `<div class="sub" style="font-size:12px;color:var(--text-soft)">No completed elections yet.</div>` :
                `<div class="card-cols">`
                + block("Savings accounts", line("HSA", "HSA") + line("FSA — health", "FSAH") + line("FSA — dependent care", "FSAD"))
                + block("Supplemental life", line("Member", "SLM") + line("Spouse", "SLS") + line("Dependent", "SLD"))
                + block("Retirement and vision", line("Retirement — pretax", "RP") + line("Retirement — Roth", "RR") + vision)
                + `</div>`;

            return `
                <div class="section-title">Employer detail</div>
                <div class="panel card">
                    <div class="card-head">
                        <div>
                            <div class="card-title">${this._esc(e.name)} <span class="sub" style="font-size:12px;font-weight:400;color:var(--text-soft)">${this._esc(e.number)}</span></div>
                            <div class="asof">${e.group} · ${win} · ${this._fmt(e.total)} set up · ${this._fmt(e.completed)} completed (${this._pct(e.completed, e.total)})</div>
                        </div>
                        <span class="pill ${st.tone}">${st.label}</span>
                    </div>
                    <div class="card-cols">
                        <div><div class="mini-title">Enrollment status</div>${statusRows}</div>
                        <div><div class="mini-title">Health plan selected · completed members</div>${planRows}</div>
                    </div>
                    <div class="card-sep"></div>
                    <div class="mini-title" style="margin-bottom:10px">Other elections · % of completed members electing</div>
                    ${elections}
                </div>`;
        }

        _timelineHtml(byDay, today) {
            const dated = GROUP_CALENDAR.filter((c) => c.start);
            const axisStart = new Date(Math.min(...dated.map((c) => this._parseDate(c.start))));
            const axisEnd = new Date(Math.max(...dated.map((c) => this._parseDate(c.end))));
            const days = [];
            for (let d = new Date(axisStart); d <= axisEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));
            const W = 900, padL = 64, padR = 14, laneH = 14, lanesTop = 6;
            const lanesH = dated.length * laneH;
            const chartTop = lanesTop + lanesH + 14, chartH = 120, axisY = chartTop + chartH;
            const H = axisY + 22;
            const step = (W - padL - padR) / days.length;
            const x = (i) => padL + i * step;
            const idx = (d) => Math.round((d - axisStart) / 864e5);

            const counts = days.map((d) => byDay[this._key(d)] || 0);
            const maxBar = Math.max(1, ...counts);
            let cum = 0;
            const cumVals = counts.map((n) => (cum += n));
            const maxCum = Math.max(1, cum);
            const outOfWindow = Object.keys(byDay).filter((k) => { const d = this._parseDate(k); return d < axisStart || d > axisEnd; }).reduce((s, k) => s + byDay[k], 0);

            let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily FLEX completions with Group windows">`;
            // Group window lanes (mini Gantt).
            dated.forEach((c, i) => {
                const y = lanesTop + i * laneH;
                const s = idx(this._parseDate(c.start)), e = idx(this._parseDate(c.end));
                svg += `<text class="lane-label" x="${padL - 6}" y="${y + 8}" text-anchor="end">${c.group}</text>`;
                svg += `<rect x="${x(s)}" y="${y + 1}" width="${(e - s + 1) * step}" height="${laneH - 3}" rx="3" fill="rgba(106,92,240,0.22)"/>`;
            });
            // Bars (daily completions) and cumulative line.
            counts.forEach((n, i) => {
                if (!n) return;
                const h = (n / maxBar) * (chartH - 8);
                svg += `<rect x="${x(i) + step * 0.15}" y="${axisY - h}" width="${step * 0.7}" height="${h}" rx="1.5" fill="rgba(47,111,224,0.45)"><title>${this._fmtDay(days[i])}: ${n} completed</title></rect>`;
            });
            // Cumulative line stops at the later of today and the last day
            // with data, so it doesn't run flat into the future.
            const lastData = counts.reduce((last, n, i) => (n ? i : last), -1);
            const cutoff = Math.min(days.length - 1, Math.max(lastData, today >= axisStart ? idx(today) : -1));
            const pts = cumVals.slice(0, cutoff + 1).map((v, i) => `${(x(i) + step / 2).toFixed(1)},${(axisY - (v / maxCum) * (chartH - 8)).toFixed(1)}`).join(" ");
            svg += `<polyline points="${pts}" fill="none" stroke="#6a5cf0" stroke-width="2"/>`;
            // Axis + labels every 7 days.
            svg += `<line x1="${padL}" y1="${axisY}" x2="${W - padR}" y2="${axisY}" stroke="rgba(23,26,35,0.18)"/>`;
            days.forEach((d, i) => {
                if (i % 7 === 0 || i === days.length - 1) svg += `<text class="axis" x="${x(i) + step / 2}" y="${axisY + 13}" text-anchor="middle">${this._fmtDay(d)}</text>`;
            });
            if (cum) svg += `<text class="axis" x="${padL - 6}" y="${chartTop + 8}" text-anchor="end">${maxBar}/day</text>`;
            svg += `<text class="axis" x="${W - padR}" y="${chartTop + 4}" text-anchor="end">${this._fmt(cum)} total</text>`;
            // Today marker (only inside the fixed window).
            if (today >= axisStart && today <= axisEnd) {
                const tx = x(idx(today)) + step / 2;
                svg += `<line x1="${tx}" y1="${lanesTop}" x2="${tx}" y2="${axisY}" stroke="#c94b4b" stroke-dasharray="3 3"/>`;
                svg += `<text class="axis" x="${tx + 3}" y="${chartTop - 3}" style="fill:#c94b4b">Today</text>`;
            }
            svg += `</svg>`;
            const legend = `<div class="legend" style="margin-top:6px"><span><span class="swatch" style="background:rgba(47,111,224,0.45)"></span>Completed that day</span><span><span class="swatch" style="background:#6a5cf0;height:2px;width:12px"></span>Cumulative</span><span><span class="swatch" style="background:rgba(106,92,240,0.22)"></span>Group window</span></div>`;
            const oow = outOfWindow ? `<div class="sub" style="font-size:11px;color:var(--text-soft)">${this._fmt(outOfWindow)} completions fall outside the FLEX calendar window and aren't plotted.</div>` : "";
            return svg + legend + oow;
        }
    }

    FlexMemberEnrollment.MOCK_DATA = MOCK_DATA;
    customElements.define("com-porticobenefits-flexmemberenrollment", FlexMemberEnrollment);
})();

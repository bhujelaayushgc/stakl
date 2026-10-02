# Stakl UI design system

## Direction

**Local infrastructure console / developer workstation utility.** Stakl is a place to operate real processes on one machine. It should read like an installed tool: immediate state, predictable controls, compact lists, and useful technical detail. The application inventory is the visual center of gravity. Profiles remain above applications because they operate collections; groups remain inside the application inventory because they organize it.

The memorable element is the **live application ledger**: names, state, ownership, runtime, and actions aligned in a calm, scan-friendly list. Green appears where something is running, connected, healthy, or ready to start. It does not color navigation, icon backgrounds, panels, or passive labels.

Terminal heritage comes from precise alignment, tabular numbers, restrained monospace for machine values, and clear operational language. No prompt symbols, faux terminal windows, scanlines, or decorative code.

### Layout concept

```text
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ Stakl        │ Applications                            Controller connected │
│              ├──────────────────────────────────────────────────────────────┤
│ Applications │ Profiles                                      2 running of 3 │
│ Ports        │ Development      2/2 running                 Restart   Stop  │
│ Activity     │ Local tools      Stopped                              Start  │
│              │──────────────────────────────────────────────────────────────│
│ Configuration│ Applications   3 running   1 needs attention   Search  Filter│
│ System       │ Development                                                  │
│              │ API server       Healthy       Owned  PID 8421   Logs   Stop │
│              │ Worker           Running       Owned  PID 8440   Logs   Stop │
│              │ Local tools                                                  │
│              │ Redis            External      PID 911         Details      │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

Left-align names, headings, controls, and prose. Align numbers and timestamps consistently within their columns. Let tables use available width; constrain explanatory prose to about 68 characters. Use a fixed 208 px navigation rail on wide screens, a 52 px utility bar, and 32 px desktop content gutters. The rail and work area share neutral colors, with a single boundary between them. Avoid a dark green rail beside a light canvas: that contrast makes the chrome louder than the processes.

## Design tokens

These are design reference values. The implemented tokens and responsive rules live in `web/src/workstation.css`; shared base styles remain in `web/src/style.css`. Both themes preserve the same hierarchy.

### Typography

Use **IBM Plex Sans** for the interface and **IBM Plex Mono** for commands, paths, PIDs, ports, timestamps, and logs. Their related shapes give Stakl an engineered character without turning ordinary labels into terminal text. The fonts are bundled locally with the embedded frontend, with system sans and system monospace fallbacks while fonts load. Use tabular numerals for changing counts and runtime values. Do not use all-caps section labels or tracked-out table headers.

| Role | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| Page title | 20 / 28 px | 600 | One per view |
| Section title | 14 / 20 px | 600 | Profiles, Applications, detail sections |
| Primary UI | 13 / 19 px | 400 or 500 | Navigation, rows, buttons, fields |
| App name | 13 / 19 px | 600 | Strongest item in each row |
| Supporting UI | 12 / 17 px | 400 | Descriptions, metadata, help |
| Technical data | 12 / 18 px mono | 400 or 500 | PID, command, path, port, log |
| Compact label | 11 / 16 px | 500 | Table heading, secondary controls; never smaller for essential text |

Use sentence case. Keep normal letter spacing except slight tightening on the page title. Do not enlarge empty states or view headings to create a hero. Long paths and commands wrap or scroll within their own region; application names can use two lines before truncation.

### Spacing and density

Base spacing steps: **4, 8, 12, 16, 24, 32 px**. Use 4 px within a control, 8 px between related controls, 12 to 16 px within a row, 24 px between sections, and 32 px only between major page regions. Standard controls are 32 to 36 px high. Desktop application rows target **60 to 64 px** with a meaningful second line, or **48 to 52 px** without one. Profile rows target 48 to 56 px. On touch devices, interactive targets grow to at least 44 px without inflating the whole desktop layout.

Density should come from fewer wrappers and consistent alignment, never 8 px labels or clipped information. Keep the search and filters in one compact toolbar above the inventory. Counts are inline text or filter controls, not large metric blocks.

### Color

The base palette uses neutral mineral grays with a green that has an operational job. These values pass at least 4.5:1 for the listed text colors against their primary panel surfaces; recheck contrast when combinations change.

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| Canvas | `#F2F4F3` | `#111816` | Work area background |
| Panel | `#FAFBFA` | `#17201D` | Rail, list, detail, menus |
| Raised | `#FFFFFF` | `#202B26` | Dialogs and popovers only |
| Inset | `#E9EDEB` | `#0D1411` | Code and log regions |
| Ink | `#1D2926` | `#EAF0EC` | Primary text |
| Secondary ink | `#50605A` | `#B1C0B7` | Metadata and labels |
| Quiet ink | `#66736F` | `#94A59A` | Timestamps and hints |
| Rule | `#CBD4CF` | `#35433C` | Structural separators |
| Operational green | `#176847` | `#68C48E` | Running, healthy, connected, Start, primary action |

Semantic colors: warning `#84551A` light / `#E0AD60` dark; error `#A33330` / `#F18F86`; external process `#406E84` / `#8FBED0`. These colors belong to state text, a small marker, or an action with matching meaning. Light green `#DDEFE4` and dark green `#1D3C2B` are available for a selected operational control or a brief confirmation, never a default panel fill. An occupied port is factual and neutral; use error red only for an actual conflict or failed operation.

### Light and dark themes

Both themes use the same layout, type hierarchy, status words, and action priority. Light mode relies on differences between canvas and panel rather than shadows; dark mode uses graphite steps rather than pure black or a blanket green cast. Keep the rail neutral in both. Rules should separate adjacent regions without becoming a visible grid. Code and logs may have their own inset contrast, but syntax colors must remain readable in each theme. Follow the system setting by default, keep a manual light or dark choice, and preserve it across sessions. Check focus, selection, warning, error, and disabled controls in both themes independently.

### Surfaces, rules, and radius

Use the canvas for the workspace and the panel color for the list and detail pane. Raised color and shadow are reserved for floating menus, dialogs, and the command palette. The log viewer and YAML editor use the inset surface because they are distinct reading modes, not because they imitate a terminal.

One rule marks a real boundary: rail to workspace, toolbar to content, group to group, row to row, header to scroll region. Avoid outlining every item and then outlining its parent. Prefer a bottom rule on rows over individual row rectangles. Rules are 1 px; use a stronger selected indicator or a change of surface when selection needs more than a rule. No decorative vertical rules, green row-edge stripes, or shadows on static content.

Radius: **0 px** on list rows and attached panels, **4 px** on controls and menus, **6 px** on dialogs and detached popovers. Small status dots may be round. Do not make profile rows, app rows, icons, and badges into repeated rounded tiles.

## Interaction language

### Icons

Continue using Lucide at 16 px for navigation and actions, 14 px for supporting controls, with a consistent 1.75 to 2 px stroke. Icons clarify action or type; they do not sit inside colored squares by default. One small type icon may precede an application name when it improves scanning. Do not repeat the same icon in a row, its action, and its detail header. Icon-only actions need an accessible name and visible focus; the main lifecycle action keeps a text label.

### Hover, focus, selected, disabled

Hover changes a row or control to a subtle neutral surface. It must not be the only way to discover an action. Keyboard focus uses a visible 2 px outline with at least 2 px offset, in the operational green where contrast works, and remains visible within scroll containers. Selected navigation and tabs use stronger ink plus a neutral surface or underline; green is not the navigation selection color. Pressed toggles use a neutral fill and an explicit state label or accessible pressed state. Disabled controls remain legible and explain the constraint nearby or in the detail view; do not rely on opacity alone. Motion is limited to opening the detail pane, progress feedback, and state change; respect reduced motion.

### Navigation

The primary destinations are **Applications, Ports, Activity, Configuration, System**. Applications replaces the previous Overview destination. Favorites is an application filter and Discover apps opens from the Applications toolbar. The command palette is available through `Cmd/Ctrl+K` and the Find anything trigger. Theme choice and controller connection state live in the utility bar.

On narrow screens, navigation becomes a drawer with the current destination visible in the utility bar. The drawer closes after selection and returns focus to the trigger. Prioritize application name, state, and lifecycle action in the narrow list; move PID, logs, and secondary actions into detail or the overflow menu. Do not shrink core text below 12 px to preserve desktop columns. A detail pane opens beside the list on wide screens and full-screen on narrow screens; closing it returns focus to the application name that opened it. Preserve the current tab when live data refreshes.

### Application and profile rows

Application columns are **identity, state, runtime, actions**. Identity shows name first and one useful supporting line: description, working directory, or runner type. Runtime shows PID or Compose project and uptime when available. Keep ownership adjacent to state or runtime: **Owned**, **External**, or **Not running**. A green state must not imply Stakl can stop an externally owned process. Names open details. The full row gets hover feedback but does not become a hidden click target around nested controls.

The row's one always-visible lifecycle action is **Start** when stopped and **Stop** when owned and active. Start may use green text or the green primary treatment when it is the main action in the current context; Stop is neutral. Keep logs or details available directly, with restart, directory, terminal, link, and pin in a single secondary menu as space requires. Externally detected and unknown processes need an explicit explanation in details when lifecycle actions are unavailable. Keep pinning quiet: a small star or menu item, not a second navigation destination.

Profiles use the same ledger grammar above the applications: name, `running / total`, attention state if any member failed, and Start / Stop with Restart secondary. Show member names in a disclosure or detail region when needed rather than a truncated sentence inside a card. A profile's aggregate state is not a substitute for individual app states.

### Status system

Every status has a readable label. A 6 px dot is a scan aid, never the only signal. Use the same state language in the application list, profile list, detail view, ports, logs, and connection indicator.

| Runtime state | Treatment | Meaning |
| --- | --- | --- |
| Healthy | Green dot + `Healthy` | Running and passing a configured check |
| Running | Green dot + `Running` | Active; health is unverified or not configured |
| External | Blue dot + `External` | Detected outside Stakl; ownership is protected |
| Starting / Stopping | Amber dot + text | Transition in progress; motion only if useful |
| Unhealthy | Amber dot + `Unhealthy` | Active but failing a check |
| Failed | Red dot + `Failed` | Operation or process failed |
| Unknown | Amber dot + `Unknown` | Ownership or state cannot be verified; explain why |
| Stopped | Neutral dot + `Stopped` | No active managed process |

Controller connection uses `Connected` in green and `Reconnecting` in amber or neutral with persistent text. A failed event stream must not leave an old green live indicator. Health check results and activity history use the same labels with timestamps and explanatory messages. Avoid badge backgrounds for routine states; reserve a tinted inline notice for an action that needs attention.

### Action hierarchy

One primary filled green action per local context: **Start** a stopped app, **Start** a stopped profile, **Scan directory** in discovery, or **Save and reload** in configuration. Secondary actions are neutral text or quiet buttons. Global operations belong in an explicitly named **Workspace actions** menu, not a default green button that makes bulk work look routine. Restart is secondary. Stop is neutral but clear. Stop all and Force kill remain in confirmation flows; red is reserved for the destructive final action. Preserve current safeguards for external processes and unknown ownership.

Use exact verbs through the flow: `Start` then `Started`, `Save and reload` then `Configuration saved and reloaded`. Busy controls name the work (`Starting`, `Scanning`, `Saving`) and prevent duplicate activation. Show partial failures next to the affected app or profile when possible, with the actual error and a path to logs or configuration.

## View patterns

- **Application detail:** A tool pane with a compact identity header, state and ownership, actions, then Overview, Logs, Health, History, Configuration tabs. Replace the boxed two-column property grid with aligned definition rows. Commands, paths, ports, and containers use compact lists or code regions. Keep logs wide, selectable, and scannable; show timestamps, stream, follow and pause state, search, copy, and download without fake terminal chrome.
- **Ports:** Use one dense table with number, protocol, occupancy, process, address, and associated Stakl application. Keep configured but undetected ports visibly distinct from observed listeners. Place scan time and warning near the table toolbar. Do not paint every occupied port red.
- **Activity and health:** Use one chronological list with timestamp, event, application, and detail. Severity appears only where an event actually requires attention. Remove circular icon medallions from every entry.
- **Configuration and discovery:** Treat the file path and directory path as real technical data, not banner content. A single inline path row, editor, and validation results suffice. Preserve the explicit reveal step for secret-bearing YAML and the review step before adding a discovered app. Discovery results use the same list grammar as applications.
- **System:** Present controller facts as aligned label/value rows with Docker availability and internal logs beneath. It is a diagnostics view, not a second dashboard.

## Empty, loading, and error states

Empty regions keep their normal heading and toolbar, then provide one sentence and one next action. Examples: `No applications configured` with `Discover apps` and an `Edit configuration` link; `No matches` with `Clear filters`; `No health checks yet` with a concise explanation; `No ports detected` with `Refresh ports`. Avoid large icons and promotional language.

Loading keeps stable row or pane dimensions. On first load, show a short `Connecting to controller` state; on refresh, keep the last known data with a small in-place progress indicator and update time. Never replace the entire application ledger with a spinner on every event. Reduced-motion users get static progress text.

Errors name the failed operation and useful next step: `Configuration could not reload` plus the parser error and `Open configuration`; `Port scan failed` plus `Retry scan`; `Could not start API server` plus the backend message and `Open logs`. Keep errors near the affected view or row. A connection loss remains persistent in the utility bar until recovered. Success feedback can be brief and quiet; it should not compete with the updated row state.

## Implemented redesign

| Previous UI | Current implementation |
| --- | --- |
| Five-cell `.summary` strip | Inline application, running, and attention counts in the Applications toolbar. |
| `.profile-card` grid | Profile rows in one section above applications. |
| Rounded `.app-table`, `.app-symbol` tiles, green row edge, filled status chips | Flat ledger surface, plain type icons, row dividers, and dot-plus-label status. |
| Separate Favorites navigation item | Application filter with pinning available from each row's menu. |
| Discover apps navigation item | Applications toolbar and empty state. |
| `.local-tag`, `.local-note`, `.dashboard-footer`, repeated `Live status` labels | One controller connection indicator in the utility bar. |
| Three-button `.theme-switch` in the rail | Theme selector in the utility bar. |
| `.properties` boxed cells, `.config-banner`, decorative timeline icon circles | Aligned rows with structural rules. |
| Centered `.onboarding` panel and shared large-icon `.empty` treatment | Contextual, left-aligned states in the normal content flow. |
| Repeated action icons in every app row | Direct log and lifecycle controls; secondary actions in the row menu. |

Keep the existing command palette, detail tabs, live log controls, YAML reveal and backup behavior, discovery review, confirmation gates, semantic status labels, dark/light/system support, and keyboard access. Their behavior fits the product; their surfaces and spacing should follow this system.

## Review against the brief

The obvious first pass would keep the dark green sidebar and turn every process into a sharper card. That would still read as a SaaS dashboard. This direction instead makes the application ledger the main artifact, gives profiles the same row language, removes the metric strip, and uses green only for actual operation and state. The strongest visual cue comes from alignment and typography rather than decoration. The result should feel credible with two apps or two hundred, in light and dark mode, without inventing data to fill space.

## Implementation primitives

Applications is the reference for the workstation layout. The shared primitives also support Ports, Activity, Configuration, discovery, System, and application details. Keep screen-specific behavior and responsive choices in their owning view.

| Primitive | Implementation | Use |
| --- | --- | --- |
| Page structure and heading | `workstation-page` and `PageHeader` | Neutral workspace surface, compact title, optional description and actions. |
| Section and toolbar | `workstation-section-heading`, `workstation-toolbar`, `SearchField` | Align headings and controls without adding a container. Keep filters in one toolbar when width allows. |
| Flat lists | `workstation-list`, `workstation-list-row`, `workstation-ledger-grid` | One surface with row rules and hover. A ledger sets its own `--ledger-columns`; the header and rows share the grid. |
| State and actions | `StatusIndicator`, `IconButton`, existing `.button` variants, `workstation-action-row` | State is a dot plus word. Keep one lifecycle action visible; use the existing Radix `.dropdown` menu for secondary actions. |
| Empty states | `EmptyState` with optional `plain` treatment | Keep the heading and toolbar in place and provide a next action. |

React primitives live in `web/src/ui.tsx`; canonical shell, application ledger, detail, and workspace view styles live in `web/src/workstation.css`. `web/src/style.css` retains shared base styles. Application runtime details, profile membership, and responsive column choices stay in the Applications implementation because they express that screen's content, not a universal component API. A generic raised panel is intentionally absent: the list surface is flat, while dialogs and menus retain their existing floating surfaces. See [the README](../README.md) for current light, dark, logs, and mobile captures.

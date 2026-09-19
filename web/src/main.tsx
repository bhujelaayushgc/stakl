import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Box,
  Check,
  ChevronRight,
  Command,
  Copy,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  HeartPulse,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Star,
  Sun,
  Moon,
  Monitor,
  Terminal,
  Trash2,
  WrapText,
  X,
  AlertCircle,
  Clock,
  Pin,
  Radio,
  Server,
  CheckCircle2,
} from "lucide-react";
import Prism from "prismjs";
import "prismjs/components/prism-yaml";
import YAML from "yaml";
import {
  App,
  Config,
  Event,
  Health,
  LogLine,
  Profile,
  Status,
  elapsed,
  filterApps,
  isActive,
  label,
  profileState,
  request,
  typeLabel,
  servicePorts,
} from "./types";
import { PortsPage, usePortScan } from "./Ports";
import "./style.css";

type Action = (id: string, action: string, profile?: boolean) => Promise<void>;
const icons = {
  process: Terminal,
  shell: Terminal,
  "docker-compose": Box,
  custom: Settings2,
};
const appIcon = (a: App["config"]) =>
  (
    ({
      terminal: Terminal,
      box: Box,
      server: Server,
      activity: Activity,
      layers: Layers3,
      code: FileCode2,
      folder: Folder,
      heart: HeartPulse,
    }) as Record<string, typeof Terminal>
  )[a.icon || ""] ||
  icons[a.type as keyof typeof icons] ||
  Terminal;
function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {label(status)}
    </span>
  );
}
function IconButton({
  label: tip,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className="icon-button" title={tip} aria-label={tip} {...props}>
      {children}
    </button>
  );
}
function Empty({
  icon: Icon = Layers3,
  title,
  children,
}: {
  icon?: typeof Layers3;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon size={28} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
function AppShell() {
  const [apps, setApps] = useState<App[]>([]),
    [cfg, setCfg] = useState<Config | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [connected, setConnected] = useState(false),
    [page, setPage] = useState("dashboard"),
    [selected, setSelected] = useState<string | null>(null),
    [detailTab, setDetailTab] = useState("Overview"),
    [busy, setBusy] = useState<Set<string>>(new Set()),
    [search, setSearch] = useState(""),
    [group, setGroup] = useState(""),
    [status, setStatus] = useState(""),
    [type, setType] = useState(""),
    [favorites, setFavorites] = useState(false),
    [palette, setPalette] = useState(false),
    [confirm, setConfirm] = useState<{
      title: string;
      message: string;
      run: () => void;
    } | null>(null),
    [theme, setTheme] = useState(
      localStorage.getItem("stakl-theme") || "system",
    ),
    [pins, setPins] = useState<Record<string, boolean>>(() =>
      (() => {
        try {
          return JSON.parse(localStorage.getItem("stakl-pins") || "{}");
        } catch {
          return {};
        }
      })(),
    ),
    [mobileNav, setMobileNav] = useState(false);
  const mounted = useRef(true);
  const ports = usePortScan(page === "ports" || !!selected);
  const refresh = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        request<App[]>("/apps"),
        request<Config>("/config"),
      ]);
      if (mounted.current) {
        setApps(a);
        setCfg(c);
      }
    } catch (e) {
      if (mounted.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.addEventListener("ready", () => {
      setConnected(true);
      refresh();
    });
    let timer: ReturnType<typeof setTimeout>;
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 80);
    };
    es.onerror = () => setConnected(false);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      mounted.current = false;
      es.close();
      clearTimeout(timer);
      window.removeEventListener("keydown", key);
    };
  }, [refresh]);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (mq.matches ? "dark" : "light") : theme);
    apply();
    mq.addEventListener("change", apply);
    localStorage.setItem("stakl-theme", theme);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 7000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const run: Action = async (id, action, profile = false) => {
    setError("");
    const key = (profile ? "profile:" : "") + id;
    setBusy((b) => new Set(b).add(key));
    try {
      const result = await request<Record<string, string>>(
        `/${profile ? "profiles" : "apps"}/${encodeURIComponent(id)}/${action}`,
        {},
      );
      const failures = Object.entries(result).filter(
        ([, v]) => typeof v === "string" && v !== "ok",
      );
      if (failures.length)
        throw Error(failures.map(([k, v]) => `${k}: ${v}`).join("\n"));
      setNotice(
        `${profile ? "Profile" : apps.find((a) => a.config.id === id)?.config.name || id}: ${action} complete`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
      refresh();
    }
  };
  const globalAction = async (action: string) => {
    setBusy((b) => new Set(b).add("global"));
    try {
      const result = await request<Record<string, string>>(
        `/actions/${action}${action === "stop" ? "?confirm=true" : ""}`,
        {},
      );
      const errors = Object.entries(result).filter(([, v]) => v !== "ok");
      if (errors.length)
        throw Error(errors.map(([k, v]) => `${k}: ${v}`).join("\n"));
      setNotice(`${action} completed`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete("global");
        return n;
      });
      refresh();
    }
  };
  const openDetail = (id: string, tab = "Overview") => {
    setSelected(id);
    setDetailTab(tab);
  };
  const pinned = useMemo(
    () =>
      new Set(
        apps
          .filter((a) => pins[a.config.id] ?? a.config.favorite)
          .map((a) => a.config.id),
      ),
    [apps, pins],
  );
  const pin = (id: string) =>
    setPins((p) => {
      const n = { ...p, [id]: !pinned.has(id) };
      localStorage.setItem("stakl-pins", JSON.stringify(n));
      return n;
    });
  const filtered = filterApps(
    apps,
    search,
    group,
    status,
    type,
    pinned,
    favorites,
  );
  const groups = Object.entries(cfg?.groups || {}).sort(
    (a, b) => a[1].order - b[1].order,
  );
  if (apps.some((a) => !a.config.group))
    groups.push(["", { name: "Ungrouped", order: 999 }]);
  const current = apps.find((a) => a.config.id === selected);
  const reload = async () => {
    try {
      await request("/config/reload", {});
      await refresh();
      setNotice("Configuration reloaded");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const nav = (p: string) => {
    setPage(p);
    setMobileNav(false);
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            nav("dashboard");
          }}
        >
          <span className="brand-mark">
            <Terminal size={21} />
          </span>
          Stakl<span className="local-tag">LOCAL</span>
        </a>
        <button className="palette-trigger" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          <button
            className={page === "dashboard" && !favorites ? "active" : ""}
            onClick={() => {
              nav("dashboard");
              setFavorites(false);
            }}
          >
            <LayoutDashboard />
            Overview<span className="nav-count">{apps.length}</span>
          </button>
          <button
            className={page === "dashboard" && favorites ? "active" : ""}
            onClick={() => {
              nav("dashboard");
              setFavorites(true);
            }}
          >
            <Star />
            Favorites<span className="nav-count">{pinned.size}</span>
          </button>
          <button
            className={page === "activity" ? "active" : ""}
            onClick={() => nav("activity")}
          >
            <Activity />
            Activity
          </button>
          <div className="nav-separator" />
          <button
            className={page === "ports" ? "active" : ""}
            onClick={() => nav("ports")}
          >
            <Radio />
            Ports
          </button>
          <button
            className={page === "discover" ? "active" : ""}
            onClick={() => nav("discover")}
          >
            <FolderOpen />
            Discover apps
          </button>
          <button
            className={page === "config" ? "active" : ""}
            onClick={() => nav("config")}
          >
            <FileCode2 />
            Configuration
          </button>
          <button
            className={page === "system" ? "active" : ""}
            onClick={() => nav("system")}
          >
            <Server />
            System
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="theme-switch" role="group" aria-label="Color theme">
            {[
              ["light", Sun],
              ["dark", Moon],
              ["system", Monitor],
            ].map(([t, Icon]) => (
              <button
                key={String(t)}
                title={`${t} theme`}
                aria-label={`${t} theme`}
                aria-pressed={theme === t}
                className={theme === t ? "selected" : ""}
                onClick={() => setTheme(String(t))}
              >
                {React.createElement(Icon, { size: 15 })}
              </button>
            ))}
          </div>
          <div className="connection">
            <span className={`connection-dot ${connected ? "online" : ""}`} />
            <span>{connected ? "Controller connected" : "Reconnecting…"}</span>
            <Radio size={13} />
          </div>
          <div className="local-note">Your machine. Your services.</div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              label="Toggle navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={17} />
            </IconButton>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {
                (
                  {
                    dashboard: "Overview",
                    activity: "Activity",
                    config: "Configuration",
                    discover: "Discover apps",
                    system: "System",
                    ports: "Ports",
                  } as Record<string, string>
                )[page]
              }
            </strong>
          </div>
          <div className="topbar-right">
            <span className="host-label">
              <Monitor size={13} /> Local machine
            </span>
            <IconButton label="Reload configuration" onClick={reload}>
              <RefreshCw size={15} />
            </IconButton>
          </div>
        </header>
        <main>
          {error && (
            <div className="alert error" role="alert">
              <AlertCircle size={18} />
              <div>
                <strong>Something needs attention</strong>
                <pre>{error}</pre>
              </div>
              <IconButton label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          {cfg?.error && (
            <div className="alert warning" role="alert">
              <AlertCircle size={18} />
              <div>
                <strong>Configuration could not reload</strong>
                <p>{cfg.error}</p>
                <button className="text-button" onClick={() => nav("config")}>
                  Open configuration
                </button>
              </div>
            </div>
          )}
          {page === "dashboard" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>{favorites ? "Favorites" : "Overview"}</h1>
                  <p>Everything you run, in one place.</p>
                </div>
                <div className="heading-actions">
                  <button className="button" onClick={() => nav("discover")}>
                    <Plus size={15} />
                    Add application
                  </button>
                  <Dropdown.Root>
                    <Dropdown.Trigger asChild>
                      <button
                        className="button primary"
                        disabled={busy.has("global")}
                      >
                        {busy.has("global") ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Play size={14} />
                        )}
                        Workspace actions
                        <ChevronRight className="rotate-down" size={14} />
                      </button>
                    </Dropdown.Trigger>
                    <Dropdown.Portal>
                      <Dropdown.Content className="dropdown" align="end">
                        <Dropdown.Item onSelect={() => globalAction("start")}>
                          <Play />
                          Start all
                        </Dropdown.Item>
                        <Dropdown.Item onSelect={() => globalAction("restart")}>
                          <RefreshCw />
                          Restart running
                        </Dropdown.Item>
                        <Dropdown.Separator />
                        <Dropdown.Item
                          className="danger"
                          onSelect={() =>
                            setConfirm({
                              title: "Stop all applications?",
                              message:
                                "This stops all included applications. Configured exclusions and externally detected processes are protected.",
                              run: () => globalAction("stop"),
                            })
                          }
                        >
                          <Square />
                          Stop all
                        </Dropdown.Item>
                      </Dropdown.Content>
                    </Dropdown.Portal>
                  </Dropdown.Root>
                </div>
              </div>
              <div className="summary" aria-label="Application summary">
                {[
                  {
                    name: "Configured",
                    count: apps.length,
                    state: "configured",
                  },
                  {
                    name: "Running",
                    count: apps.filter((a) => isActive(a.runtime.state)).length,
                    state: "running",
                  },
                  {
                    name: "Healthy",
                    count: apps.filter((a) => a.runtime.health === "healthy")
                      .length,
                    state: "healthy",
                  },
                  {
                    name: "Needs attention",
                    count: apps.filter((a) =>
                      ["unhealthy", "failed", "unknown"].includes(
                        a.runtime.state,
                      ),
                    ).length,
                    state: "unhealthy",
                  },
                  {
                    name: "Stopped",
                    count: apps.filter((a) => a.runtime.state === "stopped")
                      .length,
                    state: "stopped",
                  },
                ].map((s) => (
                  <button
                    key={s.name}
                    onClick={() =>
                      setStatus(
                        s.state === "configured"
                          ? ""
                          : s.state === "running"
                            ? "active"
                            : s.state === "unhealthy"
                              ? "attention"
                              : s.state,
                      )
                    }
                  >
                    <span className={`summary-indicator ${s.state}`} />
                    <strong>{s.count}</strong>
                    <span>{s.name}</span>
                  </button>
                ))}
              </div>
              {Object.keys(cfg?.profiles || {}).length > 0 && (
                <section className="profiles-section">
                  <div className="section-heading">
                    <h2>Profiles</h2>
                    <span>Start a whole environment together</span>
                  </div>
                  <div className="profiles">
                    {Object.entries(cfg!.profiles).map(([id, p]) => (
                      <ProfileCard
                        key={id}
                        id={id}
                        profile={p}
                        apps={apps}
                        busy={busy.has("profile:" + id)}
                        run={run}
                      />
                    ))}
                  </div>
                </section>
              )}
              <section className="applications">
                <div className="section-heading">
                  <h2>
                    Applications{" "}
                    <span className="count">{filtered.length}</span>
                  </h2>
                  <span>Live status</span>
                </div>
                <div className="filterbar">
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search applications"
                      placeholder="Search applications…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        aria-label="Clear search"
                        onClick={() => setSearch("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <select
                    aria-label="Filter group"
                    value={group}
                    onChange={(e) => setGroup(e.target.value)}
                  >
                    <option value="">All groups</option>
                    {groups
                      .filter(([id]) => id)
                      .map(([id, g]) => (
                        <option key={id} value={id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label="Filter status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {[
                      "active",
                      "attention",
                      "healthy",
                      "running",
                      "unhealthy",
                      "stopped",
                      "external",
                      "failed",
                      "unknown",
                      "starting",
                      "stopping",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter type"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  >
                    <option value="">All types</option>
                    {["process", "shell", "docker-compose", "custom"].map(
                      (s) => (
                        <option key={s} value={s}>
                          {typeLabel(s)}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                {loading ? (
                  <div className="loading">
                    <LoaderCircle className="spin" />
                    Connecting to your workspace…
                  </div>
                ) : apps.length === 0 ? (
                  <div className="onboarding">
                    <div className="onboarding-icon">
                      <Terminal size={28} />
                    </div>
                    <h2>A home for everything you run.</h2>
                    <p>
                      Add your first application to start, stop, and monitor it
                      here. Stakl keeps the commands so you don’t have to.
                    </p>
                    <div className="onboarding-actions">
                      <button
                        className="button primary"
                        onClick={() => nav("discover")}
                      >
                        <FolderOpen size={16} />
                        Discover local projects
                      </button>
                      <button className="button" onClick={() => nav("config")}>
                        <FileCode2 size={16} />
                        Edit configuration
                      </button>
                    </div>
                    <div className="config-location">
                      <Folder size={14} />
                      <code>{cfg?.path}</code>
                    </div>
                    <div className="onboarding-footnote">
                      Processes stay running when Stakl closes. Your YAML
                      stays yours.
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <Empty icon={Search} title="No matching applications">
                    <p>Try another search or clear your filters.</p>
                    <button
                      className="button"
                      onClick={() => {
                        setSearch("");
                        setGroup("");
                        setStatus("");
                        setType("");
                        setFavorites(false);
                      }}
                    >
                      Clear filters
                    </button>
                  </Empty>
                ) : (
                  groups.map(([id, g]) => {
                    const rows = filtered.filter((a) => a.config.group === id);
                    return (
                      rows.length > 0 && (
                        <div className="app-group" key={id}>
                          <div className="group-heading">
                            <Folder size={15} />
                            <h3>{g.name}</h3>
                            <span>{rows.length}</span>
                          </div>
                          <div className="app-table">
                            <div className="table-head">
                              <span>APPLICATION</span>
                              <span>STATUS</span>
                              <span>RUNTIME</span>
                              <span>ACTIONS</span>
                            </div>
                            {rows
                              .sort(
                                (a, b) =>
                                  Number(pinned.has(b.config.id)) -
                                    Number(pinned.has(a.config.id)) ||
                                  a.config.name.localeCompare(b.config.name),
                              )
                              .map((a) => (
                                <AppRow
                                  key={a.config.id}
                                  app={a}
                                  busy={busy.has(a.config.id)}
                                  pinned={pinned.has(a.config.id)}
                                  onPin={() => pin(a.config.id)}
                                  run={run}
                                  onOpen={(tab) => openDetail(a.config.id, tab)}
                                />
                              ))}
                          </div>
                        </div>
                      )
                    );
                  })
                )}
              </section>
              <div className="dashboard-footer">
                <span>
                  <span className="connection-dot online" /> Changes appear
                  automatically
                </span>
                <button onClick={() => nav("config")}>
                  <FileCode2 size={13} />
                  YAML is the source of truth
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </>
          )}
          {page === "config" && (
            <ConfigPage
              cfg={cfg}
              refresh={refresh}
              onError={setError}
              onNotice={(message) => {
                setError("");
                setNotice(message);
              }}
            />
          )}
          {page === "discover" && (
            <DiscoverPage
              cfg={cfg}
              onAdded={() => {
                refresh();
                nav("dashboard");
              }}
              onError={setError}
            />
          )}
          {page === "activity" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Activity</h1>
                  <p>Starts, stops, recovery, and everything in between.</p>
                </div>
              </div>
              <Timeline />
            </>
          )}
          {page === "system" && <SystemPage />}
          {page === "ports" && <PortsPage apps={apps} {...ports} />}
        </main>
      </div>
      <Dialog.Root
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="detail-panel" aria-describedby={undefined}>
            {current ? (
              <>
                <div className="detail-header">
                  <div className="app-symbol">
                    {React.createElement(appIcon(current.config), { size: 23 })}
                  </div>
                  <div>
                    <Dialog.Title>{current.config.name}</Dialog.Title>
                    <span>
                      {typeLabel(current.config.type)}
                      <span className="dot-separator">·</span>
                      {current.config.id}
                    </span>
                  </div>
                  <Dialog.Close asChild>
                    <IconButton label="Close application details">
                      <X size={20} />
                    </IconButton>
                  </Dialog.Close>
                </div>
                <Detail
                  app={current}
                  portScan={ports}
                  tab={detailTab}
                  setTab={setDetailTab}
                  run={run}
                  busy={busy.has(current.config.id)}
                  confirm={(run) =>
                    setConfirm({
                      title: "Force kill application?",
                      message:
                        "Immediately kills the owned process group. Unsaved work in that application may be lost.",
                      run,
                    })
                  }
                />
              </>
            ) : (
              <Dialog.Title>Application unavailable</Dialog.Title>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={palette} onOpenChange={setPalette}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="palette-dialog"
            aria-describedby={undefined}
          >
            <Dialog.Title className="sr-only">Command palette</Dialog.Title>
            <Palette
              apps={apps}
              profiles={cfg?.profiles || {}}
              onRun={(fn) => {
                setPalette(false);
                fn();
              }}
              run={run}
              open={openDetail}
              reload={reload}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="confirm-dialog">
            <AlertCircle className="danger" />
            <Dialog.Title>{confirm?.title}</Dialog.Title>
            <Dialog.Description>{confirm?.message}</Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button className="button">Cancel</button>
              </Dialog.Close>
              <button
                className="button destructive"
                onClick={() => {
                  confirm?.run();
                  setConfirm(null);
                }}
              >
                Confirm
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {notice}
          <IconButton
            label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
function ProfileCard({
  id,
  profile,
  apps,
  busy,
  run,
}: {
  id: string;
  profile: Profile;
  apps: App[];
  busy: boolean;
  run: Action;
}) {
  const s = profileState(profile, apps);
  return (
    <article className="profile-card">
      <div className="profile-title">
        <span className="profile-icon">
          <Layers3 size={17} />
        </span>
        <h3>{profile.name}</h3>
        <span className={`profile-state ${s.failed ? "danger" : ""}`}>
          {s.running === 0 ? "Stopped" : `${s.running}/${s.total} running`}
        </span>
      </div>
      <p>
        {profile.apps
          .map((id) => apps.find((a) => a.config.id === id)?.config.name || id)
          .join(" · ")}
      </p>
      <div className="profile-footer">
        <span>{s.total} applications</span>
        <div>
          {s.running > 0 && (
            <IconButton
              label={`Restart ${profile.name}`}
              disabled={busy}
              onClick={() => run(id, "restart", true)}
            >
              <RefreshCw size={14} />
            </IconButton>
          )}
          <button
            className="button small"
            disabled={busy}
            onClick={() => run(id, s.running ? "stop" : "start", true)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={13} />
            ) : s.running ? (
              <Square size={12} />
            ) : (
              <Play size={12} />
            )}{" "}
            {s.running ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </article>
  );
}
function AppRow({
  app: a,
  busy,
  pinned,
  onPin,
  run,
  onOpen,
}: {
  app: App;
  busy: boolean;
  pinned: boolean;
  onPin: () => void;
  run: Action;
  onOpen: (tab?: string) => void;
}) {
  const active = isActive(a.runtime.state),
    external = a.runtime.state === "external",
    canStop =
      !external || (a.config.type === "custom" && !!a.config.stop.command);
  const link = Object.values(a.config.links || {})[0];
  return (
    <div className="app-row">
      <div className="app-identity">
        <div
          className={`app-symbol ${a.config.type === "docker-compose" ? "compose-symbol" : ""}`}
        >
          {React.createElement(appIcon(a.config), { size: 20 })}
        </div>
        <div className="app-name">
          <button onClick={() => onOpen()}>
            {a.config.name}
            {pinned && <Pin size={11} />}
          </button>
          <span>
            {a.config.description || typeLabel(a.config.type)}
            {a.config.autostart.enabled && (
              <span className="autostart">Auto</span>
            )}
          </span>
        </div>
      </div>
      <div>
        <StatusBadge status={a.runtime.state} />
        {a.runtime.next_restart && (
          <small className="retry-note">Retry scheduled</small>
        )}
      </div>
      <div className="runtime-cell">
        <span>
          {a.runtime.pid
            ? `PID ${a.runtime.pid}`
            : a.config.type === "docker-compose"
              ? "Compose project"
              : "-"}
        </span>
      </div>
      <div className="row-actions">
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="icon-button"
            aria-label={`Open ${a.config.name}`}
            title="Open app"
          >
            <ArrowUpRight size={17} />
          </a>
        )}
        <IconButton
          label={`Logs for ${a.config.name}`}
          onClick={() => onOpen("Logs")}
        >
          <Terminal size={16} />
        </IconButton>
        {active && canStop && (
          <IconButton
            label={`Restart ${a.config.name}`}
            disabled={busy}
            onClick={() => run(a.config.id, "restart")}
          >
            <RefreshCw size={15} />
          </IconButton>
        )}
        <button
          className={`button small ${!active ? "start-button" : ""}`}
          disabled={
            busy || (active && !canStop) || a.runtime.state === "unknown"
          }
          onClick={() => run(a.config.id, active ? "stop" : "start")}
        >
          {busy ? (
            <LoaderCircle className="spin" size={13} />
          ) : active ? (
            <Square size={12} />
          ) : (
            <Play size={12} />
          )}
          <span>{active ? "Stop" : "Start"}</span>
        </button>
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <IconButton label={`More actions for ${a.config.name}`}>
              <MoreHorizontal size={17} />
            </IconButton>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown" align="end">
              <Dropdown.Item onSelect={() => onOpen()}>
                <Activity />
                More info
              </Dropdown.Item>
              <Dropdown.Item onSelect={onPin}>
                <Star />
                {pinned ? "Unpin" : "Pin to favorites"}
              </Dropdown.Item>
              <Dropdown.Separator />
              <Dropdown.Item onSelect={() => run(a.config.id, "directory")}>
                <FolderOpen />
                Open directory
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => run(a.config.id, "terminal")}>
                <Terminal />
                Open terminal here
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </div>
  );
}
function Detail({
  app: a,
  portScan,
  tab,
  setTab,
  run,
  busy,
  confirm,
}: {
  app: App;
  portScan: ReturnType<typeof usePortScan>;
  tab: string;
  setTab: (s: string) => void;
  run: Action;
  busy: boolean;
  confirm: (f: () => void) => void;
}) {
  const active = isActive(a.runtime.state);
  const portList = servicePorts(a, portScan.scan?.ports || []);
  const canStop =
    a.runtime.owned || (a.config.type === "custom" && a.config.stop.command);
  return (
    <>
      <div className="detail-status">
        <StatusBadge status={a.runtime.state} />
        <span>
          {a.runtime.owned
            ? "Managed by Stakl"
            : a.runtime.state === "external"
              ? "External process"
              : "Not running"}
        </span>
      </div>
      <div className="detail-actions">
        <button
          className="button primary"
          disabled={
            busy || (active && !canStop) || a.runtime.state === "unknown"
          }
          onClick={() => run(a.config.id, active ? "stop" : "start")}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} />
          ) : active ? (
            <Square size={13} />
          ) : (
            <Play size={13} />
          )}{" "}
          {active ? "Stop" : "Start"}
        </button>
        <button
          className="button"
          disabled={busy || (active && !canStop)}
          onClick={() => run(a.config.id, "restart")}
        >
          <RefreshCw size={14} />
          Restart
        </button>
        {Object.entries(a.config.links || {}).map(([name, url]) => (
          <a
            className="button"
            key={name}
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {name}
            <ArrowUpRight size={14} />
          </a>
        ))}
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label="Application detail"
        onKeyDown={(e) => {
          const tabs = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          );
          const current = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            e.key === "ArrowRight"
              ? (current + 1) % tabs.length
              : e.key === "ArrowLeft"
                ? (current - 1 + tabs.length) % tabs.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (next >= 0) {
            e.preventDefault();
            tabs[next].focus();
            tabs[next].click();
          }
        }}
      >
        {["Overview", "Logs", "Health", "History", "Configuration"].map((t) => (
          <button
            role="tab"
            id={`detail-tab-${t}`}
            aria-controls="detail-tabpanel"
            tabIndex={tab === t ? 0 : -1}
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div
        className={`detail-body ${tab === "Logs" ? "logs-body" : ""}`}
        role="tabpanel"
        id="detail-tabpanel"
        aria-labelledby={`detail-tab-${tab}`}
      >
        {a.runtime.error && (
          <div className="alert error">
            <AlertCircle size={17} />
            <pre>{a.runtime.error}</pre>
          </div>
        )}
        {tab === "Overview" && (
          <>
            {a.config.description && (
              <p className="detail-description">{a.config.description}</p>
            )}
            <dl className="properties">
              {Object.entries({
                Ownership: a.runtime.owned
                  ? "Owned process"
                  : a.runtime.state === "external"
                    ? "External (protected)"
                    : "None",
                "Process ID": a.runtime.pid || "-",
                "Process group": a.runtime.pgid || "-",
                Uptime: active ? elapsed(a.runtime.started) : "-",
                Health: a.runtime.health,
                Restarts: a.runtime.restart_count,
                "Last exit code": a.runtime.exit_code ?? "-",
                "Launch instance": a.runtime.launch || "-",
              }).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <h3>Working directory</h3>
            <code className="code-block">{a.config.cwd}</code>
            <div className="inline-actions">
              <button
                className="button small"
                onClick={() => run(a.config.id, "directory")}
              >
                <FolderOpen size={14} />
                Open directory
              </button>
              <button
                className="button small"
                onClick={() => run(a.config.id, "terminal")}
              >
                <Terminal size={14} />
                Open terminal here
              </button>
            </div>
            <h3>Start command</h3>
            <code className="code-block">
              {a.config.type === "docker-compose"
                ? `docker compose -f ${a.config.docker.compose_file} --project-name ${a.config.docker.project_name} up -d`
                : a.config.start.command}
            </code>
            {Object.keys(a.config.depends_on || {}).length > 0 && (
              <>
                <h3>Dependencies</h3>
                <div className="tag-list">
                  {Object.entries(a.config.depends_on).map(([id, d]) => (
                    <span className="tag" key={id}>
                      {id}
                      <span>{d.condition || "running"}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
            <h3>Ports</h3>
            {portScan.error && (
              <p className="alert error" role="alert">
                {portScan.error}
              </p>
            )}
            {portScan.scan?.warning && (
              <p className="muted">
                Some ports may be missing: {portScan.scan.warning}
              </p>
            )}
            <div className="port-list">
              {portList.map((p) => (
                <div key={`${p.protocol}:${p.port}`}>
                  <span>{p.protocol}</span>
                  <code>:{p.port}</code>
                  <span
                    className={`status ${p.occupied ? "status-running" : "status-stopped"}`}
                  >
                    <span className="status-dot" />
                    {p.occupied ? "Occupied" : "Not detected"}
                  </span>
                </div>
              ))}
            </div>
            {portList.length === 0 && (
              <p className="muted">
                {!active
                  ? "No ports configured. Stopped services have no live ports to detect."
                  : !portScan.scan && !portScan.error
                    ? "Detecting ports…"
                    : "No ports associated with this service. For externally managed services, declare ports in the application configuration."}
              </p>
            )}
            <button
              className="button small"
              disabled={portScan.loading}
              onClick={portScan.refresh}
            >
              <RefreshCw size={14} className={portScan.loading ? "spin" : ""} />
              {portScan.loading ? "Scanning…" : "Refresh ports"}
            </button>
            {a.containers.length > 0 && (
              <>
                <h3>Compose containers</h3>
                <div className="container-list">
                  {a.containers.map((c) => (
                    <div key={c.name}>
                      <Box size={15} />
                      <span>{c.name}</span>
                      <StatusBadge status={c.health || c.state} />
                    </div>
                  ))}
                </div>
              </>
            )}
            {a.config.notes && (
              <>
                <h3>Notes</h3>
                <p className="notes">{a.config.notes}</p>
              </>
            )}
            {a.runtime.owned &&
              active &&
              (a.runtime.launch || a.config.type === "docker-compose") && (
                <div className="danger-zone">
                  <span>Process not responding?</span>
                  <button
                    className="button small danger"
                    onClick={() => confirm(() => run(a.config.id, "kill"))}
                  >
                    Force kill
                  </button>
                </div>
              )}
          </>
        )}
        {tab === "Logs" && <LogViewer id={a.config.id} />}{" "}
        {tab === "Health" && (
          <HealthHistory id={a.config.id} hasCheck={!!a.config.health.type} />
        )}{" "}
        {tab === "History" && <Timeline id={a.config.id} />}{" "}
        {tab === "Configuration" && (
          <>
            <p className="muted">
              Effective configuration. Environment values are redacted. Edit the
              source YAML from Configuration.
            </p>
            <pre className="code-block config-code">
              {JSON.stringify(a.effective_config || a.config, null, 2)}
            </pre>
          </>
        )}
      </div>
    </>
  );
}
function LogViewer({ id }: { id: string }) {
  const [lines, setLines] = useState<LogLine[]>([]),
    [paused, setPaused] = useState(false),
    [follow, setFollow] = useState(true),
    [wrap, setWrap] = useState(false),
    [timestamps, setTimestamps] = useState(true),
    [search, setSearch] = useState(""),
    [stream, setStream] = useState(""),
    [connected, setConnected] = useState(false),
    [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null),
    pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    setLines([]);
    const es = new EventSource(
      `/api/apps/${encodeURIComponent(id)}/logs?follow=true`,
    );
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      if (!pausedRef.current) {
        try {
          const line = JSON.parse(e.data);
          setLines((l) => [...l, line].slice(-5000));
        } catch {
          setError("Could not decode log event");
        }
      }
    };
    return () => es.close();
  }, [id]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  const shown = lines.filter(
    (l) =>
      (!stream || l.stream === stream) &&
      l.text.toLowerCase().includes(search.toLowerCase()),
  );
  const text = shown
    .map(
      (l) =>
        `${timestamps ? new Date(l.time).toLocaleTimeString() + " " : ""}[${l.stream}] ${l.text}`,
    )
    .join("\n");
  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Search logs"
            placeholder="Search logs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Log stream"
          value={stream}
          onChange={(e) => setStream(e.target.value)}
        >
          <option value="">All streams</option>
          <option>stdout</option>
          <option>stderr</option>
        </select>
      </div>
      <div className="log-controls">
        <div>
          <IconButton
            label={paused ? "Resume logs" : "Pause logs"}
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </IconButton>
          <IconButton
            label="Follow tail"
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <ArrowDownToLine size={15} />
          </IconButton>
          <IconButton
            label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={15} />
          </IconButton>
          <IconButton
            label="Toggle timestamps"
            aria-pressed={timestamps}
            onClick={() => setTimestamps(!timestamps)}
          >
            <Clock size={15} />
          </IconButton>
        </div>
        <div>
          <IconButton
            label="Copy displayed logs"
            onClick={() =>
              navigator.clipboard
                .writeText(text)
                .catch((e) => setError(e.message))
            }
          >
            <Copy size={15} />
          </IconButton>
          <a
            className="icon-button"
            href={`/api/apps/${encodeURIComponent(id)}/logs?download=true`}
            aria-label="Download logs"
            title="Download logs"
          >
            <ArrowDownToLine size={15} />
          </a>
          <IconButton label="Clear display" onClick={() => setLines([])}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div
        className={`log-output ${wrap ? "wrap" : ""}`}
        ref={box}
        tabIndex={0}
        aria-label="Application log output"
      >
        {shown.length ? (
          shown.map((l) => (
            <div
              className={`log-line ${l.stream}`}
              key={`${l.launch}:${l.seq}`}
            >
              {timestamps && (
                <time>{new Date(l.time).toLocaleTimeString("en-GB")}</time>
              )}
              <span className="stream-label">
                {l.stream === "stderr" ? "ERR" : "OUT"}
              </span>
              <span>{l.text || " "}</span>
            </div>
          ))
        ) : (
          <div className="log-empty">
            {lines.length
              ? "No lines match your filters."
              : "Waiting for log output. Start the application to capture logs."}
          </div>
        )}
      </div>
      <div className="log-footer">
        <span>
          <span
            className={`connection-dot ${connected && !paused ? "online" : ""}`}
          />
          {paused
            ? "Paused (incoming lines skipped)"
            : connected
              ? "Live stream"
              : "Reconnecting…"}
        </span>
        <span>{shown.length} lines · up to 5,000 in view</span>
      </div>
    </div>
  );
}
function HealthHistory({ id, hasCheck }: { id: string; hasCheck: boolean }) {
  const [rows, setRows] = useState<Health[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const load = () =>
      request<Health[]>(`/apps/${id}/health`)
        .then(setRows)
        .catch((e) => setError(e.message));
    load();
    const es = new EventSource("/api/events");
    es.onmessage = load;
    return () => es.close();
  }, [id]);
  if (!hasCheck)
    return (
      <Empty icon={HeartPulse} title="No health check configured">
        <p>Add an HTTP, TCP, process, command, or Docker check in YAML.</p>
      </Empty>
    );
  return (
    <>
      <h3>Recent health checks</h3>
      <p className="muted">
        Thresholds absorb transient failures while your app warms up.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="health-history">
        {rows.map((r, i) => (
          <div key={i}>
            <span className={`health-icon ${r.ok ? "success" : "danger"}`}>
              {r.ok ? <Check size={15} /> : <X size={15} />}
            </span>
            <div>
              <strong>{r.ok ? "Check passed" : "Check failed"}</strong>
              <small>{new Date(r.time).toLocaleString()}</small>
              {r.message && <p>{r.message}</p>}
            </div>
            <code>{r.latency.toFixed(1)} ms</code>
          </div>
        ))}
        {!rows.length && (
          <Empty title="No checks yet">
            <p>Health history appears when the application is running.</p>
          </Empty>
        )}
      </div>
    </>
  );
}
function Timeline({ id }: { id?: string }) {
  const [rows, setRows] = useState<Event[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const load = () =>
      request<Event[]>(id ? `/apps/${id}/history` : "/history")
        .then(setRows)
        .catch((e) => setError(e.message));
    load();
    const es = new EventSource("/api/events");
    es.onmessage = load;
    return () => es.close();
  }, [id]);
  return (
    <div className="timeline">
      {error && <p role="alert">{error}</p>}
      {rows.length ? (
        rows.map((r, i) => (
          <div className="timeline-item" key={i}>
            <span
              className={`timeline-icon ${r.type.includes("failed") ? "danger" : ""}`}
            >
              <Activity size={15} />
            </span>
            <div>
              <strong>{r.message}</strong>
              <span>
                {r.type}
                {r.app ? ` · ${r.app}` : ""}
              </span>
            </div>
            <time>{new Date(r.time).toLocaleString()}</time>
          </div>
        ))
      ) : (
        <Empty icon={Activity} title="A quiet workspace">
          <p>Application activity will appear here.</p>
        </Empty>
      )}
    </div>
  );
}
function ConfigPage({
  cfg,
  refresh,
  onError,
  onNotice,
}: {
  cfg: Config | null;
  refresh: () => Promise<void>;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null),
    [original, setOriginal] = useState(""),
    [revision, setRevision] = useState(""),
    [valid, setValid] = useState(false),
    [busy, setBusy] = useState(false);
  const dirty = raw !== null && raw !== original;
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const load = async () => {
    try {
      const c = await request<Config>("/config?raw=true");
      setRaw(c.raw || "");
      setOriginal(c.raw || "");
      setRevision(c.revision || "");
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const action = async (save: boolean) => {
    setBusy(true);
    try {
      const result = await request<{ revision?: string }>(
        `/config/${save ? "save" : "validate"}`,
        { yaml: raw, revision },
      );
      if (result.revision) setRevision(result.revision);
      setValid(true);
      if (save) {
        setOriginal(raw || "");
        refresh();
      }
      onNotice(
        save
          ? "Configuration saved, backed up, and reloaded"
          : "Configuration is valid",
      );
    } catch (e) {
      setValid(false);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Configuration</h1>
          <p>Human-readable YAML. Always under your control.</p>
        </div>
        <button
          className="button"
          onClick={() => {
            request("/config/reload", {})
              .then(() => {
                refresh();
                onNotice("Configuration reloaded");
              })
              .catch((e) => onError(e.message));
          }}
        >
          <RefreshCw size={15} />
          Reload from disk
        </button>
      </div>
      <div className="config-banner">
        <FileCode2 size={20} />
        <div>
          <strong>Configuration file</strong>
          <code>{cfg?.path}</code>
        </div>
        <span className="tag">YAML · v1</span>
      </div>
      {raw === null ? (
        <div className="editor-locked">
          <FileCode2 size={30} />
          <h2>Edit your workspace</h2>
          <p>
            The editor displays your complete configuration, including any
            secrets stored in it. Open it only when your screen is private.
          </p>
          <button className="button primary" onClick={load}>
            Reveal configuration editor
          </button>
          <p className="muted">
            You can also edit this file in your own editor. Valid changes reload
            automatically.
          </p>
        </div>
      ) : (
        <>
          <div className="editor-header">
            <span>
              <FileCode2 size={14} />
              config.yml
              {dirty && <span className="unsaved">Unsaved changes</span>}
              {valid && !dirty && <span className="success">Valid</span>}
            </span>
            <div>
              <button
                className="button small"
                onClick={() => action(false)}
                disabled={busy}
              >
                <CheckCircle2 size={14} />
                Validate
              </button>
              <button
                className="button primary small"
                onClick={() => action(true)}
                disabled={busy || !dirty}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Check size={14} />
                )}
                Save and reload
              </button>
            </div>
          </div>
          <div className="yaml-editor">
            <pre
              aria-hidden="true"
              dangerouslySetInnerHTML={{
                __html: Prism.highlight(
                  raw + "\n",
                  Prism.languages.yaml,
                  "yaml",
                ),
              }}
            />
            <textarea
              aria-label="YAML configuration editor"
              spellCheck={false}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setValid(false);
              }}
            />
          </div>
          <div className="editor-footer">
            <span>A backup is created before every save.</span>
            <span>{raw.split("\n").length} lines</span>
          </div>
        </>
      )}
      <section className="config-help">
        <h2>A small example</h2>
        <p>
          Use an absolute path to a project that exists on your machine.
          Environment values stay redacted in application details.
        </p>
        <pre className="code-block">{`apps:\n  my-api:\n    name: My API\n    type: process\n    cwd: ~/Development/my-api\n    start:\n      command: npm run dev\n    health:\n      type: http\n      url: http://localhost:3000/health\n    ports:\n      - name: Web\n        port: 3000`}</pre>
      </section>
    </>
  );
}
function DiscoverPage({
  cfg,
  onAdded,
  onError,
}: {
  cfg: Config | null;
  onAdded: () => void;
  onError: (s: string) => void;
}) {
  const [path, setPath] = useState(""),
    [rows, setRows] = useState<
      {
        path: string;
        type: string;
        command: string;
        indicator: string;
        name: string;
      }[]
    >([]),
    [busy, setBusy] = useState(false),
    [scanned, setScanned] = useState(false),
    [truncated, setTruncated] = useState(false),
    [adding, setAdding] = useState<string | null>(null),
    [draft, setDraft] = useState("");
  const scan = async () => {
    setBusy(true);
    try {
      const d = await request<{ suggestions: typeof rows; truncated: boolean }>(
        "/discover",
        { path },
      );
      setRows(d.suggestions);
      setScanned(true);
      setTruncated(d.truncated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = async (row: (typeof rows)[number]) => {
    try {
      const c = await request<Config>("/config?raw=true");
      const doc = YAML.parseDocument(c.raw || "");
      let id = row.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!id) id = "app";
      let n = 2;
      const base = id;
      while (doc.hasIn(["apps", id])) id = base + "-" + n++;
      const app: Record<string, unknown> = {
        name: row.name,
        type: row.type,
        cwd: row.path,
      };
      if (row.type === "docker-compose")
        app.docker = { compose_file: row.indicator, project_name: id };
      else app.start = { command: row.command };
      setDraft(YAML.stringify({ [id]: app }));
      setAdding(row.path);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const add = async () => {
    setBusy(true);
    try {
      const c = await request<Config>("/config?raw=true");
      const doc = YAML.parseDocument(c.raw || "");
      const fragment = YAML.parse(draft);
      for (const [id, a] of Object.entries(fragment)) {
        if (doc.hasIn(["apps", id])) throw Error(`App ${id} already exists`);
        doc.setIn(["apps", id], a);
      }
      await request("/config/save", {
        yaml: String(doc),
        revision: c.revision,
      });
      onAdded();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Discover apps</h1>
          <p>
            Find projects on your machine. Choose what belongs in your
            workspace.
          </p>
        </div>
      </div>
      <div className="discovery-form">
        <FolderOpen size={22} />
        <label>
          <span>Directory to scan</span>
          <input
            placeholder="~/Development"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && path && scan()}
          />
        </label>
        <button
          className="button primary"
          disabled={!path || busy}
          onClick={scan}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Search size={15} />
          )}
          Scan directory
        </button>
      </div>
      <p className="muted discovery-note">
        Looks up to four directory levels for Compose, Node.js, Rails, Python,
        Go, Rust, Justfile, and Makefile projects. Dependencies and hidden
        version-control directories are skipped. Nothing runs automatically.
      </p>
      {adding ? (
        <div className="discovery-review">
          <h2>Review application</h2>
          <p>
            Check the suggested command before adding it. Detection finds
            project files, not necessarily the correct entry point.
          </p>
          <textarea
            aria-label="New application YAML"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="inline-actions">
            <button className="button" onClick={() => setAdding(null)}>
              Cancel
            </button>
            <button className="button primary" disabled={busy} onClick={add}>
              <Plus size={15} />
              Add to configuration
            </button>
          </div>
          <small>Saved to {cfg?.path} with a backup.</small>
        </div>
      ) : (
        <div className="discovery-results">
          {rows.map((row) => (
            <div className="discovery-row" key={row.path}>
              <div className="app-symbol">
                {row.type === "docker-compose" ? (
                  <Box size={21} />
                ) : (
                  <Terminal size={21} />
                )}
              </div>
              <div>
                <h3>{row.name}</h3>
                <code>{row.path}</code>
                <span>
                  {row.indicator}
                  {row.command ? " · " + row.command : ""}
                </span>
              </div>
              <button className="button small" onClick={() => prepare(row)}>
                <Plus size={14} />
                Review & add
              </button>
            </div>
          ))}
          {!rows.length && (
            <Empty
              icon={FolderOpen}
              title={
                scanned
                  ? "No supported projects found"
                  : "Your next workspace starts here"
              }
            >
              <p>
                {scanned
                  ? "Try a directory closer to your projects, or add applications directly in YAML."
                  : "Select a directory to find local applications you can manage with Stakl."}
              </p>
            </Empty>
          )}
          {truncated && (
            <p className="alert warning">
              Scan reached 20,000 entries. Choose a more specific directory for
              remaining projects.
            </p>
          )}
        </div>
      )}
    </>
  );
}
function SystemPage() {
  const [info, setInfo] = useState<Record<string, unknown>>({}),
    [docker, setDocker] = useState<{
      available: boolean;
      message: string;
    } | null>(null),
    [logs, setLogs] = useState(""),
    [error, setError] = useState("");
  const load = () =>
    Promise.all([
      request<Record<string, unknown>>("/system/status"),
      request<{ text: string }>("/system/logs"),
    ])
      .then(([s, l]) => {
        setInfo(s);
        setLogs(l.text);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>System</h1>
          <p>The controller behind your workspace.</p>
        </div>
        <button className="button" onClick={load}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <div className="system-grid">
        <section>
          <h2>Stakl runtime</h2>
          <dl className="properties">
            {Object.entries(info)
              .filter(([k]) => k !== "config_error")
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd>
                    {k === "uptime_seconds"
                      ? `${Math.floor(Number(v) / 60)} min`
                      : k === "memory_bytes"
                        ? `${(Number(v) / 1024 / 1024).toFixed(1)} MB`
                        : String(v)}
                  </dd>
                </div>
              ))}
          </dl>
        </section>
        <section>
          <h2>Docker</h2>
          <p className="muted">
            Docker is optional. Only Compose applications need it.
          </p>
          <button
            className="button"
            onClick={() =>
              request<{ available: boolean; message: string }>("/system/docker")
                .then(setDocker)
                .catch((e) => setError(e.message))
            }
          >
            <Box size={15} />
            Check Docker availability
          </button>
          {docker && (
            <div className="docker-result">
              <StatusBadge status={docker.available ? "running" : "failed"} />
              <pre>
                {docker.message ||
                  "Docker could not be reached. Check installation and daemon status."}
              </pre>
            </div>
          )}
        </section>
      </div>
      <h2>Internal logs</h2>
      <pre className="internal-logs">
        {logs || "No internal errors recorded."}
      </pre>
    </>
  );
}
function Palette({
  apps,
  profiles,
  onRun,
  run,
  open,
  reload,
}: {
  apps: App[];
  profiles: Record<string, Profile>;
  onRun: (fn: () => void) => void;
  run: Action;
  open: (id: string, tab?: string) => void;
  reload: () => void;
}) {
  const [q, setQ] = useState(""),
    [index, setIndex] = useState(0);
  const items = [
    ...apps.flatMap((a) => [
      {
        text: `${isActive(a.runtime.state) ? "Stop" : "Start"} ${a.config.name}`,
        icon: Play,
        fn: () =>
          run(a.config.id, isActive(a.runtime.state) ? "stop" : "start"),
      },
      {
        text: `Restart ${a.config.name}`,
        icon: RefreshCw,
        fn: () => run(a.config.id, "restart"),
      },
      {
        text: `Open ${a.config.name} logs`,
        icon: Terminal,
        fn: () => open(a.config.id, "Logs"),
      },
      {
        text: `Open ${a.config.name} directory`,
        icon: FolderOpen,
        fn: () => run(a.config.id, "directory"),
      },
    ]),
    ...Object.entries(profiles).flatMap(([id, p]) =>
      ["start", "stop", "restart"].map((action) => ({
        text: `${typeLabel(action)} ${p.name} profile`,
        icon: Layers3,
        fn: () => run(id, action, true),
      })),
    ),
    { text: "Reload configuration", icon: RefreshCw, fn: reload },
  ]
    .filter((c) => c.text.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 40);
  return (
    <>
      <div className="palette-input">
        <Search size={20} />
        <input
          autoFocus
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="commands"
          aria-activedescendant={items[index] ? `command-${index}` : undefined}
          placeholder="What would you like to do?"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter" && items[index]) onRun(items[index].fn);
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="palette-results" role="listbox" id="commands">
        {items.map((c, i) => (
          <button
            role="option"
            aria-selected={index === i}
            id={`command-${i}`}
            key={c.text}
            className={index === i ? "selected" : ""}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onRun(c.fn)}
          >
            <c.icon size={16} />
            {c.text}
            <ChevronRight size={14} />
          </button>
        ))}
        {!items.length && <p>No commands found.</p>}
      </div>
      <div className="palette-footer">
        <Command size={13} /> Navigate with arrow keys · Enter to run
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);

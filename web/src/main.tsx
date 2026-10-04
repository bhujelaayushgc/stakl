import React, {
  useState,
  useEffect,
  useLayoutEffect,
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
import { AppEditor } from "./AppEditor";
import type { DiscoverySuggestion } from "./app-config";
import {
  App,
  HostEnvelope,
  HostResponse,
  RequestError,
  canStopApp,
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
import { HostsPage } from "./HostsPage";
import {
  canControlApp,
  flattenHosts,
  groupKey,
  hostAppPath,
  hostRequest,
  hostStateLabel,
  identity,
  isLiveApp,
  remoteLoopback,
  scopedGroups,
} from "./hosts";
import {
  EmptyState,
  IconButton,
  PageHeader,
  SearchField,
  StatusIndicator,
} from "./ui";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./style.css";
import "./workstation.css";

type Action = (
  id: string,
  action: string,
  profile?: boolean,
  hostID?: string,
) => Promise<void>;
const icons = {
  process: Terminal,
  shell: Terminal,
  "docker-compose": Box,
  custom: Settings2,
};
const logTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const numberFormat = new Intl.NumberFormat();
const decimalFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const views = new Set([
  "dashboard",
  "ports",
  "activity",
  "config",
  "discover",
  "system",
  "hosts",
]);
const detailTabs = new Set([
  "Overview",
  "Logs",
  "Health",
  "History",
  "Configuration",
]);
const route = () => {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") || "dashboard";
  return {
    page: views.has(view) ? view : "dashboard",
    selected: params.get("app"),
    scope: params.get("host") || "local",
    appHost:
      params.get("host") === "all"
        ? params.get("app_host") || "local"
        : params.get("host") || "local",
    tab: detailTabs.has(params.get("tab") || "")
      ? params.get("tab")!
      : "Overview",
    search: params.get("q") || "",
    group: params.get("group") || "",
    status: params.get("status") || "",
    type: params.get("type") || "",
    favorites: params.get("favorites") === "1",
  };
};
const routeUrl = (changes: Record<string, string | null>) => {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  url.hash = "";
  return url;
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
export function AppShell() {
  const [localApps, setApps] = useState<App[]>([]),
    [envelopes, setEnvelopes] = useState<HostEnvelope[]>([]),
    [scope, setScope] = useState(() => route().scope),
    [appHost, setAppHost] = useState(() => route().appHost),
    [cfg, setCfg] = useState<Config | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [connected, setConnected] = useState(false),
    [page, setPage] = useState(() => route().page),
    [selected, setSelected] = useState<string | null>(() => route().selected),
    [detailTab, setDetailTab] = useState(() => route().tab),
    [busy, setBusy] = useState<Set<string>>(new Set()),
    [search, setSearch] = useState(() => route().search),
    [group, setGroup] = useState(() => route().group),
    [status, setStatus] = useState(() => route().status),
    [type, setType] = useState(() => route().type),
    [favorites, setFavorites] = useState(() => route().favorites),
    [configDirty, setConfigDirty] = useState(false),
    [editorDirty, setEditorDirty] = useState(false),
    [appEditor, setAppEditor] = useState<{
      appID?: string;
      suggestion?: DiscoverySuggestion;
    } | null>(null),
    [palette, setPalette] = useState(false),
    [confirm, setConfirm] = useState<{
      title: string;
      message: string;
      actionLabel: string;
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
    [mobileNav, setMobileNav] = useState(false),
    [isNarrow, setIsNarrow] = useState(
      () => window.matchMedia("(max-width: 760px)").matches,
    );
  const mounted = useRef(true);
  const navTrigger = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const paletteContentRef = useRef<HTMLDivElement>(null);
  const previousPage = useRef(page);
  const historyIndex = useRef(0);
  const currentUrl = useRef(window.location.href);
  const revertingPop = useRef(false);
  const dirtyPage = useRef({
    page,
    configDirty,
    editorDirty,
    editorOpen: !!appEditor,
  });
  dirtyPage.current = {
    page,
    configDirty,
    editorDirty,
    editorOpen: !!appEditor,
  };
  const writeUrl = (url: URL, push = false, detailFrom = false) => {
    if (url.href === window.location.href) return;
    if (push) historyIndex.current += 1;
    window.history[push ? "pushState" : "replaceState"](
      {
        ...window.history.state,
        staklIndex: historyIndex.current,
        staklDetailFrom: detailFrom,
      },
      "",
      url,
    );
    currentUrl.current = window.location.href;
  };
  useEffect(() => {
    historyIndex.current = window.history.state?.staklIndex ?? 0;
    window.history.replaceState(
      { ...window.history.state, staklIndex: historyIndex.current },
      "",
      window.location.href,
    );
    const onPopState = (event: PopStateEvent) => {
      if (revertingPop.current) {
        revertingPop.current = false;
        return;
      }
      const next = route();
      const dirty = dirtyPage.current;
      if (
        (next.page !== dirty.page || dirty.editorOpen) &&
        ((dirty.page === "config" && dirty.configDirty) || dirty.editorDirty) &&
        !window.confirm(
          dirty.page === "config"
            ? "Discard unsaved configuration changes?"
            : "Discard your edited application draft?",
        )
      ) {
        const targetIndex = event.state?.staklIndex;
        if (typeof targetIndex === "number") {
          revertingPop.current = true;
          window.history.go(historyIndex.current - targetIndex);
        } else {
          window.history.pushState(
            { staklIndex: ++historyIndex.current },
            "",
            currentUrl.current,
          );
        }
        return;
      }
      historyIndex.current = event.state?.staklIndex ?? 0;
      currentUrl.current = window.location.href;
      setAppEditor(null);
      setEditorDirty(false);
      setPage(next.page);
      setSelected(next.selected);
      setScope(next.scope);
      setAppHost(next.appHost);
      setDetailTab(next.tab);
      setSearch(next.search);
      setGroup(next.group);
      setStatus(next.status);
      setType(next.type);
      setFavorites(next.favorites);
      setMobileNav(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (previousPage.current !== page) {
      previousPage.current = page;
      requestAnimationFrame(() =>
        mainRef.current?.querySelector("h1")?.focus(),
      );
    }
  }, [page]);
  useEffect(() => {
    writeUrl(
      routeUrl({
        q: search,
        group,
        status,
        type,
        favorites: favorites ? "1" : null,
      }),
    );
  }, [search, group, status, type, favorites]);
  const localHost = envelopes.find((e) => e.host.id === "local")?.host;
  const allApps = useMemo(
    () => [
      ...localApps.map((a) => ({ ...a, host: localHost })),
      ...flattenHosts(envelopes.filter((e) => e.host.id !== "local")),
    ],
    [localApps, envelopes, localHost],
  );
  const apps = allApps.filter(
    (a) => scope === "all" || (a.host?.id || "local") === scope,
  );
  const ports = usePortScan(
    page === "ports" || (!!selected && appHost === "local"),
  );
  const hostReads = useRef<AbortController | null>(null);
  const refreshHosts = useCallback(async () => {
    hostReads.current?.abort();
    const controller = new AbortController();
    hostReads.current = controller;
    try {
      const value = await request<HostEnvelope[]>(
        "/hosts/apps",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted && mounted.current)
        setEnvelopes(value || []);
    } catch {
      if (!controller.signal.aborted && mounted.current)
        setEnvelopes((current) =>
          current.map((e) =>
            e.host.id === "local"
              ? e
              : {
                  ...e,
                  host: { ...e.host, stale: true, state: "unavailable" },
                },
          ),
        );
    }
  }, []);
  useEffect(() => {
    void refreshHosts();
    const timer = setInterval(refreshHosts, 5000);
    return () => {
      clearInterval(timer);
      hostReads.current?.abort();
    };
  }, [refreshHosts]);
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
      if (mounted.current)
        setError(
          `Could not load workspace data: ${String(e instanceof Error ? e.message : e)}. Check the controller connection, then reload.`,
        );
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
    const apply = () => {
      const resolved =
        theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#111816" : "#f2f4f3");
    };
    apply();
    mq.addEventListener("change", apply);
    localStorage.setItem("stakl-theme", theme);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const mq = matchMedia("(max-width: 760px)");
    const update = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (isNarrow && mobileNav)
      sidebarRef.current?.querySelector<HTMLAnchorElement>("nav a")?.focus();
  }, [isNarrow, mobileNav]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 7000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const run: Action = async (id, action, profile = false, hostID = "local") => {
    const target = allApps.find(
      (a) => a.config.id === id && (a.host?.id || "local") === hostID,
    );
    if (
      !profile &&
      target &&
      (!canControlApp(target) || busy.has(identity(target)))
    )
      return;
    if (
      hostID !== "local" &&
      (profile || !["start", "stop", "restart"].includes(action))
    )
      return;
    setError("");
    const key = profile ? "profile:" + id : target ? identity(target) : id;
    setBusy((b) => new Set(b).add(key));
    try {
      const result =
        hostID === "local"
          ? await request<Record<string, string>>(
              `/${profile ? "profiles" : "apps"}/${encodeURIComponent(id)}/${action}`,
              {},
            )
          : (
              await request<HostResponse<Record<string, string>>>(
                hostAppPath(hostID, id, action),
                {},
              )
            ).data;
      const failures = Object.entries(result).filter(
        ([, v]) => typeof v === "string" && v !== "ok",
      );
      if (failures.length)
        throw Error(failures.map(([k, v]) => `${k}: ${v}`).join("\n"));
      setNotice(
        `${profile ? "Profile" : `${target?.host?.name || "Local"} / ${target?.config.name || id}`}: ${action} complete`,
      );
    } catch (e) {
      const name = profile
        ? "profile"
        : `${target?.host?.name || "Local"} / ${target?.config.name || id}`;
      setError(
        `Could not ${action} ${name}: ${(e as Error).message}. ${e instanceof RequestError && e.outcome_unknown ? "Outcome unknown. Inspect refreshed state and history before deciding whether to act again." : action === "directory" || action === "terminal" ? "Check the configured path and local permissions." : "Check Activity or the application logs for details."}`,
      );
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
      refresh();
      void refreshHosts();
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
      setError(
        `Could not ${action} workspace applications: ${(e as Error).message}. Check Activity or application logs for details.`,
      );
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete("global");
        return n;
      });
      refresh();
    }
  };
  const openDetail = (
    id: string,
    tab = "Overview",
    hostID = "local",
    saved = false,
  ) => {
    if (
      appEditor &&
      editorDirty &&
      !saved &&
      !window.confirm("Discard your unsaved application changes?")
    )
      return;
    setAppEditor(null);
    setEditorDirty(false);
    writeUrl(
      routeUrl({
        app: id,
        tab: tab === "Overview" ? null : tab,
        app_host: scope === "all" ? hostID : null,
        host: scope === "all" ? "all" : hostID === "local" ? null : hostID,
      }),
      true,
      true,
    );
    setSelected(id);
    setAppHost(hostID);
    if (scope !== "all") setScope(hostID);
    setDetailTab(tab);
  };
  const closeDetail = () => {
    if (window.history.state?.staklDetailFrom) window.history.back();
    else {
      writeUrl(routeUrl({ app: null, app_host: null, tab: null }));
      setSelected(null);
    }
  };
  const changeDetailTab = (tab: string) => {
    writeUrl(
      routeUrl({ tab: tab === "Overview" ? null : tab }),
      false,
      !!window.history.state?.staklDetailFrom,
    );
    setDetailTab(tab);
  };
  const pinned = useMemo(
    () =>
      new Set(
        allApps
          .filter(
            (a) =>
              pins[identity(a)] ??
              ((a.host?.id || "local") === "local"
                ? pins[a.config.id]
                : undefined) ??
              a.config.favorite,
          )
          .map(identity),
      ),
    [allApps, pins],
  );
  useEffect(() => {
    if (!localHost) return;
    setPins((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const app of localApps) {
        if (Object.hasOwn(next, app.config.id)) {
          const key = identity({ ...app, host: localHost });
          if (!Object.hasOwn(next, key)) next[key] = next[app.config.id];
          delete next[app.config.id];
          changed = true;
        }
      }
      if (!changed) return previous;
      localStorage.setItem("stakl-pins", JSON.stringify(next));
      return next;
    });
  }, [localHost, localApps]);
  const pin = (id: string) =>
    setPins((p) => {
      const n = { ...p, [id]: !pinned.has(id) };
      localStorage.setItem("stakl-pins", JSON.stringify(n));
      return n;
    });
  const filtered = filterApps(
    apps,
    search,
    "",
    status,
    type,
    pinned,
    favorites,
  ).filter((a) => !group || groupKey(a, scope) === group);
  const groups = scopedGroups(apps, envelopes, scope);
  const cachedCurrent = allApps.find(
    (a) => a.config.id === selected && (a.host?.id || "local") === appHost,
  );
  const [detailRead, setDetailRead] = useState<{
    host: string;
    id: string;
    app: App;
  } | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    setDetailRead(null);
    setDetailError("");
    if (!selected) return;
    let controller = new AbortController();
    const load = async () => {
      controller.abort();
      controller = new AbortController();
      const current = controller;
      try {
        const app = await hostRequest<App>(
          appHost,
          selected,
          "",
          current.signal,
        );
        if (!current.signal.aborted) {
          setDetailRead({ host: appHost, id: selected, app });
          setDetailError("");
        }
      } catch (e) {
        if (!current.signal.aborted)
          setDetailError(
            `Could not refresh application: ${(e as Error).message}`,
          );
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selected, appHost]);
  const current =
    appHost !== "local" &&
    cachedCurrent &&
    detailRead?.host === appHost &&
    detailRead.id === selected
      ? { ...detailRead.app, host: cachedCurrent.host }
      : cachedCurrent;
  const changeScope = (value: string) => {
    setScope(value);
    setSelected(null);
    setAppHost(value === "all" ? "local" : value);
    setGroup("");
    writeUrl(
      routeUrl({
        host: value === "local" ? null : value,
        app: null,
        app_host: null,
        tab: null,
        group: null,
      }),
      true,
    );
  };
  const reload = async () => {
    try {
      await request("/config/reload", {});
      await refresh();
      setNotice("Configuration reloaded");
    } catch (e) {
      setError(
        `Could not reload configuration: ${(e as Error).message}. Open Configuration to inspect the YAML.`,
      );
    }
  };
  const nav = (p: string, saved = false) => {
    if (
      (p !== page || !!appEditor) &&
      !saved &&
      ((page === "config" && configDirty) || editorDirty) &&
      !window.confirm(
        page === "config"
          ? "Discard unsaved configuration changes?"
          : "Discard your edited application draft?",
      )
    )
      return;
    if (page === "config") setConfigDirty(false);
    setEditorDirty(false);
    setAppEditor(null);
    writeUrl(
      routeUrl({
        view: p === "dashboard" ? null : p,
        app: null,
        app_host: null,
        tab: null,
      }),
      true,
    );
    setPage(p);
    setSelected(null);
    setMobileNav(false);
  };
  const navHref = (p: string) =>
    routeUrl({
      view: p === "dashboard" ? null : p,
      app: null,
      app_host: null,
      tab: null,
    }).href;
  const onNavClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    p: string,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    nav(p);
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside
        ref={sidebarRef}
        id="primary-navigation"
        className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
        inert={isNarrow && !mobileNav}
        onBlur={(event) => {
          if (
            isNarrow &&
            mobileNav &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setMobileNav(false);
        }}
        onKeyDown={(event) => {
          if (isNarrow && event.key === "Escape") {
            setMobileNav(false);
            navTrigger.current?.focus();
          }
        }}
      >
        <a
          href={navHref("dashboard")}
          className="brand"
          onClick={(e) => onNavClick(e, "dashboard")}
        >
          <span className="brand-mark">
            <Layers3 size={19} aria-hidden="true" />
          </span>
          Stakl
        </a>
        <button className="palette-trigger" onClick={() => setPalette(true)}>
          <Search size={15} aria-hidden="true" />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          <a
            href={navHref("dashboard")}
            className={page === "dashboard" ? "active" : ""}
            aria-current={page === "dashboard" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "dashboard")}
          >
            <Layers3 aria-hidden="true" />
            Applications
          </a>
          <a
            href={navHref("ports")}
            className={page === "ports" ? "active" : ""}
            aria-current={page === "ports" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "ports")}
          >
            <Radio aria-hidden="true" />
            Ports
          </a>
          <a
            href={navHref("activity")}
            className={page === "activity" ? "active" : ""}
            aria-current={page === "activity" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "activity")}
          >
            <Activity aria-hidden="true" />
            Activity
          </a>
          <a
            href={navHref("hosts")}
            className={page === "hosts" ? "active" : ""}
            aria-current={page === "hosts" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "hosts")}
          >
            <Server aria-hidden="true" />
            Hosts
          </a>
          <div className="nav-separator" />
          <a
            href={navHref("config")}
            className={page === "config" ? "active" : ""}
            aria-current={page === "config" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "config")}
          >
            <FileCode2 aria-hidden="true" />
            Configuration
          </a>
          <a
            href={navHref("system")}
            className={page === "system" ? "active" : ""}
            aria-current={page === "system" ? "page" : undefined}
            onClick={(e) => onNavClick(e, "system")}
          >
            <Server aria-hidden="true" />
            System
          </a>
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              label="Toggle navigation"
              ref={navTrigger}
              aria-expanded={mobileNav}
              aria-controls="primary-navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={17} aria-hidden="true" />
            </IconButton>
            <strong>
              {
                (
                  {
                    dashboard: "Applications",
                    activity: "Activity",
                    config: "Configuration",
                    discover: "Discover apps",
                    system: "System",
                    ports: "Ports",
                    hosts: "Hosts",
                  } as Record<string, string>
                )[page]
              }
            </strong>
          </div>
          <div className="topbar-right">
            <span
              className={`connection ${connected ? "online" : ""}`}
              role="status"
            >
              <span className={`connection-dot ${connected ? "online" : ""}`} />
              <span className="connection-full">
                {connected ? "Controller connected" : "Reconnecting…"}
              </span>
              <span className="connection-short">
                {connected ? "Connected" : "Reconnecting"}
              </span>
            </span>
            <select
              className="theme-select"
              aria-label="Color theme"
              name="color-theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </header>
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className={`${page === "dashboard" ? "overview-page" : `${page}-page`} workstation-page`}
        >
          {page !== "dashboard" && page !== "hosts" && (
            <p className="local-scope-note">Local controller</p>
          )}
          {error && (
            <div className="alert error" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>Something needs attention</strong>
                <pre>{error}</pre>
              </div>
              <IconButton label="Dismiss error" onClick={() => setError("")}>
                <X size={16} aria-hidden="true" />
              </IconButton>
            </div>
          )}
          {cfg?.error && (
            <div className="alert warning" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>Configuration could not reload</strong>
                <p>{cfg.error}</p>
                <button className="text-button" onClick={() => nav("config")}>
                  Open configuration
                </button>
              </div>
            </div>
          )}
          {appEditor && (
            <AppEditor
              appID={appEditor.appID}
              suggestion={appEditor.suggestion}
              onDirtyChange={setEditorDirty}
              onOpenConfig={() => nav("config")}
              onCancel={() => {
                const id = appEditor.appID;
                setAppEditor(null);
                setEditorDirty(false);
                if (id) openDetail(id, "Configuration", "local", true);
              }}
              onSaved={(id) => {
                const editing = !!appEditor.appID;
                setError("");
                setNotice(
                  "Application configuration saved, backed up, and reloaded",
                );
                void refresh();
                nav("dashboard", true);
                if (editing) openDetail(id, "Configuration", "local", true);
              }}
            />
          )}
          {page === "dashboard" && !appEditor && (
            <>
              <PageHeader
                title="Applications"
                actions={
                  scope === "local" && (
                    <>
                      <button
                        className="button primary"
                        onClick={() => setAppEditor({})}
                      >
                        <Plus size={15} aria-hidden="true" />
                        Add app
                      </button>
                      <button
                        className="button"
                        onClick={() => nav("discover")}
                      >
                        <Plus size={15} aria-hidden="true" />
                        Discover apps
                      </button>
                      <Dropdown.Root>
                        <Dropdown.Trigger asChild>
                          <button
                            className="button"
                            disabled={busy.has("global")}
                          >
                            {busy.has("global") ? (
                              <LoaderCircle
                                className="spin"
                                size={15}
                                aria-hidden="true"
                              />
                            ) : (
                              <Play size={14} aria-hidden="true" />
                            )}
                            Workspace actions
                            <ChevronRight
                              className="rotate-down"
                              size={14}
                              aria-hidden="true"
                            />
                          </button>
                        </Dropdown.Trigger>
                        <Dropdown.Portal>
                          <Dropdown.Content className="dropdown" align="end">
                            <Dropdown.Item
                              onSelect={() => globalAction("start")}
                            >
                              <Play aria-hidden="true" />
                              Start all
                            </Dropdown.Item>
                            <Dropdown.Item
                              onSelect={() => globalAction("restart")}
                            >
                              <RefreshCw aria-hidden="true" />
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
                                  actionLabel: "Stop all",
                                  run: () => globalAction("stop"),
                                })
                              }
                            >
                              <Square aria-hidden="true" />
                              Stop all
                            </Dropdown.Item>
                          </Dropdown.Content>
                        </Dropdown.Portal>
                      </Dropdown.Root>
                    </>
                  )
                }
              />
              <div className="host-scope-bar">
                <label htmlFor="host-scope">Host</label>
                <select
                  id="host-scope"
                  value={scope}
                  onChange={(e) => changeScope(e.target.value)}
                >
                  <option value="local">Local</option>
                  <option value="all">All hosts</option>
                  {envelopes
                    .filter((e) => e.host.id !== "local")
                    .map((e) => (
                      <option key={e.host.id} value={e.host.id}>
                        {e.host.name}
                      </option>
                    ))}
                  {scope !== "all" &&
                    scope !== "local" &&
                    !envelopes.some((e) => e.host.id === scope) && (
                      <option value={scope}>Unavailable host</option>
                    )}
                </select>
              </div>
              {envelopes
                .filter(
                  (e) =>
                    e.host.id !== "local" &&
                    (scope === "all" || scope === e.host.id),
                )
                .map((e) => (
                  <div key={e.host.id} className="host-summary" role="status">
                    <strong>{e.host.name}</strong> ·{" "}
                    {hostStateLabel(e.host.state)} ·{" "}
                    {e.host.access === "read" ? "Read-only" : "Control"}
                    {(e.host.stale || e.host.state !== "online") && (
                      <span>
                        {" "}
                        · Stale snapshot · Last seen:{" "}
                        {elapsed(e.host.last_seen)} ago
                      </span>
                    )}
                  </div>
                ))}
              {scope === "local" &&
                Object.keys(cfg?.profiles || {}).length > 0 && (
                  <section className="profiles-section">
                    <div className="workstation-section-heading">
                      <h2>Profiles</h2>
                    </div>
                    <div className="profiles workstation-list">
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
              <section className="applications" aria-label="Application list">
                <h2 className="sr-only">Application groups</h2>
                <div
                  className="workstation-toolbar"
                  role="group"
                  aria-label="Application filters"
                >
                  <div className="overview-list-summary">
                    <strong>
                      {filtered.length === apps.length
                        ? apps.length
                        : `${numberFormat.format(filtered.length)} of ${numberFormat.format(apps.length)}`}{" "}
                      {apps.length === 1 ? "application" : "applications"}
                    </strong>
                    <span>
                      {numberFormat.format(
                        filtered.filter(
                          (a) => isLiveApp(a) && isActive(a.runtime.state),
                        ).length,
                      )}{" "}
                      running
                    </span>
                    {filtered.some((a) =>
                      ["unhealthy", "failed", "unknown"].includes(
                        a.runtime.state,
                      ),
                    ) && (
                      <span className="attention-count">
                        {
                          filtered.filter((a) =>
                            ["unhealthy", "failed", "unknown"].includes(
                              a.runtime.state,
                            ),
                          ).length
                        }{" "}
                        need attention
                      </span>
                    )}
                  </div>
                  <button
                    className="favorites-filter"
                    aria-label="Filter favorites"
                    aria-pressed={favorites}
                    onClick={() => setFavorites(!favorites)}
                  >
                    <Star size={14} aria-hidden="true" />{" "}
                    <span>
                      {apps.filter((a) => pinned.has(identity(a))).length}
                    </span>
                  </button>
                  <SearchField
                    label="Search applications"
                    name="application-search"
                    placeholder="Search applications…"
                    value={search}
                    onChange={setSearch}
                    onClear={() => setSearch("")}
                  />
                  <select
                    aria-label="Filter group"
                    name="application-group"
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
                    name="application-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">Status</option>
                    {[
                      "active",
                      "attention",
                      "stopped",
                      "healthy",
                      "running",
                      "unhealthy",
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
                    name="application-type"
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
                    <LoaderCircle className="spin" aria-hidden="true" />
                    Connecting to controller…
                  </div>
                ) : apps.length === 0 && scope !== "local" ? (
                  <EmptyState title="No observed applications" plain>
                    <p>
                      This host may be unavailable or have no configured apps.
                      Check Hosts for connection status.
                    </p>
                  </EmptyState>
                ) : apps.length === 0 ? (
                  <div className="onboarding">
                    <h2>No applications configured</h2>
                    <p>
                      Discover a local project or add an application in your
                      configuration file.
                    </p>
                    <div className="onboarding-actions">
                      <button
                        className="button primary"
                        onClick={() => nav("discover")}
                      >
                        <FolderOpen size={16} aria-hidden="true" />
                        Discover apps
                      </button>
                      <button className="button" onClick={() => nav("config")}>
                        <FileCode2 size={16} aria-hidden="true" />
                        Edit configuration
                      </button>
                    </div>
                    <div className="config-location">
                      <Folder size={14} aria-hidden="true" />
                      <code>{cfg?.path}</code>
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No matching applications"
                    plain
                  >
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
                  </EmptyState>
                ) : (
                  <div className="app-ledger workstation-list">
                    <div
                      className="table-head workstation-ledger-grid"
                      aria-hidden="true"
                    >
                      <span>Application</span>
                      <span>State</span>
                      <span>Runtime</span>
                      <span>Actions</span>
                    </div>
                    {groups.map(([id, g]) => {
                      const rows = filtered.filter(
                        (a) => groupKey(a, scope) === id,
                      );
                      return (
                        rows.length > 0 && (
                          <section
                            className="app-group"
                            key={id}
                            aria-label={`${g.name} applications`}
                          >
                            <div className="group-heading">
                              <h3>{g.name}</h3>
                              <span>
                                {numberFormat.format(rows.length)}{" "}
                                {rows.length === 1
                                  ? "application"
                                  : "applications"}
                              </span>
                            </div>
                            {rows
                              .sort(
                                (a, b) =>
                                  Number(pinned.has(identity(b))) -
                                    Number(pinned.has(identity(a))) ||
                                  a.config.name.localeCompare(b.config.name),
                              )
                              .map((a) => (
                                <AppRow
                                  key={identity(a)}
                                  app={a}
                                  localControls={scope === "local"}
                                  busy={busy.has(identity(a))}
                                  pinned={pinned.has(identity(a))}
                                  onPin={() => pin(identity(a))}
                                  run={run}
                                  onOpen={(tab) =>
                                    openDetail(
                                      a.config.id,
                                      tab,
                                      a.host?.id || "local",
                                    )
                                  }
                                />
                              ))}
                          </section>
                        )
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
          {page === "config" && (
            <ConfigPage
              cfg={cfg}
              refresh={refresh}
              onError={setError}
              onDirtyChange={setConfigDirty}
              onNotice={(message) => {
                setError("");
                setNotice(message);
              }}
            />
          )}
          {page === "discover" && (
            <div hidden={!!appEditor}>
              <DiscoverPage
                onReview={(suggestion) => setAppEditor({ suggestion })}
                onError={setError}
              />
            </div>
          )}
          {page === "activity" && (
            <>
              <PageHeader title="Activity" />
              <Timeline />
            </>
          )}
          {page === "hosts" && (
            <HostsPage
              onChanged={() => {
                void refresh();
                void refreshHosts();
              }}
              onNotice={setNotice}
            />
          )}
          {page === "system" && <SystemPage />}
          {page === "ports" && <PortsPage apps={localApps} {...ports} />}
        </main>
      </div>
      <Dialog.Root open={!!selected} onOpenChange={(o) => !o && closeDetail()}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="detail-panel workstation-detail"
            aria-describedby={undefined}
          >
            {current ? (
              <>
                <div className="detail-header">
                  <div className="app-symbol">
                    {React.createElement(appIcon(current.config), {
                      size: 23,
                      "aria-hidden": true,
                    })}
                  </div>
                  <div>
                    <Dialog.Title>{current.config.name}</Dialog.Title>
                    <span>
                      {typeLabel(current.config.type)}
                      <span className="dot-separator">·</span>
                      {current.config.id} · {current.host?.name || "Local"}
                    </span>
                  </div>
                  <IconButton
                    label="Close application details"
                    onClick={closeDetail}
                  >
                    <X size={20} aria-hidden="true" />
                  </IconButton>
                </div>
                {detailError && <p role="alert">{detailError}</p>}
                <Detail
                  key={identity(current)}
                  app={current}
                  localControls={scope === "local"}
                  onEdit={() => {
                    nav("dashboard", true);
                    setAppEditor({ appID: current.config.id });
                  }}
                  portScan={ports}
                  tab={detailTab}
                  setTab={changeDetailTab}
                  run={run}
                  busy={busy.has(identity(current))}
                  confirm={(run) =>
                    setConfirm({
                      title: "Force kill application?",
                      message:
                        "Immediately kills the owned process group. Unsaved work in that application may be lost.",
                      actionLabel: "Force kill",
                      run,
                    })
                  }
                />
              </>
            ) : (
              <div className="detail-header">
                <Dialog.Title>
                  {loading ? "Loading application" : "Application unavailable"}
                </Dialog.Title>
                <IconButton
                  label="Close application details"
                  onClick={closeDetail}
                >
                  <X size={20} aria-hidden="true" />
                </IconButton>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={palette} onOpenChange={setPalette}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            ref={paletteContentRef}
            className="palette-dialog"
            tabIndex={-1}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              if (isNarrow) {
                event.preventDefault();
                paletteContentRef.current?.focus();
              }
            }}
          >
            <Dialog.Title className="sr-only">Command palette</Dialog.Title>
            <Palette
              apps={apps}
              busy={busy}
              profiles={scope === "local" ? cfg?.profiles || {} : {}}
              onRun={(fn) => {
                setPalette(false);
                fn();
              }}
              run={run}
              open={openDetail}
              reload={scope === "local" ? reload : undefined}
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
            <AlertCircle className="danger" aria-hidden="true" />
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
                {confirm?.actionLabel}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          {notice}
          <IconButton
            label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} aria-hidden="true" />
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
    <article className="profile-row workstation-list-row">
      <div className="profile-identity">
        <details className="profile-members">
          <summary>
            <span>{profile.name}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </summary>
          <p>
            {profile.apps
              .map(
                (id) => apps.find((a) => a.config.id === id)?.config.name || id,
              )
              .join(", ")}
          </p>
        </details>
      </div>
      <span className={`profile-state ${s.failed ? "danger" : ""}`}>
        {s.failed ? (
          <AlertCircle size={13} aria-hidden="true" />
        ) : (
          <span className={`status-dot ${s.running ? "online" : ""}`} />
        )}
        {s.running === 0 ? "Stopped" : `${s.running}/${s.total} running`}
      </span>
      <div className="profile-actions workstation-action-row">
        {s.running > 0 && (
          <IconButton
            label={`Restart ${profile.name}`}
            disabled={busy}
            onClick={() => run(id, "restart", true)}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
        )}
        <button
          className={`button small ${s.running ? "" : "primary"}`}
          aria-label={`${s.running ? "Stop" : "Start"} ${profile.name} profile`}
          disabled={busy}
          onClick={() => run(id, s.running ? "stop" : "start", true)}
        >
          {busy ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : s.running ? (
            <Square size={12} aria-hidden="true" />
          ) : (
            <Play size={12} aria-hidden="true" />
          )}{" "}
          {s.running ? "Stop" : "Start"}
        </button>
      </div>
    </article>
  );
}
function AppRow({
  app: a,
  localControls,
  busy,
  pinned,
  onPin,
  run: dispatch,
  onOpen,
}: {
  app: App;
  localControls: boolean;
  busy: boolean;
  pinned: boolean;
  onPin: () => void;
  run: Action;
  onOpen: (tab?: string) => void;
}) {
  const remote = !!a.host && a.host.id !== "local";
  const run: Action = (id, action) =>
    dispatch(id, action, false, a.host?.id || "local");
  const blocked = !canControlApp(a);
  const active = isActive(a.runtime.state),
    canStop = canStopApp(a);
  const link = Object.values(a.config.links || {})[0];
  return (
    <div
      className="app-row workstation-list-row workstation-ledger-grid"
      role="group"
      aria-label={`${a.config.name}${remote ? ` on ${a.host!.name}` : ""} application`}
    >
      <div className="app-identity">
        <div
          className={`app-symbol ${a.config.type === "docker-compose" ? "compose-symbol" : ""}`}
        >
          {React.createElement(appIcon(a.config), {
            size: 17,
            "aria-hidden": true,
          })}
        </div>
        <div className="app-name">
          <button onClick={() => onOpen()}>
            <span className="app-name-label">{a.config.name}</span>
            {pinned && <Pin size={11} aria-hidden="true" />}
          </button>
          <span>
            {a.host && <span className="host-badge">{a.host.name} · </span>}
            {a.config.description || typeLabel(a.config.type)}
            {a.config.autostart.enabled && (
              <span className="autostart">Autostart</span>
            )}
          </span>
        </div>
      </div>
      <div>
        <span className="sr-only">State: </span>
        <StatusIndicator status={a.runtime.state} plain />
        {!isLiveApp(a) && (
          <small className="stale-note">
            Stale · Last seen {elapsed(a.host?.last_seen || "")} ago
          </small>
        )}
        {a.runtime.next_restart && (
          <small className="retry-note">Retry scheduled</small>
        )}
      </div>
      <div className="runtime-cell">
        <span className="sr-only">Runtime: </span>
        <span>
          {a.runtime.pid
            ? `PID ${a.runtime.pid}`
            : a.config.type === "docker-compose"
              ? "Compose project"
              : "-"}
        </span>
        {active && (
          <small>
            {a.runtime.owned
              ? "Owned by Stakl"
              : a.runtime.state === "external"
                ? "External process"
                : "Active"}
          </small>
        )}
      </div>
      <div className="row-actions workstation-action-row">
        <IconButton
          label={`Logs for ${a.config.name}`}
          onClick={() => onOpen("Logs")}
        >
          <Terminal size={16} aria-hidden="true" />
        </IconButton>
        {(!active || canStop) && (
          <button
            className={`button small ${!active ? "start-button" : ""}`}
            aria-label={`${active ? "Stop" : "Start"} ${a.config.name}`}
            disabled={busy || blocked || a.runtime.state === "unknown"}
            onClick={() => run(a.config.id, active ? "stop" : "start")}
          >
            {busy ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : active ? (
              <Square size={12} aria-hidden="true" />
            ) : (
              <Play size={12} aria-hidden="true" />
            )}
            <span>{active ? "Stop" : "Start"}</span>
          </button>
        )}
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <IconButton label={`More actions for ${a.config.name}`}>
              <MoreHorizontal size={17} aria-hidden="true" />
            </IconButton>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown" align="end">
              <Dropdown.Item onSelect={() => onOpen()}>
                <Activity aria-hidden="true" />
                More info
              </Dropdown.Item>
              {active && canStop && (
                <Dropdown.Item
                  onSelect={() => run(a.config.id, "restart")}
                  disabled={busy || blocked}
                >
                  <RefreshCw aria-hidden="true" /> Restart
                </Dropdown.Item>
              )}
              {link && !remoteLoopback(a, link) && (
                <Dropdown.Item asChild>
                  <a href={link} target="_blank" rel="noreferrer">
                    <ArrowUpRight aria-hidden="true" /> Open app
                  </a>
                </Dropdown.Item>
              )}
              <Dropdown.Item onSelect={onPin}>
                <Star aria-hidden="true" />
                {pinned ? "Unpin" : "Pin to favorites"}
              </Dropdown.Item>
              <Dropdown.Separator />
              {localControls && !remote && (
                <Dropdown.Item onSelect={() => run(a.config.id, "directory")}>
                  <FolderOpen aria-hidden="true" />
                  Open directory
                </Dropdown.Item>
              )}
              {localControls && !remote && (
                <Dropdown.Item onSelect={() => run(a.config.id, "terminal")}>
                  <Terminal aria-hidden="true" />
                  Open terminal here
                </Dropdown.Item>
              )}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </div>
  );
}
function Detail({
  app: a,
  localControls,
  onEdit,
  portScan,
  tab,
  setTab,
  run: dispatch,
  busy,
  confirm,
}: {
  app: App;
  localControls: boolean;
  onEdit: () => void;
  portScan: ReturnType<typeof usePortScan>;
  tab: string;
  setTab: (s: string) => void;
  run: Action;
  busy: boolean;
  confirm: (f: () => void) => void;
}) {
  const remote = !!a.host && a.host.id !== "local";
  const run: Action = (id, action) =>
    dispatch(id, action, false, a.host?.id || "local");
  const blocked = !canControlApp(a);
  const active = isActive(a.runtime.state);
  const portList = servicePorts(a, remote ? [] : portScan.scan?.ports || []);
  const canStop = canStopApp(a);
  return (
    <>
      <div className="detail-status">
        <StatusIndicator status={a.runtime.state} plain />
        {!isLiveApp(a) && (
          <small className="stale-note">
            Stale · Last seen {elapsed(a.host?.last_seen || "")} ago
          </small>
        )}
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
          className={`button${active ? "" : " primary"}`}
          disabled={
            blocked ||
            busy ||
            (active && !canStop) ||
            a.runtime.state === "unknown"
          }
          onClick={() => run(a.config.id, active ? "stop" : "start")}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
          ) : active ? (
            <Square size={13} aria-hidden="true" />
          ) : (
            <Play size={13} aria-hidden="true" />
          )}{" "}
          {active ? "Stop" : "Start"}
        </button>
        <button
          className="button"
          disabled={busy || blocked || (active && !canStop)}
          onClick={() => run(a.config.id, "restart")}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Restart
        </button>
        {Object.entries(a.config.links || {}).map(([name, url]) =>
          remoteLoopback(a, url) ? (
            <span className="remote-link" key={name}>
              {name}: {url} (loopback on {a.host?.name})
            </span>
          ) : (
            <a
              className="button"
              key={name}
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {name}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ),
        )}
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
            <AlertCircle size={17} aria-hidden="true" />
            <pre>{a.runtime.error}</pre>
          </div>
        )}
        {tab === "Overview" && (
          <>
            {a.config.description && (
              <p className="detail-description">{a.config.description}</p>
            )}
            <dl className="properties workstation-properties">
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
            {localControls && !remote && (
              <div className="inline-actions">
                <button
                  className="button small"
                  onClick={() => run(a.config.id, "directory")}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  Open directory
                </button>
                <button
                  className="button small"
                  onClick={() => run(a.config.id, "terminal")}
                >
                  <Terminal size={14} aria-hidden="true" />
                  Open terminal here
                </button>
              </div>
            )}
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
            {!remote && portScan.error && (
              <p className="alert error" role="alert">
                {portScan.error}
              </p>
            )}
            {!remote && portScan.scan?.warning && (
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
                {remote
                  ? "No ports declared in the peer snapshot."
                  : !active
                    ? "No ports configured. Stopped services have no live ports to detect."
                    : !portScan.scan && !portScan.error
                      ? "Detecting ports…"
                      : "No ports associated with this service. For externally managed services, declare ports in the application configuration."}
              </p>
            )}
            {remote && (
              <p className="muted">
                Ports observed on {a.host?.name}. Browser reachability is not
                checked.
              </p>
            )}
            {!remote && (
              <button
                className="button small"
                disabled={portScan.loading}
                onClick={portScan.refresh}
              >
                <RefreshCw
                  size={14}
                  className={portScan.loading ? "spin" : ""}
                  aria-hidden="true"
                />
                {portScan.loading ? "Scanning…" : "Refresh ports"}
              </button>
            )}
            {a.containers.length > 0 && (
              <>
                <h3>Compose containers</h3>
                <div className="container-list">
                  {a.containers.map((c) => (
                    <div key={c.name}>
                      <Box size={15} aria-hidden="true" />
                      <span>{c.name}</span>
                      <StatusIndicator status={c.health || c.state} />
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
            {localControls &&
              !remote &&
              a.runtime.owned &&
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
        {tab === "Logs" && (
          <LogViewer
            id={a.config.id}
            hostID={a.host?.id || "local"}
            active={active}
          />
        )}{" "}
        {tab === "Health" && (
          <HealthHistory
            hostID={a.host?.id || "local"}
            id={a.config.id}
            hasCheck={!!a.config.health.type}
          />
        )}{" "}
        {tab === "History" && (
          <Timeline hostID={a.host?.id || "local"} id={a.config.id} />
        )}{" "}
        {tab === "Configuration" && (
          <>
            <p className="muted">
              {remote
                ? "Redacted peer configuration snapshot. Edit configuration on the peer controller."
                : "Effective configuration. Environment values are redacted. Use Edit app to change the source settings."}
            </p>
            {!remote && (
              <button className="button" onClick={onEdit}>
                <Settings2 size={15} aria-hidden="true" />
                Edit app
              </button>
            )}
            <pre className="code-block config-code">
              {JSON.stringify(a.effective_config || a.config, null, 2)}
            </pre>
          </>
        )}
      </div>
    </>
  );
}
const LogRow = React.memo(function LogRow({
  line,
  timestamps,
}: {
  line: LogLine;
  timestamps: boolean;
}) {
  return (
    <div className={`log-line ${line.stream}`}>
      {timestamps && (
        <time dateTime={line.time}>{logTime.format(new Date(line.time))}</time>
      )}
      <span className="stream-label">
        {line.stream === "stderr" ? "ERR" : "OUT"}
      </span>
      <span>{line.text || " "}</span>
    </div>
  );
});
function LogViewer({
  id,
  active,
  hostID = "local",
}: {
  id: string;
  active: boolean;
  hostID?: string;
}) {
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
    setError("");
    setConnected(false);
    let disposed = false;
    let pending: LogLine[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(
      `/api${hostAppPath(hostID, id, "logs")}?follow=true`,
    );
    es.onopen = () => {
      if (!disposed) setConnected(true);
    };
    es.onerror = () => {
      if (!disposed) setConnected(false);
    };
    es.addEventListener("connection-error", () => {
      if (!disposed) {
        setConnected(false);
        setError("Host connection lost. Reopen logs to reconnect.");
        es.close();
      }
    });
    es.onmessage = (e) => {
      if (!disposed && !pausedRef.current) {
        try {
          pending.push(JSON.parse(e.data) as LogLine);
          if (!timer)
            timer = setTimeout(() => {
              const batch = pending;
              pending = [];
              timer = undefined;
              setLines((l) => [...l, ...batch].slice(-5000));
            }, 100);
        } catch {
          setError(
            "Could not read a log event. Reopen the application logs to reconnect.",
          );
        }
      }
    };
    return () => {
      disposed = true;
      es.close();
      clearTimeout(timer);
    };
  }, [id, hostID]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  const shown = lines.filter(
    (l) =>
      (!stream || l.stream === stream) &&
      l.text.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className={`log-viewer${shown.length ? "" : " is-empty"}`}>
      <div className="log-toolbar">
        <SearchField
          label="Search logs"
          name="log-search"
          placeholder="Search logs…"
          value={search}
          onChange={setSearch}
          iconSize={14}
        />
        <select
          aria-label="Log stream"
          name="log-stream"
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
            {paused ? (
              <Play size={15} aria-hidden="true" />
            ) : (
              <Pause size={15} aria-hidden="true" />
            )}
          </IconButton>
          <IconButton
            label="Follow tail"
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Toggle timestamps"
            aria-pressed={timestamps}
            onClick={() => setTimestamps(!timestamps)}
          >
            <Clock size={15} aria-hidden="true" />
          </IconButton>
        </div>
        <div>
          <IconButton
            label="Copy displayed logs"
            onClick={() =>
              navigator.clipboard
                .writeText(
                  shown
                    .map(
                      (l) =>
                        `${timestamps ? logTime.format(new Date(l.time)) + " " : ""}[${l.stream}] ${l.text}`,
                    )
                    .join("\n"),
                )
                .catch((e) =>
                  setError(
                    `Could not copy displayed logs: ${e.message}. Check clipboard permissions and try again.`,
                  ),
                )
            }
          >
            <Copy size={15} aria-hidden="true" />
          </IconButton>
          <a
            className="icon-button"
            href={`/api${hostAppPath(hostID, id, "logs")}?download=true`}
            aria-label="Download logs"
            title="Download logs"
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
          </a>
          <IconButton label="Clear display" onClick={() => setLines([])}>
            <Trash2 size={15} aria-hidden="true" />
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
            <LogRow
              key={`${l.launch}:${l.seq}`}
              line={l}
              timestamps={timestamps}
            />
          ))
        ) : (
          <div className="log-empty">
            {lines.length
              ? "No lines match your filters."
              : active
                ? "Waiting for log output."
                : "No log output yet. Start the application to capture logs."}
          </div>
        )}
      </div>
      <div className="log-footer">
        <span>
          <span
            className={`connection-dot ${connected && active && !paused ? "online" : ""}`}
          />
          {paused
            ? "Paused (incoming lines skipped)"
            : !active && !lines.length
              ? "Application stopped"
              : connected
                ? "Live stream"
                : "Reconnecting…"}
        </span>
        <span>
          {numberFormat.format(shown.length)} lines · up to{" "}
          {numberFormat.format(5000)} in view
        </span>
      </div>
    </div>
  );
}
export function HealthHistory({
  id,
  hasCheck,
  hostID = "local",
}: {
  id: string;
  hasCheck: boolean;
  hostID?: string;
}) {
  const [rows, setRows] = useState<Health[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let controller = new AbortController();
    setRows([]);
    setError("");
    setLoading(true);
    const load = async () => {
      controller.abort();
      controller = new AbortController();
      const current = controller;
      try {
        const result = await hostRequest<Health[]>(
          hostID,
          id,
          "health",
          controller.signal,
        );
        if (!current.signal.aborted) {
          setRows(result || []);
          setError("");
        }
      } catch (e) {
        if (!current.signal.aborted)
          setError(`Could not load health history: ${(e as Error).message}`);
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    };
    void load();
    const es = hostID === "local" ? new EventSource("/api/events") : null;
    if (es) es.onmessage = () => void load();
    const timer = setInterval(load, 5000);
    return () => {
      controller.abort();
      es?.close();
      clearInterval(timer);
    };
  }, [id, hostID]);
  if (!hasCheck)
    return (
      <EmptyState icon={HeartPulse} title="No health check configured" plain>
        <p>Add an HTTP, TCP, process, command, or Docker check in YAML.</p>
      </EmptyState>
    );
  return (
    <>
      <h3>Recent health checks</h3>
      <p className="muted">
        Thresholds absorb transient failures while your app warms up.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="health-history">
        {loading && !rows.length && (
          <p role="status">Loading health history…</p>
        )}
        {rows.map((r, i) => (
          <div className={r.ok ? "" : "health-failed"} key={i}>
            <span className={`health-icon ${r.ok ? "success" : "danger"}`}>
              {r.ok ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <X size={15} aria-hidden="true" />
              )}
            </span>
            <div>
              <strong>{r.ok ? "Check passed" : "Check failed"}</strong>
              <time dateTime={r.time}>{new Date(r.time).toLocaleString()}</time>
              {r.message && <p>{r.message}</p>}
            </div>
            <code>{decimalFormat.format(r.latency)} ms</code>
          </div>
        ))}
        {!rows.length && !loading && !error && (
          <EmptyState title="No checks yet" plain headingLevel={4}>
            <p>Health history appears when the application is running.</p>
          </EmptyState>
        )}
      </div>
    </>
  );
}
function Timeline({ id, hostID = "local" }: { id?: string; hostID?: string }) {
  const [rows, setRows] = useState<Event[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let controller = new AbortController();
    setRows([]);
    setError("");
    setLoading(true);
    const load = async () => {
      controller.abort();
      controller = new AbortController();
      const current = controller;
      try {
        const result = await (id
          ? hostRequest<Event[]>(hostID, id, "history", controller.signal)
          : request<Event[]>("/history", undefined, controller.signal));
        if (!current.signal.aborted) {
          setRows(result || []);
          setError("");
        }
      } catch (e) {
        if (!current.signal.aborted)
          setError(`Could not load activity: ${(e as Error).message}`);
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    };
    void load();
    const es = hostID === "local" ? new EventSource("/api/events") : null;
    if (es) es.onmessage = () => void load();
    const timer = setInterval(load, 5000);
    return () => {
      controller.abort();
      es?.close();
      clearInterval(timer);
    };
  }, [id, hostID]);
  return (
    <div className="timeline workstation-list">
      {error && <p role="alert">{error}</p>}
      {loading && !rows.length && <p role="status">Loading activity…</p>}
      {rows.length ? (
        rows.map((r, i) => (
          <div
            className={`timeline-item workstation-list-row${r.type.includes("failed") ? " is-failed" : ""}`}
            key={i}
          >
            <div>
              <strong>{r.message}</strong>
              <span>
                {r.type === "app.health.changed"
                  ? "Health result changed"
                  : r.type === "app.healthy"
                    ? "Entered healthy state"
                    : r.type.replace(/^app\./, "").replaceAll(".", " ")}
                {r.app ? ` · ${r.app}` : ""}
              </span>
            </div>
            <time dateTime={r.time}>{new Date(r.time).toLocaleString()}</time>
          </div>
        ))
      ) : !loading && !error ? (
        <EmptyState
          icon={Activity}
          title="A quiet workspace"
          plain
          headingLevel={id ? 3 : 2}
        >
          <p>Application activity will appear here.</p>
        </EmptyState>
      ) : null}
    </div>
  );
}
function ConfigPage({
  cfg,
  refresh,
  onError,
  onNotice,
  onDirtyChange,
}: {
  cfg: Config | null;
  refresh: () => Promise<void>;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null),
    [original, setOriginal] = useState(""),
    [revision, setRevision] = useState(""),
    [valid, setValid] = useState(false),
    [busy, setBusy] = useState(false),
    [validationError, setValidationError] = useState("");
  const validationErrorRef = useRef<HTMLParagraphElement>(null);
  const dirty = raw !== null && raw !== original;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (validationError) validationErrorRef.current?.focus();
  }, [validationError]);
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
      onError(
        `Could not reveal configuration: ${(e as Error).message}. Check that the configuration file is readable.`,
      );
    }
  };
  const action = async (save: boolean) => {
    setBusy(true);
    setValidationError("");
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
      setValidationError(
        `Could not ${save ? "save" : "validate"} configuration: ${(e as Error).message}. Review the YAML and try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Configuration"
        actions={
          <button
            className="button"
            onClick={() => {
              request("/config/reload", {})
                .then(() => {
                  refresh();
                  onNotice("Configuration reloaded");
                })
                .catch((e) =>
                  onError(
                    `Could not reload configuration: ${e.message}. Check the YAML and retry.`,
                  ),
                );
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reload from disk
          </button>
        }
      />
      <div className="config-banner">
        <div>
          <strong>Configuration file</strong>
          <code>{cfg?.path}</code>
        </div>
        <span>YAML · v1</span>
      </div>
      {raw === null ? (
        <div className="editor-locked">
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
              <FileCode2 size={14} aria-hidden="true" />
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
                <CheckCircle2 size={14} aria-hidden="true" />
                Validate
              </button>
              <button
                className="button primary small"
                onClick={() => action(true)}
                disabled={busy || !dirty}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : (
                  <Check size={14} aria-hidden="true" />
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
              name="configuration-yaml"
              autoComplete="off"
              aria-invalid={!!validationError}
              aria-describedby={
                validationError ? "config-validation-error" : undefined
              }
              spellCheck={false}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setValid(false);
                setValidationError("");
              }}
            />
          </div>
          {validationError && (
            <p
              id="config-validation-error"
              className="alert error"
              role="alert"
              tabIndex={-1}
              ref={validationErrorRef}
            >
              {validationError}
            </p>
          )}
          <div className="editor-footer">
            <span>A backup is created before every save.</span>
            <span>{numberFormat.format(raw.split("\n").length)} lines</span>
          </div>
        </>
      )}
      <details className="config-help">
        <summary>Configuration example</summary>
        <p>
          Use an absolute path to a project that exists on your machine.
          Environment values stay redacted in application details.
        </p>
        <pre className="code-block">{`apps:\n  my-api:\n    name: My API\n    type: process\n    cwd: ~/Development/my-api\n    start:\n      command: npm run dev\n    health:\n      type: http\n      url: http://localhost:3000/health\n    ports:\n      - name: Web\n        port: 3000`}</pre>
      </details>
    </>
  );
}
function DiscoverPage({
  onReview,
  onError,
}: {
  onReview: (suggestion: DiscoverySuggestion) => void;
  onError: (message: string) => void;
}) {
  const [path, setPath] = useState("");
  const [rows, setRows] = useState<DiscoverySuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [scanError, setScanError] = useState("");
  const scanErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (scanError) scanErrorRef.current?.focus();
  }, [scanError]);
  const scan = async () => {
    setBusy(true);
    setScanError("");
    try {
      const data = await request<{
        suggestions: DiscoverySuggestion[];
        truncated: boolean;
      }>("/discover", { path });
      setRows(data.suggestions);
      setScanned(true);
      setTruncated(data.truncated);
    } catch (e) {
      setScanError(
        `Could not scan ${path}: ${(e as Error).message}. Check the directory path and permissions, then try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Discover apps"
        description="Find local projects and review them before adding."
      />
      <div className="discovery-form">
        <label>
          <span>Directory to scan</span>
          <input
            placeholder="e.g. ~/Projects or /Users/you/Projects"
            name="directory-to-scan"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!scanError}
            aria-describedby={scanError ? "discover-scan-error" : undefined}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setScanError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && path && void scan()}
          />
        </label>
        <button
          className="button primary"
          disabled={!path || busy}
          onClick={() => void scan()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
          ) : (
            <Search size={15} aria-hidden="true" />
          )}
          Scan directory
        </button>
      </div>
      {scanError && (
        <p
          id="discover-scan-error"
          className="alert error"
          role="alert"
          tabIndex={-1}
          ref={scanErrorRef}
        >
          {scanError}
        </p>
      )}
      <p className="muted discovery-note">
        Looks up to four directory levels for Compose, Node.js, Rails, Python,
        Go, Rust, Justfile, and Makefile projects. Dependencies and hidden
        version-control directories are skipped. Nothing runs automatically.
      </p>
      {scanned || rows.length ? (
        <div className="discovery-results workstation-list">
          {rows.length > 0 && <h2 className="sr-only">Discovered projects</h2>}
          {rows.map((row) => (
            <div className="discovery-row workstation-list-row" key={row.path}>
              <div className="app-symbol">
                {row.type === "docker-compose" ? (
                  <Box size={21} aria-hidden="true" />
                ) : (
                  <Terminal size={21} aria-hidden="true" />
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
              <button
                className="button small"
                onClick={() => {
                  onError("");
                  onReview(row);
                }}
              >
                <Plus size={14} aria-hidden="true" />
                Review &amp; add
              </button>
            </div>
          ))}
          {!rows.length && (
            <EmptyState
              icon={FolderOpen}
              title="No supported projects found"
              plain
              headingLevel={2}
            >
              <p>
                Try a directory closer to your projects, or use Add app on
                Applications.
              </p>
            </EmptyState>
          )}
          {truncated && (
            <p className="alert warning">
              Scan reached 20,000 entries. Choose a more specific directory for
              remaining projects.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

function SystemPage() {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null),
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
        setError("");
      })
      .catch((e) =>
        setError(
          `Could not load system status: ${e.message}. Check the controller connection and refresh.`,
        ),
      );
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <PageHeader
        title="System"
        actions={
          <button className="button" onClick={load}>
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </button>
        }
      />
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!info && !error && <p role="status">Loading system status…</p>}
      {info && (
        <>
          <div className="system-sections">
            <section>
              <h2>Stakl runtime</h2>
              <dl className="properties workstation-properties">
                {Object.entries(info)
                  .filter(([k]) => k !== "config_error")
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>
                        {k === "uptime_seconds"
                          ? "Uptime"
                          : k === "memory_bytes"
                            ? "Memory"
                            : k
                                .replaceAll("_", " ")
                                .replace(/^./, (first) => first.toUpperCase())}
                      </dt>
                      <dd>
                        {k === "uptime_seconds"
                          ? `${numberFormat.format(Math.floor(Number(v) / 60))} min`
                          : k === "memory_bytes"
                            ? `${decimalFormat.format(Number(v) / 1024 / 1024)} MB`
                            : typeof v === "number"
                              ? numberFormat.format(v)
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
                  request<{ available: boolean; message: string }>(
                    "/system/docker",
                  )
                    .then(setDocker)
                    .catch((e) =>
                      setError(
                        `Could not check Docker availability: ${e.message}. Check Docker and the controller connection, then retry.`,
                      ),
                    )
                }
              >
                <Box size={15} aria-hidden="true" />
                Check Docker availability
              </button>
              {docker && (
                <div className="docker-result">
                  <StatusIndicator
                    status={docker.available ? "running" : "failed"}
                  />
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
      )}
    </>
  );
}
function Palette({
  apps,
  busy,
  profiles,
  onRun,
  run,
  open,
  reload,
}: {
  apps: App[];
  busy: Set<string>;
  profiles: Record<string, Profile>;
  onRun: (fn: () => void) => void;
  run: Action;
  open: (id: string, tab?: string, hostID?: string) => void;
  reload?: () => void;
}) {
  const [q, setQ] = useState(""),
    [index, setIndex] = useState(0);
  const items = [
    ...apps.flatMap((a) => {
      const active = isActive(a.runtime.state);
      const canRun =
        !busy.has(identity(a)) &&
        canControlApp(a) &&
        (!active || canStopApp(a));
      const name = `${a.config.name} (${a.host?.name || "Local"})`;
      return [
        ...(canRun && a.runtime.state !== "unknown"
          ? [
              {
                text: `${active ? "Stop" : "Start"} ${name}`,
                icon: active ? Square : Play,
                fn: () =>
                  run(
                    a.config.id,
                    active ? "stop" : "start",
                    false,
                    a.host?.id || "local",
                  ),
              },
            ]
          : []),
        ...(canRun
          ? [
              {
                text: `Restart ${name}`,
                icon: RefreshCw,
                fn: () =>
                  run(a.config.id, "restart", false, a.host?.id || "local"),
              },
            ]
          : []),
        {
          text: `Open ${name} logs`,
          icon: Terminal,
          fn: () => open(a.config.id, "Logs", a.host?.id || "local"),
        },
        ...(reload && (a.host?.id || "local") === "local"
          ? [
              {
                text: `Open ${name} directory`,
                icon: FolderOpen,
                fn: () => run(a.config.id, "directory", false, "local"),
              },
            ]
          : []),
      ].map((item) => ({ ...item, key: `${identity(a)}:${item.text}` }));
    }),
    ...Object.entries(profiles).flatMap(([id, p]) =>
      ["start", "stop", "restart"].map((action) => ({
        key: `profile:${id}:${action}`,
        text: `${typeLabel(action)} ${p.name} profile`,
        icon: Layers3,
        fn: () => run(id, action, true),
      })),
    ),
    ...(reload
      ? [
          {
            key: "reload",
            text: "Reload configuration",
            icon: RefreshCw,
            fn: reload,
          },
        ]
      : []),
  ]
    .filter((c) => c.text.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 40);
  return (
    <>
      <div className="palette-input">
        <Search size={20} aria-hidden="true" />
        <input
          role="combobox"
          aria-label="Search commands"
          name="command-search"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
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
            tabIndex={-1}
            aria-selected={index === i}
            id={`command-${i}`}
            key={c.key}
            className={index === i ? "selected" : ""}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onRun(c.fn)}
          >
            <c.icon size={16} aria-hidden="true" />
            {c.text}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ))}
        {!items.length && <p>No commands found.</p>}
      </div>
      <div className="palette-footer">
        <Command size={13} aria-hidden="true" /> Navigate with arrow keys ·
        Enter to run
      </div>
    </>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <AppShell />
    </React.StrictMode>,
  );

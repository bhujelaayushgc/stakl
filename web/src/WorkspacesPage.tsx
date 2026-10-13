import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { request, elapsed, type App, type Config } from "./types";
import { PageHeader, EmptyState, StatusIndicator } from "./ui";
import { WorkspaceEditor } from "./WorkspaceEditor";
import { removeWorkspaceConfiguration } from "./workspace-config";
import type { WorkspaceView } from "./workspace-types";
import "./workspaces.css";

type Props = {
  apps: App[];
  workspaceID?: string;
  onSelect: (id?: string) => void;
  onOpenService: (id: string, host: string) => void;
  onOpenConfig: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
};
const when = (time: string) =>
  !time || time.startsWith("0001-") ? "Not observed" : `${elapsed(time)} ago`;

export function WorkspacesPage({
  apps,
  workspaceID,
  onSelect,
  onOpenService,
  onOpenConfig,
  onDirtyChange,
  onSaved,
}: Props) {
  const [data, setData] = useState<WorkspaceView[]>([]),
    [loading, setLoading] = useState(true),
    [readError, setReadError] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [editor, setEditor] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const values = await request<WorkspaceView[]>(
        "/workspaces",
        undefined,
        signal,
      );
      if (!signal?.aborted) {
        setData(values || []);
        setReadError("");
      }
    } catch (e) {
      if (!signal?.aborted) setReadError((e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    setEditor(null);
    setError("");
    setNotice("");
  }, [workspaceID]);
  const views = readError
    ? data.map((w) => ({
        ...w,
        state: "unknown" as const,
        members: w.members.map((m) => ({
          ...m,
          state: "unknown" as const,
          controllable: false,
          checks: m.checks.map((p) => ({ ...p, state: "unknown" as const })),
        })),
      }))
    : data;
  const workspace = views.find((w) => w.id === workspaceID);
  const check = async () => {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/workspaces/${encodeURIComponent(workspace.id)}/check`,
        {},
      );
      setNotice(
        "Configured checks scheduled on this controller. Results update when they complete.",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !workspace ||
      !window.confirm(
        `Delete workspace ${workspace.name}? This removes only its definition. Services and other workspaces are preserved.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const current = await request<Config>("/config?raw=true");
      const yaml = removeWorkspaceConfiguration(
        current.raw || "",
        workspace.id,
      );
      await request("/config/validate", { yaml });
      await request("/config/save", { yaml, revision: current.revision });
      onSelect(undefined);
      onSaved();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (editor !== null)
    return (
      <WorkspaceEditor
        workspaceID={editor || undefined}
        apps={apps}
        onSaved={(id) => {
          setEditor(null);
          onSelect(id);
          onSaved();
          void load();
        }}
        onCancel={() => setEditor(null)}
        onOpenConfig={onOpenConfig}
        onDirtyChange={onDirtyChange}
      />
    );
  return (
    <section aria-label="Project workspaces">
      <PageHeader
        title={workspace?.name || "Workspaces"}
        description={
          workspace?.description ||
          "See whether each project has the services it needs, across local and connected hosts."
        }
        actions={
          workspace ? (
            <>
              <button className="button" onClick={() => onSelect(undefined)}>
                All workspaces
              </button>
              <button
                className="button"
                onClick={() => setEditor(workspace.id)}
                disabled={busy}
              >
                Edit workspace
              </button>
              <button
                className="button"
                onClick={() => void remove()}
                disabled={busy}
              >
                Delete workspace
              </button>
            </>
          ) : (
            <button className="button primary" onClick={() => setEditor("")}>
              <Plus size={15} aria-hidden="true" />
              Create workspace
            </button>
          )
        }
      />
      {(error || readError) && (
        <div className="workspace-error" role="alert">
          {error ||
            `Readiness unavailable: ${readError}. Displayed snapshots may be outdated.`}
          <button className="button small" onClick={() => void load()}>
            Refresh workspaces
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading workspaces...</p>
      ) : workspaceID && !workspace ? (
        <EmptyState title="Workspace unavailable">
          <p>It may have been removed from the configuration.</p>
          <button className="button" onClick={() => onSelect(undefined)}>
            All workspaces
          </button>
        </EmptyState>
      ) : workspace ? (
        <>
          <div className="workspace-actions">
            <StatusIndicator status={workspace.state} />
            <span>
              {workspace.required_issues} required issues,{" "}
              {workspace.optional_issues} optional issues
            </span>
            <button
              className="button"
              disabled={
                busy ||
                !!readError ||
                !workspace.members.some((m) => m.checks.length > 0)
              }
              onClick={() => void check()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              Check now
            </button>
          </div>
          <p className="workspace-explanation">
            Readiness covers configured requirements. Checks run on this
            controller, not the browser or a member's remote host.
          </p>
          <div className="workspace-members">
            {workspace.members.map((m) => (
              <section
                className="workspace-member"
                key={m.alias}
                aria-label={`Member ${m.alias}`}
              >
                <div className="workspace-member-heading">
                  <div>
                    <h2>
                      {m.name} <small>({m.alias})</small>
                    </h2>
                    <p>
                      {m.host?.name || "Unregistered controller"} / {m.app} -{" "}
                      {m.required ? "Required" : "Optional"} -{" "}
                      {m.condition === "healthy"
                        ? "Configured health"
                        : "Running / reachable"}
                    </p>
                  </div>
                  <StatusIndicator status={m.state} />
                </div>
                <p>{m.reason}</p>
                <small title={m.observed_at}>
                  Service observation: {when(m.observed_at)}
                  {m.host &&
                    ` - ${m.host.access === "read" ? "Read-only access" : "Control access"}`}
                  {m.runtime_state === "external"
                    ? " - Observation only; no captured logs"
                    : ""}
                </small>
                {m.host && (
                  <div className="workspace-actions">
                    <button
                      className="button small"
                      onClick={() => onOpenService(m.app, m.host!.id)}
                    >
                      Inspect {m.name}
                    </button>
                  </div>
                )}
                {m.checks.length > 0 && (
                  <ul
                    className="workspace-checks"
                    aria-label={`Checks for ${m.alias}`}
                  >
                    {m.checks.map((p) => (
                      <li key={p.id}>
                        <div className="workspace-check-heading">
                          <strong>{p.name}</strong>
                          <StatusIndicator status={p.state} />
                          <span>
                            {p.type === "command"
                              ? "Command exit success"
                              : p.type === "http"
                                ? "HTTP availability"
                                : "TCP availability"}
                          </span>
                        </div>
                        <p>{p.reason}</p>
                        <small title={p.checked_at}>
                          Checked {when(p.checked_at)} - {p.latency.toFixed(1)}{" "}
                          ms - Every {p.interval} - Origin: this controller
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
                {m.uses.length > 0 && (
                  <div className="workspace-uses">
                    <span>
                      Used by {new Set(m.uses.map((u) => u.id)).size} workspaces
                      on this controller:
                    </span>
                    {m.uses.map((u) => (
                      <button
                        className="button small"
                        key={`${u.id}:${u.service}`}
                        onClick={() => onSelect(u.id)}
                      >
                        {u.name} ({u.required ? "required" : "optional"})
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </>
      ) : views.length === 0 ? (
        <EmptyState title="Connect a project to its services" headingLevel={2}>
          <p>
            Add your frontend, an existing backend, or a shared database. A
            service can belong to several workspaces without duplicating it.
          </p>
          <button className="button" onClick={() => setEditor("")}>
            Create your first workspace
          </button>
        </EmptyState>
      ) : (
        <div className="workspace-list">
          {views.map((w) => (
            <article className="workspace-list-row" key={w.id}>
              <div>
                <h2>
                  <button
                    className="workspace-name"
                    onClick={() => onSelect(w.id)}
                  >
                    {w.name}
                  </button>
                </h2>
                {w.description && <p>{w.description}</p>}
                <p>
                  {w.members.length} services - {w.required_issues} required
                  issues - {w.optional_issues} optional issues
                </p>
              </div>
              <StatusIndicator status={w.state} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { request, RequestError, type App, type Config } from "./types";
import { validConfigID } from "./app-config";
import {
  buildWorkspaceConfiguration,
  createWorkspaceDraft,
  loadWorkspaceDraft,
  type ProbeDefinition,
  type ServiceDefinition,
  type WorkspaceDraft,
} from "./workspace-config";
import { PageHeader } from "./ui";
import "./app-editor.css";
import "./workspaces.css";

type Props = {
  workspaceID?: string;
  apps: App[];
  onSaved: (id: string) => void;
  onCancel: () => void;
  onOpenConfig: () => void;
  onDirtyChange: (dirty: boolean) => void;
};
const choice = (a: App): ServiceDefinition => ({
  controller: !a.host || a.host.id === "local" ? "local" : a.host.controller_id,
  app: a.config.id,
});
const reference = (s: ServiceDefinition, local = "") =>
  JSON.stringify([s.controller === local ? "local" : s.controller, s.app]);
const uniqueID = (base: string, used: Record<string, unknown>) => {
  let id = base,
    i = 2;
  while (Object.hasOwn(used, id)) id = `${base}-${i++}`;
  return id;
};

function Field({
  label,
  value,
  onChange,
  readOnly = false,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  readOnly?: boolean;
  type?: string;
}) {
  return (
    <label className="app-field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        type={type}
      />
    </label>
  );
}

export function WorkspaceEditor({
  workspaceID,
  apps,
  onSaved,
  onCancel,
  onOpenConfig,
  onDirtyChange,
}: Props) {
  const [source, setSource] = useState<Config | null>(null),
    [original, setOriginal] = useState<WorkspaceDraft | null>(null),
    [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [loading, setLoading] = useState(true);
  const [external, setExternal] = useState<{
    id: string;
    name: string;
    type: "tcp" | "http";
    host: string;
    port: string;
    url: string;
  } | null>(null);
  const saving = useRef(false),
    errorRef = useRef<HTMLDivElement>(null);
  const dirty =
    !!original &&
    !!draft &&
    (JSON.stringify(original) !== JSON.stringify(draft) || external !== null);
  const localIdentity =
    apps.find((a) => a.host?.id === "local")?.host?.controller_id || "";
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSource(null);
    setDraft(null);
    setExternal(null);
    request<Config>("/config?raw=true", undefined, controller.signal)
      .then((current) => {
        if (controller.signal.aborted) return;
        const initial = workspaceID
          ? loadWorkspaceDraft(current.raw || "", workspaceID)
          : createWorkspaceDraft();
        setSource(current);
        setOriginal(initial);
        setDraft(initial);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceID]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
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
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (draft && !loading)
      document
        .querySelector<HTMLInputElement>('[aria-label="Workspace name"]')
        ?.focus();
  }, [loading]);
  const change = (next: WorkspaceDraft) => {
    setDraft(next);
    if (!conflict) setError("");
  };
  const discard = () =>
    !dirty || window.confirm("Discard your unsaved workspace changes?");
  const updateMember = (index: number, alias: string, s: ServiceDefinition) => {
    if (!draft) return;
    const entries = Object.entries(draft.values.services);
    const previous = entries[index][0];
    if (alias !== previous && Object.hasOwn(draft.values.services, alias)) {
      setError("This member alias already exists");
      return;
    }
    entries[index] = [alias, s];
    const checks = Object.fromEntries(
      Object.entries(draft.values.checks || {}).map(([id, p]) => [
        id,
        p.service === previous ? { ...p, service: alias } : p,
      ]),
    );
    change({
      ...draft,
      values: {
        ...draft.values,
        services: Object.fromEntries(entries),
        ...(draft.values.checks ? { checks } : {}),
      },
    });
  };
  const addMember = (a: App) => {
    if (!draft) return;
    const alias = uniqueID(a.config.id, draft.values.services);
    change({
      ...draft,
      values: {
        ...draft.values,
        services: {
          ...draft.values.services,
          [alias]: {
            ...choice(a),
            condition: (a.effective_config || a.config).health?.type
              ? "healthy"
              : "running",
            required: true,
          },
        },
      },
    });
  };
  const registerExternal = () => {
    if (!draft || !external) return;
    if (!validConfigID(external.id) || !external.name.trim()) {
      setError("Enter an external service name and a valid unique ID");
      return;
    }
    if (
      apps.some(
        (a) =>
          (!a.host || a.host.id === "local") && a.config.id === external.id,
      ) ||
      draft.externalApps?.some((a) => a.id === external.id)
    ) {
      setError(
        "This local service ID already exists. Select the existing service instead.",
      );
      return;
    }
    const port = Number(external.port);
    if (
      external.type === "tcp" &&
      (!external.host.trim() ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535)
    ) {
      setError("Enter a host and a TCP port between 1 and 65535");
      return;
    }
    if (external.type === "http") {
      try {
        const u = new URL(external.url);
        if (!["http:", "https:"].includes(u.protocol)) throw Error();
      } catch {
        setError("Enter an absolute HTTP(S) URL");
        return;
      }
    }
    const app = {
      id: external.id,
      values: {
        name: external.name,
        type: "external",
        detect:
          external.type === "tcp"
            ? { type: "tcp", host: external.host, port }
            : { type: "http", url: external.url },
      },
    };
    const alias = uniqueID(external.id, draft.values.services);
    change({
      ...draft,
      externalApps: [...(draft.externalApps || []), app],
      values: {
        ...draft.values,
        services: {
          ...draft.values.services,
          [alias]: {
            controller: "local",
            app: external.id,
            condition: "running",
            required: true,
          },
        },
      },
    });
    setExternal(null);
  };
  const save = async () => {
    if (saving.current || !source || !draft || !original || external) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const yaml = buildWorkspaceConfiguration(
        source.raw || "",
        original,
        draft,
        !workspaceID,
        localIdentity,
      );
      await request("/config/validate", { yaml });
      await request("/config/save", { yaml, revision: source.revision });
      onDirtyChange(false);
      onSaved(draft.id);
    } catch (e) {
      const message = (e as Error).message;
      setConflict(/configuration changed|revision is missing/i.test(message));
      setError(
        e instanceof RequestError && e.outcome_unknown
          ? `${message}. The save outcome is unknown. Inspect Configuration before retrying.`
          : message,
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const options = apps.map((a) => ({
    ref: choice(a),
    name: `${a.host?.name || "Local"} / ${a.config.name}`,
  }));
  for (const a of draft?.externalApps || [])
    options.push({
      ref: { controller: "local", app: a.id },
      name: `Local / ${String(a.values.name)} (new external service)`,
    });
  const available = apps.find(
    (a) =>
      !Object.values(draft?.values.services || {}).some(
        (s) =>
          reference(s, localIdentity) === reference(choice(a), localIdentity),
      ),
  );
  return (
    <section
      className="app-editor workspace-editor"
      aria-label={workspaceID ? "Edit workspace" : "Create workspace"}
    >
      <PageHeader
        title={workspaceID ? "Edit workspace" : "Create workspace"}
        description="Describe the services this project needs. Services can belong to several workspaces."
      />
      {error && (
        <div
          className="workspace-error"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {error}
          {conflict && (
            <p>
              Your draft is retained. Open Configuration to inspect the latest
              file before replacing this draft.
            </p>
          )}
        </div>
      )}
      {loading ? (
        <p role="status">Loading configuration...</p>
      ) : !draft ? (
        <button className="button" onClick={onOpenConfig}>
          Open configuration
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="app-form">
            <div className="app-field-grid">
              <Field
                label="Workspace name"
                value={draft.values.name}
                onChange={(name) =>
                  change({ ...draft, values: { ...draft.values, name } })
                }
              />
              <Field
                label="Workspace ID"
                value={draft.id}
                readOnly={!!workspaceID}
                onChange={(id) => change({ ...draft, id })}
              />
            </div>
            <label className="app-field">
              <span>Description</span>
              <textarea
                aria-label="Workspace description"
                value={draft.values.description || ""}
                onChange={(e) =>
                  change({
                    ...draft,
                    values: { ...draft.values, description: e.target.value },
                  })
                }
              />
            </label>
            <section
              className="workspace-form-section"
              aria-label="Service requirements"
            >
              <h2>Services</h2>
              <p className="workspace-explanation">
                Reference existing services across hosts. Required services
                determine readiness; optional services can degrade it.
              </p>
              {Object.entries(draft.values.services).map(
                ([alias, s], index) => {
                  const ref = reference(s, localIdentity),
                    known = options.some(
                      (o) => reference(o.ref, localIdentity) === ref,
                    );
                  return (
                    <fieldset className="workspace-form-row" key={index}>
                      <legend>Service requirement {index + 1}</legend>
                      <div className="app-field-grid">
                        <Field
                          label={`Member alias ${index + 1}`}
                          value={alias}
                          onChange={(a) => updateMember(index, a, s)}
                        />
                        <label className="app-field">
                          <span>Service</span>
                          <select
                            aria-label={`Service ${index + 1}`}
                            value={ref}
                            onChange={(e) => {
                              const [controller, app] = JSON.parse(
                                e.target.value,
                              ) as string[];
                              const a = apps.find(
                                (a) =>
                                  reference(choice(a), localIdentity) ===
                                  e.target.value,
                              );
                              updateMember(index, alias, {
                                ...s,
                                controller,
                                app,
                                condition:
                                  a &&
                                  (a.effective_config || a.config).health?.type
                                    ? "healthy"
                                    : "running",
                              });
                            }}
                          >
                            {!known && (
                              <option value={ref}>
                                Unavailable / {s.app} ({s.controller})
                              </option>
                            )}
                            {options.map((o) => (
                              <option
                                key={reference(o.ref, localIdentity)}
                                value={reference(o.ref, localIdentity)}
                                disabled={Object.entries(
                                  draft.values.services,
                                ).some(
                                  ([a, other]) =>
                                    a !== alias &&
                                    reference(other, localIdentity) ===
                                      reference(o.ref, localIdentity),
                                )}
                              >
                                {o.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="app-field">
                          <span>Condition</span>
                          <select
                            aria-label={`Condition ${index + 1}`}
                            value={s.condition || "running"}
                            onChange={(e) =>
                              updateMember(index, alias, {
                                ...s,
                                condition: e.target
                                  .value as ServiceDefinition["condition"],
                              })
                            }
                          >
                            <option value="running">Running / reachable</option>
                            <option value="healthy">
                              Configured health check passes
                            </option>
                          </select>
                        </label>
                        <label className="workspace-checkbox">
                          <input
                            type="checkbox"
                            checked={s.required !== false}
                            onChange={(e) =>
                              updateMember(index, alias, {
                                ...s,
                                required: e.target.checked,
                              })
                            }
                          />
                          Required member {index + 1}
                        </label>
                      </div>
                      <button
                        className="button small"
                        type="button"
                        onClick={() => {
                          const services = Object.fromEntries(
                            Object.entries(draft.values.services).filter(
                              ([a]) => a !== alias,
                            ),
                          );
                          const checks = Object.fromEntries(
                            Object.entries(draft.values.checks || {}).filter(
                              ([, p]) => p.service !== alias,
                            ),
                          );
                          change({
                            ...draft,
                            externalApps: draft.externalApps?.filter(
                              (a) =>
                                !(s.controller === "local" && a.id === s.app),
                            ),
                            values: {
                              ...draft.values,
                              services,
                              ...(draft.values.checks ? { checks } : {}),
                            },
                          });
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Remove member {alias}
                      </button>
                    </fieldset>
                  );
                },
              )}
              <div className="workspace-actions">
                <button
                  type="button"
                  className="button"
                  disabled={!available}
                  onClick={() => available && addMember(available)}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add existing service
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!!external}
                  onClick={() =>
                    setExternal({
                      id: "",
                      name: "",
                      type: "tcp",
                      host: "",
                      port: "",
                      url: "",
                    })
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  Add external service
                </button>
              </div>
              {external && (
                <fieldset className="workspace-form-row">
                  <legend>Add external service</legend>
                  <p className="workspace-explanation">
                    Observe a reachable endpoint, such as PostgreSQL in a
                    Proxmox guest. Stakl will not start or stop it. Checks run
                    from this controller.
                  </p>
                  <div className="app-field-grid">
                    <Field
                      label="External service name"
                      value={external.name}
                      onChange={(name) => setExternal({ ...external, name })}
                    />
                    <Field
                      label="External service ID"
                      value={external.id}
                      onChange={(id) => setExternal({ ...external, id })}
                    />
                    <label className="app-field">
                      <span>Detection</span>
                      <select
                        aria-label="External service detection"
                        value={external.type}
                        onChange={(e) =>
                          setExternal({
                            ...external,
                            type: e.target.value as "tcp" | "http",
                          })
                        }
                      >
                        <option value="tcp">TCP availability</option>
                        <option value="http">HTTP availability</option>
                      </select>
                    </label>
                    {external.type === "tcp" ? (
                      <>
                        <Field
                          label="External service host"
                          value={external.host}
                          onChange={(host) =>
                            setExternal({ ...external, host })
                          }
                        />
                        <Field
                          label="External service port"
                          type="number"
                          value={external.port}
                          onChange={(port) =>
                            setExternal({ ...external, port })
                          }
                        />
                      </>
                    ) : (
                      <Field
                        label="External service URL"
                        value={external.url}
                        onChange={(url) => setExternal({ ...external, url })}
                      />
                    )}
                  </div>
                  <div className="workspace-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={registerExternal}
                    >
                      Register service
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setExternal(null)}
                    >
                      Cancel external service
                    </button>
                  </div>
                </fieldset>
              )}
            </section>
            <section
              className="workspace-form-section"
              aria-label="Workspace checks"
            >
              <h2>Project checks</h2>
              <p className="workspace-explanation">
                Every check for a member must pass. TCP and HTTP availability do
                not establish database authentication or overall application
                correctness.
              </p>
              {Object.entries(draft.values.checks || {}).map(
                ([id, p], index) => {
                  const update = (next: ProbeDefinition, nextID = id) => {
                    if (
                      nextID !== id &&
                      Object.hasOwn(draft.values.checks || {}, nextID)
                    ) {
                      setError("This check ID already exists");
                      return;
                    }
                    const entries = Object.entries(draft.values.checks || {});
                    entries[index] = [nextID, next];
                    change({
                      ...draft,
                      values: {
                        ...draft.values,
                        checks: Object.fromEntries(entries),
                      },
                    });
                  };
                  const checkField = (
                    key: "url" | "host" | "command" | "interval" | "timeout",
                    label: string,
                    fallback = "",
                  ) => (
                    <Field
                      label={`${label} ${index + 1}`}
                      value={p.check[key] ?? fallback}
                      onChange={(value) =>
                        update({ ...p, check: { ...p.check, [key]: value } })
                      }
                    />
                  );
                  return (
                    <fieldset className="workspace-form-row" key={index}>
                      <legend>Project check {index + 1}</legend>
                      <div className="app-field-grid">
                        <Field
                          label={`Check ID ${index + 1}`}
                          value={id}
                          onChange={(nextID) => update(p, nextID)}
                        />
                        <Field
                          label={`Check name ${index + 1}`}
                          value={p.name || ""}
                          onChange={(name) => update({ ...p, name })}
                        />
                        <label className="app-field">
                          <span>Member</span>
                          <select
                            aria-label={`Check member ${index + 1}`}
                            value={p.service}
                            onChange={(e) =>
                              update({ ...p, service: e.target.value })
                            }
                          >
                            {Object.keys(draft.values.services).map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="app-field">
                          <span>Check type</span>
                          <select
                            aria-label={`Check type ${index + 1}`}
                            value={p.check.type}
                            onChange={(e) =>
                              update({
                                ...p,
                                check: {
                                  type: e.target
                                    .value as ProbeDefinition["check"]["type"],
                                  ...(p.check.interval
                                    ? { interval: p.check.interval }
                                    : {}),
                                  ...(p.check.timeout
                                    ? { timeout: p.check.timeout }
                                    : {}),
                                },
                              })
                            }
                          >
                            <option value="http">HTTP availability</option>
                            <option value="tcp">TCP availability</option>
                            <option value="command">
                              Command exit success
                            </option>
                          </select>
                        </label>
                        {p.check.type === "http" &&
                          checkField("url", "Check URL")}
                        {p.check.type === "tcp" && (
                          <>
                            {checkField("host", "Check host", "127.0.0.1")}
                            <Field
                              label={`Check port ${index + 1}`}
                              type="number"
                              value={p.check.port ?? ""}
                              onChange={(value) =>
                                update({
                                  ...p,
                                  check: { ...p.check, port: Number(value) },
                                })
                              }
                            />
                          </>
                        )}
                        {p.check.type === "command" &&
                          checkField("command", "Check command")}
                        {checkField("interval", "Check interval", "30s")}
                        {checkField("timeout", "Check timeout", "2s")}
                      </div>
                      {p.check.type === "command" && (
                        <>
                          <Field
                            label={`Working directory ${index + 1}`}
                            value={p.cwd || ""}
                            onChange={(cwd) => update({ ...p, cwd })}
                          />
                          <label className="app-field">
                            <span>Environment files (one per line)</span>
                            <textarea
                              aria-label={`Environment files ${index + 1}`}
                              value={(p.env_file || []).join("\n")}
                              onChange={(e) =>
                                update({
                                  ...p,
                                  env_file: e.target.value
                                    .split("\n")
                                    .filter(Boolean),
                                })
                              }
                            />
                            <small>
                              Commands run on this controller, inheriting its
                              environment and overlaying these files. Paths
                              default to the configuration directory.
                            </small>
                          </label>
                        </>
                      )}
                      <button
                        type="button"
                        className="button small"
                        onClick={() =>
                          change({
                            ...draft,
                            values: {
                              ...draft.values,
                              checks: Object.fromEntries(
                                Object.entries(
                                  draft.values.checks || {},
                                ).filter(([key]) => key !== id),
                              ),
                            },
                          })
                        }
                      >
                        Remove check {id}
                      </button>
                    </fieldset>
                  );
                },
              )}
              <button
                type="button"
                className="button"
                disabled={!Object.keys(draft.values.services).length}
                onClick={() => {
                  const id = uniqueID("check", draft.values.checks || {});
                  change({
                    ...draft,
                    values: {
                      ...draft.values,
                      checks: {
                        ...draft.values.checks,
                        [id]: {
                          name: "",
                          service: Object.keys(draft.values.services)[0],
                          check: {
                            type: "http",
                            url: "",
                            interval: "30s",
                            timeout: "2s",
                          },
                        },
                      },
                    },
                  });
                }}
              >
                <Plus size={15} aria-hidden="true" />
                Add project check
              </button>
            </section>
            <div className="workspace-actions">
              <button
                className="button primary"
                type="submit"
                disabled={!!external || conflict}
              >
                {busy ? "Saving..." : "Save workspace"}
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  if (discard()) onCancel();
                }}
              >
                Cancel
              </button>
              <button type="button" className="button" onClick={onOpenConfig}>
                Open configuration
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

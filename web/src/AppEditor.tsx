import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { AppForm } from "./AppForm";
import {
  buildAppConfiguration,
  createAppDraft,
  createObservationDraft,
  formatAppYAML,
  loadAppDraft,
  parseAppYAML,
  UnsafeAppSourceError,
  validConfigID,
  type AppDraft,
  type DiscoverySuggestion,
  type ObservationSource,
  type ObservationMetadata,
} from "./app-config";
import { request, RequestError, type Config } from "./types";
import { PageHeader } from "./ui";
import "./app-editor.css";

export type AppEditorProps = {
  appID?: string;
  suggestion?: DiscoverySuggestion;
  observation?: ObservationSource;
  onSaved: (id: string) => void;
  onCancel: () => void;
  onOpenConfig: () => void;
  onDirtyChange: (dirty: boolean) => void;
};

function fieldErrors(
  draft: AppDraft,
  creating: boolean,
  apps: Record<string, unknown>,
  groups: Record<string, unknown>,
) {
  const errors: Record<string, string> = { ...draft.rowErrors };
  if (!validConfigID(draft.id))
    errors.id = "Use letters, digits, underscores, or hyphens for the app ID.";
  if (creating && Object.hasOwn(apps, draft.id))
    errors.id = "This app ID already exists. Choose another ID.";
  if (creating && !String(draft.values.name || "").trim())
    errors.name = "Enter a display name.";
  if (
    !["docker-compose", "external"].includes(
      String(draft.values.type || "process"),
    ) &&
    !String((draft.values.start as { command?: string })?.command || "").trim()
  )
    errors["start.command"] = "Enter the command to start this app.";
  if (
    draft.values.type === "external" &&
    !(draft.values.detect as { type?: string })?.type
  )
    errors["detect.type"] =
      "Choose how Stakl should detect this existing service.";
  if (draft.newGroup) {
    if (!draft.newGroup.name.trim())
      errors["newGroup.name"] = "Enter the new group name.";
    if (!validConfigID(draft.newGroup.id))
      errors["newGroup.id"] =
        "Use letters, digits, underscores, or hyphens for the group ID.";
    else if (Object.hasOwn(groups, draft.newGroup.id))
      errors["newGroup.id"] =
        "This group ID already exists. Select the existing group or choose another ID.";
  }
  return errors;
}

export function AppEditor({
  appID,
  suggestion,
  observation,
  onSaved,
  onCancel,
  onOpenConfig,
  onDirtyChange,
}: AppEditorProps) {
  const [source, setSource] = useState<Config | null>(null);
  const [original, setOriginal] = useState<AppDraft | null>(null);
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [observationWarning, setObservationWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const [yaml, setYAML] = useState("");
  const [yamlBaseline, setYAMLBaseline] = useState("");
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [unsafe, setUnsafe] = useState(false);
  const [conflict, setConflict] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const loadIndex = useRef(0);
  const saving = useRef(false);
  const creating = !appID;
  const dirty =
    !!draft &&
    !!original &&
    (JSON.stringify(draft) !== JSON.stringify(original) ||
      (mode === "yaml" && yaml !== yamlBaseline));
  const config = useMemo(
    () => (source?.raw ? YAML.parse(source.raw) : {}),
    [source],
  );
  const load = useCallback(async () => {
    const index = ++loadIndex.current;
    setLoading(true);
    setError("");
    setErrors({});
    setUnsafe(false);
    setConflict(false);
    setObservationWarning("");
    try {
      const current = await request<Config>("/config?raw=true");
      let metadata: ObservationMetadata | undefined;
      let warning = "";
      if (observation) {
        try {
          metadata = await request<ObservationMetadata>(
            "/system/observe",
            observation,
          );
          warning = metadata.warning;
        } catch (e) {
          warning = `Could not autofill service details: ${(e as Error).message}. Review the settings manually.`;
        }
      }
      const initial = appID
        ? loadAppDraft(current.raw || "", appID)
        : observation
          ? createObservationDraft(current.raw || "", observation, metadata)
          : createAppDraft(current.raw || "", suggestion);
      if (index !== loadIndex.current) return;
      setSource(current);
      setObservationWarning(warning);
      setOriginal(initial);
      setDraft(initial);
      setMode("form");
      setYAML("");
      setYAMLBaseline("");
    } catch (e) {
      if (index !== loadIndex.current) return;
      setError((e as Error).message);
      setUnsafe(e instanceof UnsafeAppSourceError);
    } finally {
      if (index === loadIndex.current) setLoading(false);
    }
  }, [appID, suggestion, observation]);
  useEffect(() => {
    void load();
    return () => {
      loadIndex.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!loading) document.getElementById("app-field-name")?.focus();
  }, [loading]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      for (const path of Object.keys(errors)) {
        const element = document.getElementById(
          `app-field-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        );
        const disclosure = element?.closest("details");
        if (disclosure) disclosure.open = true;
      }
    }
  }, [error, errors]);
  const discard = () =>
    !dirty || window.confirm("Discard your unsaved application changes?");
  const change = (next: AppDraft) => {
    setDraft(next);
    setErrors({});
    setError("");
  };
  const readYAML = (): AppDraft => {
    if (!draft) throw Error("App configuration is not loaded.");
    const next = parseAppYAML(yaml);
    if (appID && next.id !== appID)
      throw Error("An existing app ID cannot be changed.");
    if (draft.newGroup && next.values.group === draft.newGroup.id)
      next.newGroup = draft.newGroup;
    if (yaml !== yamlBaseline || draft.appYAML) next.appYAML = yaml;
    return next;
  };
  const switchMode = (nextMode: "form" | "yaml") => {
    if (nextMode === mode || !draft || !source || !original) return;
    try {
      if (nextMode === "yaml") {
        const text = formatAppYAML(
          buildAppConfiguration(source.raw || "", original, draft, creating),
          draft.id,
        );
        setYAML(text);
        setYAMLBaseline(text);
      } else setDraft(readYAML());
      setMode(nextMode);
      setError("");
      setErrors({});
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async () => {
    if (saving.current || !source || !original || !draft) return;
    let next: AppDraft;
    try {
      next = mode === "yaml" ? readYAML() : draft;
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const localErrors = fieldErrors(
      next,
      creating,
      config.apps || {},
      config.groups || {},
    );
    if (Object.keys(localErrors).length) {
      setErrors(localErrors);
      setError("Review the highlighted settings before saving.");
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const complete = buildAppConfiguration(
        source.raw || "",
        original,
        next,
        creating,
      );
      await request("/config/validate", { yaml: complete });
      await request("/config/save", {
        yaml: complete,
        revision: source.revision,
      });
      setOriginal(next);
      setDraft(next);
      setYAMLBaseline(yaml);
      onDirtyChange(false);
      onSaved(next.id);
    } catch (e) {
      const message = (e as Error).message;
      const prefix = `apps.${next.id}.`;
      const path = message.startsWith(prefix)
        ? message.slice(prefix.length).match(/^[A-Za-z0-9_.]+/)?.[0]
        : undefined;
      setErrors(path ? { [path]: message } : {});
      setConflict(/configuration changed|revision is missing/i.test(message));
      setError(
        e instanceof RequestError && e.outcome_unknown
          ? `${message}. The save outcome is unknown. Inspect configuration before retrying.`
          : message,
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="app-editor"
      aria-label={creating ? "Create application" : "Edit application"}
    >
      <PageHeader
        title={
          creating
            ? observation
              ? "Observe existing service"
              : suggestion
                ? "Review application"
                : "Add app"
            : "Edit app"
        }
        description={
          observation
            ? "Review the detection target, name, and group. The service stays under its existing manager."
            : suggestion
              ? "Review the suggested command and settings before adding. Nothing runs automatically."
              : "Configure an application on this local controller."
        }
      />
      {loading ? (
        <p role="status">Loading app configuration...</p>
      ) : (
        <>
          {observationWarning && (
            <p className="alert warning" role="status">
              {observationWarning}
            </p>
          )}
          {error && (
            <div
              className="alert error"
              role="alert"
              ref={errorRef}
              tabIndex={-1}
            >
              <div>
                <p>{error}</p>
                {conflict && (
                  <>
                    <p>
                      Your draft is retained. Reload the current configuration
                      before trying again.
                    </p>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => {
                        if (discard()) void load();
                      }}
                    >
                      Reload configuration
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {unsafe || !source || !draft ? (
            <div className="inline-actions">
              <button className="button" type="button" onClick={onOpenConfig}>
                Open full configuration
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  if (discard()) onCancel();
                }}
              >
                Cancel
              </button>
              {!unsafe && (
                <button
                  className="button"
                  type="button"
                  onClick={() => void load()}
                >
                  Retry
                </button>
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <div className="app-editor-toolbar" aria-label="Editor mode">
                <button
                  className={`button small ${mode === "form" ? "active" : ""}`}
                  type="button"
                  aria-pressed={mode === "form"}
                  disabled={busy}
                  onClick={() => switchMode("form")}
                >
                  Form
                </button>
                <button
                  className={`button small ${mode === "yaml" ? "active" : ""}`}
                  type="button"
                  aria-pressed={mode === "yaml"}
                  disabled={busy}
                  onClick={() => switchMode("yaml")}
                >
                  YAML
                </button>
              </div>
              {mode === "form" ? (
                <AppForm
                  draft={draft}
                  creating={creating}
                  groups={config.groups || {}}
                  apps={config.apps || {}}
                  errors={errors}
                  disabled={busy}
                  onChange={change}
                />
              ) : (
                <>
                  <label className="sr-only" htmlFor="application-yaml">
                    Application YAML
                  </label>
                  <textarea
                    id="application-yaml"
                    className="app-yaml"
                    value={yaml}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setYAML(e.target.value);
                      setError("");
                      setErrors({});
                    }}
                  />
                  {draft.newGroup && (
                    <p className="muted">
                      New group {draft.newGroup.name || draft.newGroup.id} will
                      be saved with this app.
                    </p>
                  )}
                </>
              )}
              <div className="app-editor-footer">
                <p>
                  {draft.values.type === "external"
                    ? "Saving backs up and reloads configuration. Observation checks update without controlling the service."
                    : "Saving backs up and reloads configuration. Command and environment changes apply on the next start or restart; saving does not restart a running app."}
                </p>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      if (discard()) onCancel();
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy}
                  >
                    {busy ? "Saving..." : creating ? "Add app" : "Save changes"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

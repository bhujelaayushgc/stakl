import { useState, type ReactNode } from "react";
import {
  availableID,
  changeAppType,
  type AppDraft,
  type AppType,
} from "./app-config";
import "./app-editor.css";

export type AppFormProps = {
  draft: AppDraft;
  creating: boolean;
  groups: Record<string, { name: string; order: number }>;
  apps: Record<string, Record<string, unknown>>;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (draft: AppDraft) => void;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function valueAt(values: Record<string, unknown>, path: string): unknown {
  let value: unknown = values;
  for (const key of path.split("."))
    value =
      isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}
function withValue(draft: AppDraft, path: string, value: unknown): AppDraft {
  const next = structuredClone(draft);
  const keys = path.split(".");
  let target = next.values;
  const parents: [Record<string, unknown>, string][] = [];
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(target, key) || !isRecord(target[key]))
      Object.defineProperty(target, key, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    parents.push([target, key]);
    target = target[key] as Record<string, unknown>;
  }
  const key = keys[keys.length - 1];
  if (value === undefined) delete target[key];
  else
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  for (const [parent, child] of parents.reverse())
    if (isRecord(parent[child]) && !Object.keys(parent[child]).length)
      delete parent[child];
  return next;
}
const fieldID = (path: string) =>
  `app-field-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
function Field({
  path,
  label,
  error,
  hint,
  children,
}: {
  path: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="app-field">
      <label htmlFor={fieldID(path)}>{label}</label>
      {children}
      {hint && <small id={`${fieldID(path)}-hint`}>{hint}</small>}
      {error && (
        <small className="field-error" id={`${fieldID(path)}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}
type RowsProps = Pick<
  AppFormProps,
  "draft" | "onChange" | "apps" | "errors"
> & {
  path: string;
  label: string;
  keyLabel?: string;
  valueLabel?: string;
  kind?: "map" | "ports" | "dependencies";
};
function MapRows({
  draft,
  onChange,
  apps,
  errors,
  path,
  label,
  keyLabel = "Name",
  valueLabel = "Value",
  kind = "map",
}: RowsProps) {
  const current = valueAt(draft.values, path);
  const rows: [string, string][] =
    draft.rowDrafts?.[path] ||
    (kind === "ports" && Array.isArray(current)
      ? current.map((p) => [String(p.name || ""), String(p.port ?? "")])
      : isRecord(current)
        ? Object.entries(current).map(([key, value]) => [
            key,
            kind === "dependencies"
              ? String(
                  isRecord(value) ? value.condition || "running" : "running",
                )
              : String(value ?? ""),
          ])
        : []);
  const error = draft.rowErrors?.[path] || errors[path];
  const update = (items: [string, string][]) => {
    const names = items.map(([key]) => key);
    const message = names.some((key) => !key.trim())
      ? `Enter a name for each ${label.toLowerCase()}.`
      : new Set(names).size !== names.length
        ? `Duplicate ${label.toLowerCase()} names. Use a unique name for each row.`
        : kind === "ports" &&
            items.some(
              ([, port]) =>
                !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535,
            )
          ? "Ports must be whole numbers between 1 and 65535."
          : "";
    let next = structuredClone(draft);
    next.rowDrafts = { ...next.rowDrafts, [path]: items };
    next.rowErrors = { ...next.rowErrors };
    if (message) next.rowErrors[path] = message;
    else {
      delete next.rowErrors[path];
      const value =
        kind === "ports"
          ? items.map(([name, port]) => ({ name, port: Number(port) }))
          : Object.fromEntries(
              items.map(([name, val]) => [
                name,
                kind === "dependencies" ? { condition: val } : val,
              ]),
            );
      next = withValue(next, path, items.length ? value : undefined);
    }
    onChange(next);
  };
  return (
    <div className="app-rows">
      <h3>{label}</h3>
      {rows.map(([key, val], index) => (
        <div className="app-map-row" key={index}>
          <Field
            path={`${path}-key-${index}`}
            label={`${keyLabel} ${index + 1}`}
          >
            {kind === "dependencies" ? (
              <select
                id={fieldID(`${path}-key-${index}`)}
                value={key}
                onChange={(e) =>
                  update(
                    rows.map((r, i) =>
                      i === index ? [e.target.value, val] : r,
                    ),
                  )
                }
              >
                <option value="">Choose app</option>
                {Object.entries(apps)
                  .filter(([id]) => id !== draft.id)
                  .map(([id, app]) => (
                    <option key={id} value={id}>
                      {String(app.name || id)} ({id})
                    </option>
                  ))}
              </select>
            ) : (
              <input
                id={fieldID(`${path}-key-${index}`)}
                value={key}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                onChange={(e) =>
                  update(
                    rows.map((r, i) =>
                      i === index ? [e.target.value, val] : r,
                    ),
                  )
                }
              />
            )}
          </Field>
          <Field
            path={`${path}-value-${index}`}
            label={`${valueLabel} ${index + 1}`}
          >
            {kind === "dependencies" ? (
              <select
                id={fieldID(`${path}-value-${index}`)}
                value={val}
                onChange={(e) =>
                  update(
                    rows.map((r, i) =>
                      i === index ? [key, e.target.value] : r,
                    ),
                  )
                }
              >
                <option value="running">Running</option>
                <option
                  value="healthy"
                  disabled={!valueAt(apps[key] || {}, "health.type")}
                >
                  Healthy
                </option>
              </select>
            ) : (
              <input
                id={fieldID(`${path}-value-${index}`)}
                type={kind === "ports" ? "number" : "text"}
                min={kind === "ports" ? 1 : undefined}
                max={kind === "ports" ? 65535 : undefined}
                value={val}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                onChange={(e) =>
                  update(
                    rows.map((r, i) =>
                      i === index ? [key, e.target.value] : r,
                    ),
                  )
                }
              />
            )}
          </Field>
          <button
            className="button small"
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button small"
        type="button"
        onClick={() =>
          update([...rows, ["", kind === "dependencies" ? "running" : ""]])
        }
      >
        Add {label.toLowerCase()}
      </button>
    </div>
  );
}
function StringRows({
  draft,
  onChange,
  path,
  label,
  errors,
}: Omit<RowsProps, "apps">) {
  const current = valueAt(draft.values, path);
  const rows = Array.isArray(current) ? current.map(String) : [];
  const update = (items: string[]) =>
    onChange(withValue(draft, path, items.length ? items : undefined));
  return (
    <div className="app-rows">
      <h3>{label}s</h3>
      {rows.map((value, index) => (
        <div className="app-list-row" key={index}>
          <Field
            path={`${path}-${index}`}
            label={`${label} ${index + 1}`}
            error={errors[path]}
          >
            <input
              id={fieldID(`${path}-${index}`)}
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) =>
                update(rows.map((v, i) => (i === index ? e.target.value : v)))
              }
            />
          </Field>
          <button
            className="button small"
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        className="button small"
        type="button"
        onClick={() => update([...rows, ""])}
      >
        Add {label.toLowerCase()}
      </button>
    </div>
  );
}

const runnerHelp: Record<string, string> = {
  process: "Run an executable directly. Add each argument separately below.",
  shell:
    "Run a command through your shell, with pipes and shell syntax supported.",
  "docker-compose": "Manage services defined in a Docker Compose file.",
  custom: "Use your own commands to control and inspect an external service.",
  external:
    "Monitor an existing service without starting, stopping, or owning it.",
};

export function AppForm({
  draft,
  creating,
  groups,
  apps,
  errors,
  disabled,
  onChange,
}: AppFormProps) {
  const [customID, setCustomID] = useState(
    () =>
      creating &&
      draft.id !==
        availableID(String(draft.values.name || ""), Object.keys(apps)),
  );
  const [customGroupID, setCustomGroupID] = useState(
    () =>
      !!draft.newGroup &&
      draft.newGroup.id !==
        availableID(draft.newGroup.name, Object.keys(groups), "group"),
  );
  const [pendingType, setPendingType] = useState<AppType | null>(null);
  const pendingTransition = pendingType
    ? changeAppType(draft, pendingType)
    : null;
  const type = String(draft.values.type || "process");
  const observing = type === "external";
  const read = (path: string) => valueAt(draft.values, path);
  const set = (path: string, value: unknown) =>
    onChange(withValue(draft, path, value));
  const inputProps = (path: string) => ({
    id: fieldID(path),
    "aria-invalid": !!errors[path],
    "aria-describedby": errors[path] ? `${fieldID(path)}-error` : undefined,
    autoComplete: "off",
    spellCheck: false,
  });
  const text = (
    path: string,
    label: string,
    hint?: string,
    multiline = false,
  ) => (
    <Field
      key={path}
      path={path}
      label={label}
      hint={hint}
      error={errors[path]}
    >
      {multiline ? (
        <textarea
          {...inputProps(path)}
          rows={3}
          value={String(read(path) ?? "")}
          onChange={(e) => set(path, e.target.value || undefined)}
        />
      ) : (
        <input
          {...inputProps(path)}
          value={String(read(path) ?? "")}
          onChange={(e) => set(path, e.target.value || undefined)}
        />
      )}
    </Field>
  );
  const number = (path: string, label: string, min = 0, max?: number) => (
    <Field key={path} path={path} label={label} error={errors[path]}>
      <input
        {...inputProps(path)}
        type="number"
        step={1}
        min={min}
        max={max}
        placeholder="Default"
        value={String(read(path) ?? "")}
        onChange={(e) =>
          set(path, e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    </Field>
  );
  const select = (
    path: string,
    label: string,
    options: [string, string][],
    fallback = "",
  ) => (
    <Field key={path} path={path} label={label} error={errors[path]}>
      <select
        {...inputProps(path)}
        value={String(read(path) ?? fallback)}
        onChange={(e) => set(path, e.target.value || undefined)}
      >
        {options.map(([value, caption]) => (
          <option key={value} value={value}>
            {caption}
          </option>
        ))}
      </select>
    </Field>
  );
  const boolean = (path: string, label: string) => (
    <Field key={path} path={path} label={label} error={errors[path]}>
      <select
        {...inputProps(path)}
        value={read(path) == null ? "" : String(read(path))}
        onChange={(e) =>
          set(
            path,
            e.target.value === "" ? undefined : e.target.value === "true",
          )
        }
      >
        <option value="">Default</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </select>
    </Field>
  );
  const list = (path: string, label: string) => (
    <StringRows
      key={path}
      draft={draft}
      onChange={onChange}
      path={path}
      label={label}
      errors={errors}
    />
  );
  const map = (
    path: string,
    label: string,
    keyLabel: string,
    valueLabel: string,
    kind?: RowsProps["kind"],
  ) => (
    <MapRows
      key={path}
      draft={draft}
      onChange={onChange}
      apps={apps}
      errors={errors}
      path={path}
      label={label}
      keyLabel={keyLabel}
      valueLabel={valueLabel}
      kind={kind}
    />
  );
  const duration = (path: string, label: string) =>
    text(path, label, "Leave blank for the default. Examples: 500ms, 5s, 1m.");
  const command = (path: string, label: string) => (
    <div key={path} className="app-command">
      {text(`${path}.command`, `${label} command`)}
      <div className="app-field-grid">
        {boolean(`${path}.shell`, `${label} through shell`)}
      </div>
      {path !== "stop" && list(`${path}.args`, `${label} argument`)}
    </div>
  );
  const check = (path: "health" | "detect", caption: string) => {
    const checkType = String(read(`${path}.type`) || "");
    return (
      <>
        <Field
          path={`${path}.type`}
          label={`${caption} check type`}
          error={errors[`${path}.type`]}
        >
          <select
            {...inputProps(`${path}.type`)}
            value={checkType}
            onChange={(e) => {
              if (!e.target.value) {
                onChange(withValue(draft, path, undefined));
                return;
              }
              // Keep timing settings; remove obsolete target settings explicitly on changing check type.
              let next = structuredClone(draft);
              for (const key of [
                "url",
                "host",
                "port",
                "name",
                "path",
                "command",
              ])
                next = withValue(next, `${path}.${key}`, undefined);
              onChange(withValue(next, `${path}.type`, e.target.value));
            }}
          >
            <option value="">None</option>
            <option value="http">HTTP</option>
            <option value="tcp">TCP</option>
            {checkType === "port" && (
              <option value="port">TCP (port alias)</option>
            )}
            <option value="command">Command</option>
            <option value="process">Process</option>
            <option value="pidfile">PID file</option>
            <option value="docker">Docker</option>
          </select>
        </Field>
        {checkType && (
          <>
            <div className="app-field-grid">
              {checkType === "http" &&
                text(`${path}.url`, `${caption} URL`, "An HTTP or HTTPS URL.")}
              {["tcp", "port"].includes(checkType) && (
                <>
                  {text(
                    `${path}.host`,
                    `${caption} host`,
                    "Defaults to 127.0.0.1.",
                  )}
                  {number(`${path}.port`, `${caption} port`, 1, 65535)}
                </>
              )}
              {checkType === "command" &&
                text(`${path}.command`, `${caption} command`)}
              {checkType === "pidfile" &&
                text(`${path}.path`, `${caption} PID file`)}
              {checkType === "process" &&
                text(
                  `${path}.name`,
                  `${caption} process or container name`,
                  path === "detect" || observing
                    ? "Required for process detection."
                    : "Leave blank to use this app.",
                )}
              {duration(`${path}.interval`, `${caption} interval`)}
              {duration(`${path}.timeout`, `${caption} timeout`)}
              {duration(`${path}.initial_delay`, `${caption} initial delay`)}
              {number(
                `${path}.failure_threshold`,
                `${caption} failure threshold`,
                0,
              )}
              {number(
                `${path}.success_threshold`,
                `${caption} success threshold`,
                0,
              )}
            </div>
          </>
        )}
      </>
    );
  };
  return (
    <fieldset className="app-form" disabled={disabled}>
      <legend className="sr-only">Application settings</legend>
      <div className="app-field-grid">
        <Field path="name" label="Display name" error={errors.name}>
          <input
            {...inputProps("name")}
            value={String(read("name") ?? (creating ? "" : draft.id))}
            onChange={(e) => {
              let next = withValue(draft, "name", e.target.value || undefined);
              if (creating && !customID) {
                const id = availableID(e.target.value, Object.keys(apps));
                if (read("docker.project_name") === draft.id)
                  next = withValue(next, "docker.project_name", id);
                next.id = id;
              }
              onChange(next);
            }}
          />
        </Field>
        <Field
          path="id"
          label="App ID"
          error={errors.id}
          hint={
            creating
              ? "Used in dependencies and profiles. Letters, digits, underscores, and hyphens."
              : "App IDs stay fixed to preserve dependencies and history."
          }
        >
          <input
            {...inputProps("id")}
            value={draft.id}
            readOnly={!creating}
            onChange={(e) => {
              setCustomID(true);
              onChange({ ...draft, id: e.target.value });
            }}
          />
        </Field>
        <Field
          path="type"
          label="App type"
          hint={runnerHelp[type]}
          error={errors.type}
        >
          <select
            {...inputProps("type")}
            value={type}
            onChange={(e) => {
              const result = changeAppType(draft, e.target.value as AppType);
              if (result.removedPaths.length)
                setPendingType(e.target.value as AppType);
              else {
                setPendingType(null);
                onChange(result.draft);
              }
            }}
          >
            <option value="process">Process</option>
            <option value="shell">Shell</option>
            <option value="docker-compose">Docker Compose</option>
            <option value="custom">Custom</option>
            <option value="external">Observation only</option>
          </select>
        </Field>
        {text(
          "cwd",
          "Working directory",
          "An existing directory on this host. Leave blank to use the configuration directory.",
        )}
      </div>
      {pendingTransition && (
        <div className="alert warning" role="alert">
          <p>
            Changing type removes these settings:{" "}
            {pendingTransition.removedPaths.join(", ")}. Compatible settings
            will stay.
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="button"
              onClick={() => setPendingType(null)}
            >
              Keep current type
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                onChange(pendingTransition.draft);
                setPendingType(null);
              }}
            >
              Change type and remove settings
            </button>
          </div>
        </div>
      )}
      {text("description", "Description", undefined, true)}
      <Field path="group" label="Group" error={errors.group}>
        <select
          {...inputProps("group")}
          value={
            draft.newGroup ? "__create_group__" : String(read("group") || "")
          }
          onChange={(e) => {
            let next = withValue(draft, "group", e.target.value || undefined);
            if (e.target.value === "__create_group__") {
              const id = availableID("group", Object.keys(groups), "group");
              next = withValue(next, "group", id);
              next.newGroup = { id, name: "", order: 0 };
              setCustomGroupID(false);
            } else delete next.newGroup;
            onChange(next);
          }}
        >
          <option value="">Ungrouped</option>
          {Object.entries(groups)
            .sort(([, a], [, b]) => a.order - b.order)
            .map(([id, group]) => (
              <option key={id} value={id}>
                {group.name || id}
              </option>
            ))}
          <option value="__create_group__">Create group...</option>
        </select>
      </Field>
      {draft.newGroup && (
        <div className="app-new-group app-field-grid">
          <Field
            path="newGroup.name"
            label="New group name"
            error={errors["newGroup.name"]}
          >
            <input
              {...inputProps("newGroup.name")}
              value={draft.newGroup.name}
              onChange={(e) => {
                const id = customGroupID
                  ? draft.newGroup!.id
                  : availableID(e.target.value, Object.keys(groups), "group");
                const next = withValue(draft, "group", id);
                next.newGroup = {
                  ...draft.newGroup!,
                  id,
                  name: e.target.value,
                };
                onChange(next);
              }}
            />
          </Field>
          <Field
            path="newGroup.id"
            label="New group ID"
            error={errors["newGroup.id"]}
          >
            <input
              {...inputProps("newGroup.id")}
              value={draft.newGroup.id}
              onChange={(e) => {
                setCustomGroupID(true);
                const next = withValue(draft, "group", e.target.value);
                next.newGroup = { ...draft.newGroup!, id: e.target.value };
                onChange(next);
              }}
            />
          </Field>
        </div>
      )}
      {observing && (
        <p className="muted">
          Observation only. Stakl checks availability and health. Use the
          service's existing manager for start, stop, restart, and logs.
        </p>
      )}
      {type === "docker-compose" ||
      (observing &&
        (read("detect.type") === "docker" ||
          read("health.type") === "docker")) ? (
        <div className="app-field-grid">
          {text(
            "docker.compose_file",
            "Compose file",
            "Relative to the working directory.",
          )}
          {text(
            "docker.project_name",
            "Project name",
            observing
              ? "Use the existing Compose project name shown by docker compose ls."
              : undefined,
          )}
        </div>
      ) : (
        !observing &&
        text(
          "start.command",
          "Start command",
          type === "process"
            ? "Executable name or path. Put arguments in the section below."
            : "Review this command before starting the app.",
        )
      )}

      {!observing && (
        <details className="app-form-section">
          <summary>Commands and shutdown</summary>
          {type !== "docker-compose" && (
            <>
              {list("start.args", "Start argument")}
              {type !== "shell" &&
                boolean("start.shell", "Start through shell")}
            </>
          )}
          <div className="app-field-grid">
            {select("stop.signal", "Stop signal", [
              ["", "Default (TERM)"],
              ...[
                "TERM",
                "INT",
                "QUIT",
                "HUP",
                "KILL",
                "SIGTERM",
                "SIGINT",
                "SIGQUIT",
                "SIGHUP",
                "SIGKILL",
              ].map((v): [string, string] => [v, v]),
            ])}
            {duration("stop.timeout", "Stop timeout")}
          </div>
          {type === "custom" && (
            <>
              {command("stop", "Stop")}
              {command("status", "Status")}
              {command("restart_command", "Restart")}
              {command("logs", "Logs")}
            </>
          )}
        </details>
      )}
      {type === "docker-compose" && (
        <details className="app-form-section">
          <summary>Compose options</summary>
          {select("docker.stop_mode", "Compose stop mode", [
            ["", "Default (stop)"],
            ["stop", "Stop containers"],
            ["down", "Remove containers (down)"],
          ])}
          {list("docker.profiles", "Compose profile")}
          {list("docker.env_files", "Compose environment file")}
          {list("docker.args", "Compose argument")}
        </details>
      )}
      <details className="app-form-section">
        <summary>Environment</summary>
        <p className="muted">
          Values are visible while editing. They are saved to the local
          configuration file.
        </p>
        {boolean("inherit_env", "Inherit environment")}
        {map(
          "env",
          "Environment variable",
          "Environment variable name",
          "Environment variable value",
        )}
        {list("env_file", "Environment file")}
      </details>
      <details className="app-form-section" open={observing ? true : undefined}>
        <summary>Health and detection</summary>
        <h3>Health</h3>
        {check("health", "Health")}
        <h3>Detection</h3>
        <p className="muted">
          Recognize a service that is already running. Detection establishes
          availability, not process identity or ownership.
        </p>
        {check("detect", "Detection")}
      </details>
      <details className="app-form-section">
        <summary>
          {observing ? "Dependencies" : "Dependencies and startup"}
        </summary>
        {map(
          "depends_on",
          "Dependency",
          "Dependency app",
          "Dependency condition",
          "dependencies",
        )}
        {!observing && (
          <div className="app-field-grid">
            {boolean("autostart.enabled", "Autostart")}
            {duration("autostart.delay", "Autostart delay")}
            {select("restart.policy", "Restart policy", [
              ["", "Default"],
              ["never", "Never"],
              ["always", "Always"],
              ["on-failure", "On failure"],
            ])}
            {number("restart.max_attempts", "Maximum restart attempts")}
            {duration("restart.delay", "Restart delay")}
            {select("restart.backoff", "Restart backoff", [
              ["", "Default"],
              ["fixed", "Fixed"],
              ["exponential", "Exponential"],
            ])}
            {boolean("lifecycle.stop_on_stakl_exit", "Stop when Stakl exits")}
          </div>
        )}
      </details>
      <details className="app-form-section">
        <summary>Display and notifications</summary>
        {map("links", "Link", "Link name", "Link URL")}
        {map("ports", "Port", "Port name", "Port number", "ports")}
        {list("tags", "Tag")}
        <div className="app-field-grid">
          {text(
            "icon",
            "Icon",
            "Examples: terminal, box, server, globe, code, heart.",
          )}
          {boolean("favorite", "Favorite")}
          {boolean("notifications", "Notifications")}
        </div>
        {text("notes", "Notes", undefined, true)}
      </details>
    </fieldset>
  );
}

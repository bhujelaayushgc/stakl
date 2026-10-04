import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppForm } from "./AppForm";
import {
  buildAppConfiguration,
  createAppDraft,
  loadAppDraft,
} from "./app-config";
import YAML from "yaml";

const raw = `version: 1
groups: {dev: {name: Development, order: 10}}
apps:
  worker: {name: Worker, type: process, cwd: /tmp, start: {command: sleep, args: ['120']}, inherit_env: false}
  database: {name: Database, type: process, cwd: /tmp, start: {command: run}, health: {type: tcp, port: 5432}}
`;
function setup(creating = true, type = "process") {
  const original = creating ? createAppDraft(raw) : loadAppDraft(raw, "worker");
  original.values.type = type;
  function Harness() {
    const [draft, setDraft] = useState(original);
    const [saved, setSaved] = useState("");
    return (
      <>
        <AppForm
          draft={draft}
          creating={creating}
          groups={YAML.parse(raw).groups}
          apps={YAML.parse(raw).apps}
          errors={{}}
          disabled={false}
          onChange={setDraft}
        />
        <button
          onClick={() => {
            try {
              setSaved(buildAppConfiguration(raw, original, draft, creating));
            } catch (e) {
              setSaved((e as Error).message);
            }
          }}
        >
          Capture
        </button>
        <pre data-testid="saved">{saved}</pre>
      </>
    );
  }
  render(<Harness />);
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
const saved = () => {
  fireEvent.click(screen.getByText("Capture"));
  return YAML.parse(screen.getByTestId("saved").textContent || "");
};
afterEach(cleanup);

it("creates a uniquely named app and an inline group without YAML", () => {
  setup();
  change("Display name", "Worker");
  expect(screen.getByLabelText("App ID", { exact: true })).toHaveValue(
    "worker-2",
  );
  change("Working directory", "/tmp");
  change("Start command", "sleep");
  change("Group", "__create_group__");
  change("New group name", "Development");
  expect(screen.getByLabelText("New group ID", { exact: true })).toHaveValue(
    "development",
  );
  change("New group ID", "lab");
  const config = saved();
  expect(config.groups.lab).toEqual({ name: "Development", order: 0 });
  expect(config.apps["worker-2"].group).toBe("lab");
});

it("keeps existing IDs read-only and edits/clears group membership", () => {
  setup(false);
  expect(screen.getByLabelText("App ID", { exact: true })).toHaveAttribute(
    "readonly",
  );
  change("Group", "dev");
  expect(saved().apps.worker.group).toBe("dev");
  change("Group", "");
  expect(saved().apps.worker.group).toBeUndefined();
});

it.each(["process", "shell", "docker-compose", "custom"])(
  "shows the controls for %s",
  (type) => {
    setup(true, type);
    if (type === "docker-compose") {
      expect(
        screen.getByLabelText("Compose file", { exact: true }),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Start command", { exact: true }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByLabelText("Compose stop mode", { exact: true }),
      ).toBeInTheDocument();
    } else
      expect(
        screen.getByLabelText("Start command", { exact: true }),
      ).toBeInTheDocument();
    if (type === "custom")
      expect(
        screen.getByLabelText("Status command", { exact: true }),
      ).toBeInTheDocument();
    else
      expect(
        screen.queryByLabelText("Status command", { exact: true }),
      ).not.toBeInTheDocument();
  },
);

it("retains type-specific settings when a type change is canceled", () => {
  setup(true, "custom");
  change("Status command", "status-tool");
  change("App type", "process");
  expect(screen.getByRole("alert")).toHaveTextContent("status");
  fireEvent.click(screen.getByRole("button", { name: "Keep current type" }));
  expect(screen.getByLabelText("Status command", { exact: true })).toHaveValue(
    "status-tool",
  );
  change("App type", "process");
  fireEvent.click(
    screen.getByRole("button", { name: "Change type and remove settings" }),
  );
  expect(
    screen.queryByLabelText("Status command", { exact: true }),
  ).not.toBeInTheDocument();
});

it("stores arguments with spaces as single values", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Add start argument" }));
  change("Start argument 1", "hello world");
  const config = saved();
  expect(config.apps.app.start.args).toEqual(["hello world"]);
});

it("keeps duplicate map rows visible and blocks a lossy save", () => {
  setup();
  fireEvent.click(
    screen.getByRole("button", { name: "Add environment variable" }),
  );
  change("Environment variable name 1", "TOKEN");
  change("Environment variable value 1", "one");
  fireEvent.click(
    screen.getByRole("button", { name: "Add environment variable" }),
  );
  change("Environment variable name 2", "TOKEN");
  change("Environment variable value 2", "two");
  expect(screen.getByRole("alert")).toHaveTextContent(/duplicate/i);
  expect(
    screen.getByLabelText("Environment variable value 1", { exact: true }),
  ).toHaveValue("one");
  fireEvent.click(screen.getByText("Capture"));
  expect(screen.getByTestId("saved")).toHaveTextContent(/duplicate/i);
});

it("supports health checks, healthy dependencies, and inherited booleans", () => {
  setup(false);
  change("Health check type", "tcp");
  change("Health port", "8080");
  fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
  change("Dependency app 1", "database");
  change("Dependency condition 1", "healthy");
  change("Inherit environment", "");
  change("Notifications", "false");
  const app = saved().apps.worker;
  expect(app.health).toEqual({ type: "tcp", port: 8080 });
  expect(app.depends_on).toEqual({ database: { condition: "healthy" } });
  expect(app.inherit_env).toBeUndefined();
  expect(app.notifications).toBe(false);
});

it("does not materialize defaults when only the name changes", () => {
  setup(false);
  change("Display name", "Renamed");
  const app = saved().apps.worker;
  expect(app.stop).toBeUndefined();
  expect(app.autostart).toBeUndefined();
  expect(app.notifications).toBeUndefined();
  expect(app.inherit_env).toBe(false);
});

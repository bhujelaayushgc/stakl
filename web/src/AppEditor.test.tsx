import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import { AppEditor } from "./AppEditor";
import type { DiscoverySuggestion } from "./app-config";

const raw = `# preserved workspace
version: 1
groups: {dev: {name: Development, order: 10}}
apps:
  worker:
    name: Worker # app comment
    type: process
    cwd: /tmp
    start: {command: sleep, args: ['120']}
    env: {TOKEN: actual-value}
    autostart: true
`;
function setup({
  editing = true,
  source = raw,
  saveError = "",
  validationError = "",
  saveDelay,
  suggestion,
}: {
  editing?: boolean;
  source?: string;
  saveError?: string;
  validationError?: string;
  saveDelay?: Promise<void>;
  suggestion?: DiscoverySuggestion;
} = {}) {
  const server = {
    raw: source,
    revision: "opening-revision",
    writes: [] as { yaml: string; revision: string }[],
    requests: [] as string[],
  };
  vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
    server.requests.push(path);
    if (path === "/api/config?raw=true")
      return Response.json({
        raw: server.raw,
        revision: server.revision,
        groups: {},
        profiles: {},
        path: "/fixture/config.yml",
        error: "",
      });
    if (path === "/api/config/validate")
      return Response.json(
        validationError ? { error: validationError } : { ok: true },
        { status: validationError ? 400 : 200 },
      );
    if (path === "/api/config/save") {
      const input = JSON.parse(String(options.body));
      server.writes.push(input);
      if (saveDelay) await saveDelay;
      if (saveError)
        return Response.json({ error: saveError }, { status: 409 });
      server.raw = input.yaml;
      server.revision = "saved-revision";
      return Response.json({ ok: true, revision: server.revision });
    }
    throw Error(`Unexpected request: ${path}`);
  });
  function Harness() {
    const [saved, setSaved] = useState("");
    const [dirty, setDirty] = useState(false);
    const [canceled, setCanceled] = useState(false);
    const [fullEditor, setFullEditor] = useState(false);
    return (
      <>
        <AppEditor
          appID={editing ? "worker" : undefined}
          suggestion={suggestion}
          onSaved={setSaved}
          onCancel={() => setCanceled(true)}
          onOpenConfig={() => setFullEditor(true)}
          onDirtyChange={setDirty}
        />
        <output>
          {saved && `Saved ${saved}`}
          {dirty && " Unsaved"}
          {canceled && " Canceled"}
          {fullEditor && " Full configuration opened"}
        </output>
      </>
    );
  }
  render(<Harness />);
  return server;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("keeps a manually chosen creation ID after returning from YAML mode", async () => {
  const server = setup({ editing: false });
  await screen.findByLabelText("Display name", { exact: true });
  change("Display name", "Manual app");
  change("App ID", "chosen-id");
  change("Working directory", "/tmp");
  change("Start command", "sleep");
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  change("Display name", "Renamed manual app");
  expect(screen.getByLabelText("App ID", { exact: true })).toHaveValue(
    "chosen-id",
  );
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));
  await screen.findByText("Saved chosen-id");
  expect(YAML.parse(server.raw).apps["chosen-id"].name).toBe(
    "Renamed manual app",
  );
});
it("disables repeat submission while a save is pending", async () => {
  let release!: () => void;
  const saveDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = setup({ saveDelay });
  await screen.findByLabelText("Display name", { exact: true });
  change("Display name", "Changed once");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const pending = await screen.findByRole("button", { name: "Saving..." });
  expect(pending).toBeDisabled();
  fireEvent.submit(pending.closest("form")!);
  release();
  await screen.findByText("Saved worker");
  expect(server.writes).toHaveLength(1);
  expect(YAML.parse(server.raw).apps.worker.name).toBe("Changed once");
});
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });

it("loads actual source and saves only edits with the opening revision", async () => {
  const server = setup();
  await screen.findByLabelText("Display name", { exact: true });
  expect(
    screen.getByLabelText("Environment variable value 1", { exact: true }),
  ).toHaveValue("actual-value");
  change("Display name", "Renamed worker");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved worker");
  expect(server.writes[0].revision).toBe("opening-revision");
  expect(YAML.parse(server.raw).apps.worker.autostart).toBe(true);
  expect(server.raw).toContain("# app comment");
  expect(server.requests.filter((p) => p !== "/api/config?raw=true")).toEqual([
    "/api/config/validate",
    "/api/config/save",
  ]);
});
it("allows name-only edits with the backend-supported default working directory", async () => {
  const server = setup({
    source:
      "version: 1\napps: {worker: {name: Worker, type: process, start: {command: sleep}}}\n",
  });
  await screen.findByLabelText("Display name", { exact: true });
  change("Display name", "Renamed default directory app");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved worker");
  expect(Object.hasOwn(YAML.parse(server.raw).apps.worker, "cwd")).toBe(false);
});

it("prefills a discovered app and creates it with a group in one save", async () => {
  const server = setup({
    editing: false,
    suggestion: {
      name: "Project",
      path: "/tmp",
      type: "shell",
      command: "npm run dev",
      indicator: "package.json",
    },
  });
  expect(
    await screen.findByLabelText("Start command", { exact: true }),
  ).toHaveValue("npm run dev");
  change("Group", "__create_group__");
  change("New group name", "Home lab");
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));
  await screen.findByText("Saved project");
  const config = YAML.parse(server.raw);
  expect(config.groups["home-lab"].name).toBe("Home lab");
  expect(config.apps.project.group).toBe("home-lab");
  expect(server.writes).toHaveLength(1);
});

it("syncs form and YAML edits including comments and pending groups", async () => {
  const server = setup();
  await screen.findByLabelText("Display name", { exact: true });
  change("Group", "__create_group__");
  change("New group name", "Lab");
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  const editor = screen.getByLabelText("Application YAML", { exact: true });
  fireEvent.change(editor, {
    target: {
      value: (editor as HTMLTextAreaElement).value
        .replace("name: Worker", "name: YAML worker")
        .replace("# app comment", "# intentional comment"),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByLabelText("Display name", { exact: true })).toHaveValue(
    "YAML worker",
  );
  change("Working directory", "/var/tmp");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved worker");
  expect(server.raw).toContain("# intentional comment");
  const config = YAML.parse(server.raw);
  expect(config.groups.lab.name).toBe("Lab");
  expect(config.apps.worker).toMatchObject({
    name: "YAML worker",
    cwd: "/var/tmp",
    group: "lab",
  });
});

it("preserves string scalar spellings when switching between form and YAML", async () => {
  const server = setup({
    source: raw.replace(
      "env: {TOKEN: actual-value}",
      "env: {TOKEN: 001234, FLAG: TRUE}",
    ),
  });
  await screen.findByLabelText("Display name", { exact: true });
  const expectValues = () => {
    expect(
      screen.getByLabelText("Environment variable value 1", { exact: true }),
    ).toHaveValue("001234");
    expect(
      screen.getByLabelText("Environment variable value 2", { exact: true }),
    ).toHaveValue("TRUE");
  };
  expectValues();
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  const yaml = (
    screen.getByLabelText("Application YAML", {
      exact: true,
    }) as HTMLTextAreaElement
  ).value;
  expect(yaml).toContain("TOKEN: 001234");
  expect(yaml).toContain("FLAG: TRUE");
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expectValues();
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  change("Application YAML", yaml.replace("name: Worker", "name: YAML worker"));
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expectValues();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved worker");
  expect(server.raw).toContain("TOKEN: 001234");
  expect(server.raw).toContain("FLAG: TRUE");
});

it("retains invalid YAML and blocks changing an existing ID", async () => {
  const server = setup();
  await screen.findByLabelText("Display name", { exact: true });
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  change("Application YAML", "worker: [");
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/YAML/i);
  expect(
    screen.getByLabelText("Application YAML", { exact: true }),
  ).toHaveValue("worker: [");
  change(
    "Application YAML",
    "other: {name: Other, type: process, cwd: /tmp, start: {command: sleep}}\n",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/ID/);
  expect(server.writes).toHaveLength(0);
});

it("requires full YAML for anchors instead of flattening the source", async () => {
  setup({
    source:
      "version: 1\napps: {worker: &app {name: Worker, type: process, cwd: /tmp, start: {command: sleep}}}\n",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(/anchor/i);
  expect(
    screen.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Open full configuration" }),
  );
  expect(screen.getByText(/Full configuration opened/)).toBeInTheDocument();
});

it("maps backend field errors and retains the entered draft", async () => {
  const server = setup({
    validationError: "apps.worker.health.url must be an HTTP(S) URL",
  });
  await screen.findByLabelText("Display name", { exact: true });
  change("Health check type", "http");
  change("Health URL", "invalid-url");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP(S)"),
  );
  expect(screen.getByLabelText("Health URL", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(screen.getByLabelText("Health URL", { exact: true })).toHaveValue(
    "invalid-url",
  );
  expect(server.writes).toHaveLength(0);
});

it("retains a stale-revision draft until the user explicitly reloads", async () => {
  const server = setup({
    saveError:
      "configuration changed on disk or revision is missing; reload the editor before saving",
  });
  await screen.findByLabelText("Display name", { exact: true });
  change("Display name", "My draft");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Reload configuration" });
  expect(screen.getByLabelText("Display name", { exact: true })).toHaveValue(
    "My draft",
  );
  expect(server.writes[0].revision).toBe("opening-revision");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  expect(screen.getByLabelText("Display name", { exact: true })).toHaveValue(
    "My draft",
  );
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Display name", { exact: true })).toHaveValue(
      "Worker",
    ),
  );
});

it("guards cancel and browser unload while the draft is dirty", async () => {
  setup();
  await screen.findByLabelText("Display name", { exact: true });
  change("Display name", "Changed");
  await screen.findByText(/Unsaved/);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/Canceled/)).not.toBeInTheDocument();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Canceled/)).toBeInTheDocument();
});

it("reports missing creation fields without submitting", async () => {
  const server = setup({ editing: false });
  await screen.findByLabelText("Display name", { exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));
  expect(
    screen.getByLabelText("Start command", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  expect(server.writes).toHaveLength(0);
});

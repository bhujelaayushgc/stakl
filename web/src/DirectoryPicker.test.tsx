import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

it("navigates host folders and selects the canonical host path", async () => {
  const selected = vi.fn();
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://localhost").searchParams.get("path");
    if (path === "/projects")
      return Response.json({
        path: "/projects",
        parent: "/",
        directories: ["api"],
        truncated: false,
      });
    if (path === "/projects/api")
      return Response.json({
        path: "/real/api",
        parent: "/real",
        directories: [],
        truncated: false,
      });
    throw Error(`Unexpected directory: ${path}`);
  });
  render(<DirectoryPicker initialPath="/projects" onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  fireEvent.click(
    await screen.findByRole("option", { name: "Open folder api" }),
  );
  await screen.findByText("/real/api", { exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(selected).toHaveBeenCalledWith("/real/api");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("filters folder names and restores the list when cleared", async () => {
  const selected = vi.fn();
  vi.stubGlobal("fetch", async () =>
    Response.json({
      path: "/projects",
      parent: "/",
      directories: ["API", "api-client", "website"],
      truncated: false,
    }),
  );
  render(<DirectoryPicker initialPath="/projects" onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("option", { name: "Open folder website" });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });

  fireEvent.change(filter, { target: { value: " aPi " } });
  expect(screen.getByRole("option", { name: "Open folder API" })).toBeVisible();
  expect(
    screen.getByRole("option", { name: "Open folder api-client" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Open folder website" }),
  ).not.toBeInTheDocument();

  fireEvent.change(filter, { target: { value: "missing" } });
  expect(screen.queryByRole("option", { name: /^Open folder / })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("No matching folders.");
  expect(screen.queryByText("No subfolders.")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(filter).toHaveValue("");
  expect(screen.getAllByRole("option", { name: /^Open folder / })).toHaveLength(
    3,
  );
  expect(screen.queryByText("No matching folders.")).not.toBeInTheDocument();

  fireEvent.change(filter, { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(selected).toHaveBeenCalledWith("/projects");
});

it("resets the filter when navigating or reopening the browser", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://localhost").searchParams.get("path");
    return Response.json({
      path,
      parent: "/",
      directories: path === "/projects" ? ["api", "website"] : ["logs"],
      truncated: false,
    });
  });
  render(<DirectoryPicker initialPath="/projects" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("option", { name: "Open folder api" });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  fireEvent.change(filter, { target: { value: "api" } });
  fireEvent.click(screen.getByRole("option", { name: "Open folder api" }));
  expect(
    await screen.findByRole("option", { name: "Open folder logs" }),
  ).toBeVisible();
  expect(filter).toHaveValue("");

  fireEvent.change(filter, { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(
    await screen.findByRole("option", { name: "Open folder website" }),
  ).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Filter folders" })).toHaveValue(
    "",
  );
});

it("focuses the filter after opening and every directory navigation", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    const path =
      new URL(url, "http://localhost").searchParams.get("path") || "/projects";
    return Response.json({
      path,
      parent: path === "/projects/api" ? "/projects" : "/",
      directories: path === "/projects/api" ? ["logs"] : ["api"],
      truncated: false,
    });
  });
  render(<DirectoryPicker initialPath="/projects" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("option", { name: "Open folder api" });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  await waitFor(() => expect(filter).toHaveFocus());

  const folder = screen.getByRole("option", { name: "Open folder api" });
  folder.focus();
  fireEvent.click(folder);
  await screen.findByRole("option", { name: "Open folder logs" });
  await waitFor(() => expect(filter).toHaveFocus());

  const up = screen.getByRole("button", { name: "Up one level" });
  up.focus();
  fireEvent.click(up);
  await screen.findByRole("option", { name: "Open folder api" });
  await waitFor(() => expect(filter).toHaveFocus());

  const home = screen.getByRole("button", { name: "Home directory" });
  home.focus();
  fireEvent.click(home);
  await waitFor(() => expect(filter).toHaveFocus());
});

it("opens the highlighted folder with Enter and selects it with Ctrl+Enter", async () => {
  const selected = vi.fn();
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://localhost").searchParams.get("path");
    if (path === "/projects")
      return Response.json({
        path,
        parent: "/",
        directories: ["api", "website"],
        truncated: false,
      });
    if (path === "/projects/website")
      return Response.json({
        path: "/real/website",
        parent: "/real",
        directories: ["logs"],
        truncated: false,
      });
    throw Error(`Unexpected directory: ${path}`);
  });
  render(<DirectoryPicker initialPath="/projects" onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  const api = await screen.findByRole("option", { name: "Open folder api" });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  expect(api).toHaveAttribute("aria-selected", "true");
  expect(filter).toHaveAttribute("aria-activedescendant", api.id);
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  const website = screen.getByRole("option", { name: "Open folder website" });
  expect(website).toHaveAttribute("aria-selected", "true");
  expect(filter).toHaveAttribute("aria-activedescendant", website.id);
  expect(filter).toHaveFocus();
  fireEvent.keyDown(filter, { key: "Enter" });
  await screen.findByRole("option", { name: "Open folder logs" });
  expect(filter).toHaveValue("");
  expect(filter).toHaveFocus();
  fireEvent.keyDown(filter, { key: "Enter", ctrlKey: true });
  expect(selected).toHaveBeenCalledWith("/real/website");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps keyboard selection within the filtered list", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      path: "/projects",
      parent: "/",
      directories: ["api", "website", "worker"],
      truncated: false,
    }),
  );
  render(<DirectoryPicker initialPath="/projects" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("option", { name: "Open folder api" });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  fireEvent.keyDown(filter, { key: "ArrowUp" });
  expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
    "Open folder api",
  );
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
    "Open folder worker",
  );
  fireEvent.change(filter, { target: { value: "site" } });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
    "Open folder website",
  );
  fireEvent.change(filter, { target: { value: "missing" } });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(
    screen.queryByRole("option", { selected: true }),
  ).not.toBeInTheDocument();
  expect(filter).not.toHaveAttribute("aria-activedescendant");
  expect(screen.getByText("/projects", { exact: true })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
    "Open folder api",
  );
  expect(filter).toHaveFocus();
});

it.each([
  ["/", "/"],
  ["~/", "/home/operator"],
  ["../", "/"],
])(
  "jumps to the directory shortcut %s without Enter",
  async (shortcut, destination) => {
    vi.stubGlobal("fetch", async (url: string) => {
      const path =
        new URL(url, "http://localhost").searchParams.get("path") ||
        "/home/operator";
      return Response.json({
        path,
        parent: path === "/" ? "" : "/",
        directories: [],
        truncated: false,
      });
    });
    render(<DirectoryPicker initialPath="/projects" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByText("/projects", { exact: true });
    const filter = screen.getByRole("combobox", { name: "Filter folders" });
    fireEvent.change(filter, { target: { value: shortcut } });
    expect(
      await screen.findByText(destination, { exact: true, selector: "code" }),
    ).toBeVisible();
    expect(filter).toHaveValue("");
    expect(filter).toHaveFocus();
  },
);

it.each([
  ["/Other/Project", "/Other/Project", "/real/project"],
  ["~/Projects/App", "~/Projects/App", "/home/operator/Projects/App"],
  ["../API", "/projects/../API", "/API"],
  ["nested/API", "/projects/nested/API", "/projects/nested/API"],
])(
  "navigates the pasted path %s with Enter",
  async (input, requested, canonical) => {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      if (path === "/projects")
        return Response.json({
          path,
          parent: "/",
          directories: ["api"],
          truncated: false,
        });
      if (path === requested)
        return Response.json({
          path: canonical,
          parent: "/",
          directories: [],
          truncated: false,
        });
      throw Error(`Unexpected directory: ${path}`);
    });
    render(<DirectoryPicker initialPath="/projects" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByRole("option", { name: "Open folder api" });
    const filter = screen.getByRole("combobox", { name: "Filter folders" });
    fireEvent.change(filter, { target: { value: input } });
    expect(screen.getByRole("status")).toHaveTextContent(
      /press enter to open this path/i,
    );
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(await screen.findByText(canonical, { exact: true })).toBeVisible();
    expect(filter).toHaveValue("");
    expect(filter).toHaveFocus();
  },
);

it("goes up with Alt+Up and selects the current directory with Cmd+Enter", async () => {
  const selected = vi.fn();
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "http://localhost").searchParams.get("path");
    return Response.json({
      path,
      parent: path === "/" ? "" : "/",
      directories: [],
      truncated: false,
    });
  });
  render(<DirectoryPicker initialPath="/projects" onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByText("/projects", { exact: true });
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  fireEvent.keyDown(filter, { key: "ArrowUp", altKey: true });
  await screen.findByText("/", { exact: true, selector: "code" });
  fireEvent.keyDown(filter, { key: "ArrowUp", altKey: true });
  expect(
    screen.getByText("/", { exact: true, selector: "code" }),
  ).toBeVisible();
  fireEvent.keyDown(filter, { key: "Enter", metaKey: true });
  expect(selected).toHaveBeenCalledWith("/");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("ignores keyboard actions while loading or composing text", async () => {
  const selected = vi.fn();
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  render(<DirectoryPicker initialPath="/projects" onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  const filter = screen.getByRole("combobox", { name: "Filter folders" });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "Enter" });
  fireEvent.keyDown(filter, { key: "Enter", ctrlKey: true });
  expect(selected).not.toHaveBeenCalled();
  await act(async () =>
    finish(
      Response.json({
        path: "/projects",
        parent: "/",
        directories: ["api"],
        truncated: false,
      }),
    ),
  );
  await act(async () => {
    fireEvent.keyDown(filter, { key: "Enter", isComposing: true });
  });
  expect(screen.getByText("/projects", { exact: true })).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(selected).not.toHaveBeenCalled();
});

it("recovers from an invalid typed path using the host home directory", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("missing"))
      return Response.json(
        { error: "directory is inaccessible" },
        { status: 400 },
      );
    return Response.json({
      path: "/home/operator",
      parent: "/home",
      directories: [],
      truncated: false,
    });
  });
  render(<DirectoryPicker initialPath="/missing" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/inaccessible/);
  expect(
    screen.getByRole("button", { name: "Select this folder" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Home directory" }));
  await screen.findByText("/home/operator", { exact: true });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not replace a newer navigation with a stale response", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", (url: string) =>
    url.includes("slow")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(
          Response.json({
            path: "/home/operator",
            parent: "/home",
            directories: [],
            truncated: false,
          }),
        ),
  );
  render(<DirectoryPicker initialPath="/slow" onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Home directory" }),
  );
  await screen.findByText("/home/operator", { exact: true });
  finish(
    Response.json({
      path: "/slow",
      parent: "/",
      directories: [],
      truncated: false,
    }),
  );
  await waitFor(() =>
    expect(
      within(dialog).queryByText("/slow", { exact: true }),
    ).not.toBeInTheDocument(),
  );
});

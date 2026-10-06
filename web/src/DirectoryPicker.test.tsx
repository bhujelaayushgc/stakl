import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    await screen.findByRole("button", { name: "Open folder api" }),
  );
  await screen.findByText("/real/api", { exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
  expect(selected).toHaveBeenCalledWith("/real/api");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

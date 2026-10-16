import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServicePicker } from "./ServicePicker";

afterEach(cleanup);
const options = [
  { value: "db", label: "Local / PostgreSQL", detail: "database" },
  { value: "cache", label: "Local / Redis", detail: "cache", disabled: true },
  { value: "memos", label: "Garage / Memos", detail: "memos-backend" },
];

it("filters suggestions by service name, ID and host without changing the selected service", () => {
  const onChange = vi.fn();
  render(
    <ServicePicker
      label="Service 1"
      value="db"
      options={options}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Service 1" });
  for (const query of ["MEMOS", "memos-backend", "garage"]) {
    fireEvent.change(input, { target: { value: query } });
    expect(
      screen.getByRole("option", { name: "Garage / Memos" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Local / PostgreSQL" }),
    ).not.toBeInTheDocument();
  }
  fireEvent.change(input, { target: { value: "nothing-matches" } });
  expect(screen.getByRole("status")).toHaveTextContent("No matching services");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("Local / PostgreSQL");
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(onChange).not.toHaveBeenCalled();
});

it("selects matching services by keyboard while skipping services already added", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ServicePicker
      label="Service 1"
      value="db"
      options={options}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Service 1" });
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(
    document.getElementById(input.getAttribute("aria-activedescendant")!),
  ).toHaveTextContent("Garage / Memos");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("memos");
  rerender(
    <ServicePicker
      label="Service 1"
      value="memos"
      options={options}
      onChange={onChange}
    />,
  );
  expect(input).toHaveValue("Garage / Memos");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("selects clicked suggestions and prevents selecting an already-added service", () => {
  const onChange = vi.fn();
  render(
    <ServicePicker
      label="Service 1"
      value="db"
      options={options}
      onChange={onChange}
    />,
  );
  fireEvent.focus(screen.getByRole("combobox", { name: "Service 1" }));
  const used = screen.getByRole("option", { name: "Local / Redis" });
  expect(used).toBeDisabled();
  fireEvent.click(used);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option", { name: "Garage / Memos" }));
  expect(onChange).toHaveBeenCalledWith("memos");
});

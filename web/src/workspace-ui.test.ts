import { expect, it } from "vitest";
import { workspaceUses } from "./workspace-ui";
it("derives shared impact using controller identity and required/optional membership", () => {
  const defs = {
    a: {
      name: "A",
      services: { db: { controller: "local", app: "db", required: true } },
    },
    b: {
      name: "B",
      services: {
        database: {
          controller: "0123456789abcdef0123456789abcdef",
          app: "db",
          required: false,
        },
      },
    },
    c: {
      name: "Peer",
      services: {
        db: { controller: "abcdef0123456789abcdef0123456789", app: "db" },
      },
    },
  };
  expect(
    workspaceUses(defs, "local", "db", "0123456789abcdef0123456789abcdef"),
  ).toEqual([
    { id: "a", name: "A", service: "db", required: true },
    { id: "b", name: "B", service: "database", required: false },
  ]);
  expect(
    workspaceUses(
      defs,
      "abcdef0123456789abcdef0123456789",
      "db",
      "0123456789abcdef0123456789abcdef",
    ),
  ).toEqual([{ id: "c", name: "Peer", service: "db", required: true }]);
});

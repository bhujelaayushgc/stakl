import type { HostDescription } from "./types";
export type Readiness = "ready" | "blocked" | "unknown" | "degraded";
export type WorkspaceUse = {
  id: string;
  name: string;
  service: string;
  required: boolean;
};
export type WorkspaceCheckView = {
  id: string;
  name: string;
  service: string;
  type: string;
  origin: string;
  state: Readiness;
  reason: string;
  checked_at: string;
  latency: number;
  interval: string;
};
export type WorkspaceMember = {
  alias: string;
  controller: string;
  app: string;
  name: string;
  condition: string;
  required: boolean;
  state: Readiness;
  reason: string;
  runtime_state: string;
  observed_at: string;
  observation_fresh?: boolean;
  host?: HostDescription;
  controllable: boolean;
  uses: WorkspaceUse[];
  checks: WorkspaceCheckView[];
};
export type WorkspaceView = {
  id: string;
  name: string;
  description: string;
  state: Readiness;
  origin: string;
  members: WorkspaceMember[];
  required_issues: number;
  optional_issues: number;
};

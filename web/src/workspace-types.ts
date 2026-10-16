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
  actions?: { start: boolean; stop: boolean; reason: string };
  uses: WorkspaceUse[];
  checks: WorkspaceCheckView[];
};
export type WorkspaceView = {
  revision?: string;
  id: string;
  name: string;
  description: string;
  state: Readiness;
  origin: string;
  members: WorkspaceMember[];
  required_issues: number;
  optional_issues: number;
};

export type WorkspaceOperation = {
  workspace: string;
  action: "start" | "stop";
  results: {
    alias: string;
    controller: string;
    app: string;
    name: string;
    action: "start" | "stop";
    status:
      | "started"
      | "stopped"
      | "already_running"
      | "skipped"
      | "failed"
      | "outcome_unknown";
    message: string;
  }[];
};

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
export default async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "localdesk-browser-"));
  const net = createServer();
  await new Promise<void>((r) => net.listen(0, "127.0.0.1", r));
  const port = (net.address() as { port: number }).port;
  await new Promise<void>((r) => net.close(() => r()));
  const path = join(dir, "config.yml");
  await writeFile(
    path,
    `version: 1
server: {port: ${port}, open_browser: false}
groups:
  development: {name: Development, order: 10}
profiles:
  stack: {name: Test workspace, apps: [ticker, idle]}
apps:
  ticker:
    name: Heartbeat service
    description: Real background process used by browser tests
    type: shell
    group: development
    cwd: ${JSON.stringify(dir)}
    start:
      command: 'while true; do echo heartbeat; echo diagnostic >&2; sleep 1; done'
    health: {type: process, interval: 200ms}
    stop: {timeout: 1s}
    favorite: true
  idle:
    name: Idle worker
    description: A foreground worker ready to start
    type: process
    group: development
    cwd: ${JSON.stringify(dir)}
    start: {command: sleep, args: ['120']}
    stop: {timeout: 1s}
    depends_on:
      ticker: {condition: healthy}
`,
  );
  const child = spawn(
    resolve("../bin/localdesk"),
    ["--config", path, "--no-browser"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  let instance: { url: string; token: string } | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      instance = JSON.parse(await readFile(join(dir, "instance.json"), "utf8"));
      break;
    } catch {
      if (child.exitCode !== null) throw Error(output);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!instance) {
    child.kill();
    throw Error("Controller did not start: " + output);
  }
  process.env.LOCALDESK_TEST_INSTANCE = JSON.stringify(instance);
  process.env.LOCALDESK_TEST_CONFIG = path;
  return async () => {
    try {
      await fetch(instance!.url + "/api/actions/stop?confirm=true", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + instance!.token,
          "X-LocalDesk": "1",
        },
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r();
        else child.once("exit", () => r());
      });
      await rm(dir, { recursive: true, force: true });
    }
  };
}

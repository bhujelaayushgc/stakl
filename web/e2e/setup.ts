import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createViteServer } from "vite";
export default async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "stakl-browser-"));
  const children: ReturnType<typeof spawn>[] = [];
  const instances: { url: string; token: string }[] = [];
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  const cleanup = async () => {
    await Promise.allSettled(
      instances.map((instance) =>
        fetch(instance.url + "/api/actions/stop?confirm=true", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + instance.token,
            "X-Stakl": "1",
          },
          signal: AbortSignal.timeout(15000),
        }),
      ),
    );
    try {
      await vite?.close();
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
              child.once("exit", () => resolve());
              child.kill("SIGTERM");
            }),
        ),
      );
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
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
      resolve("../bin/stakl"),
      ["--config", path, "--no-browser"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    let instance: { url: string; token: string } | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        instance = JSON.parse(
          await readFile(join(dir, "instance.json"), "utf8"),
        );
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
    instances.push(instance);
    const peerDir = join(dir, "peer");
    await mkdir(peerDir);
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const peerPort = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const peerConfig = join(peerDir, "config.yml");
    await writeFile(
      peerConfig,
      `version: 1
server: {port: ${peerPort}, open_browser: false}
groups:
  development: {name: Development, order: 10}
apps:
  ticker:
    name: Heartbeat service
    description: Isolated connected peer
    type: shell
    group: development
    cwd: ${JSON.stringify(peerDir)}
    start:
      command: 'while true; do echo peer-heartbeat; sleep 0.2; done'
    health: {type: process, interval: 200ms}
    stop: {timeout: 1s}
    links: {Peer: 'http://localhost:43210'}
    ports: [{name: Declared, port: 43210}]
`,
    );
    const peerChild = spawn(
      resolve("../bin/stakl"),
      ["--config", peerConfig, "--no-browser"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(peerChild);
    let peerOutput = "";
    peerChild.stdout.on("data", (b) => (peerOutput += b));
    peerChild.stderr.on("data", (b) => (peerOutput += b));
    let peer: { url: string; token: string } | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        peer = JSON.parse(
          await readFile(join(peerDir, "instance.json"), "utf8"),
        );
        break;
      } catch {
        if (peerChild.exitCode !== null) throw Error(peerOutput);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!peer) {
      peerChild.kill();
      child.kill();
      throw Error("Peer did not start: " + peerOutput);
    }
    instances.push(peer);
    process.env.STAKL_TEST_PEER = JSON.stringify(peer);
    process.env.STAKL_TEST_HUB = JSON.stringify(instance);
    process.env.STAKL_DEV_URL = instance.url;
    process.env.STAKL_DEV_TOKEN = instance.token;
    vite = await createViteServer({
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const frontendURL = vite.resolvedUrls?.local[0];
    if (!frontendURL) throw Error("Vite did not start");
    process.env.STAKL_TEST_INSTANCE = JSON.stringify({
      ...instance,
      url: new URL(frontendURL).origin,
    });
    process.env.STAKL_TEST_CONFIG = path;
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

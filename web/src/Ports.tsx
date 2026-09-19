import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, RefreshCw, Search } from "lucide-react";
import { App, PortScan, request, servicePorts } from "./types";

export function usePortScan(enabled: boolean) {
  const [scan, setScan] = useState<PortScan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      setScan(await request<PortScan>("/system/ports"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setScan(null);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { scan, error, loading, refresh };
}

export function PortsPage({
  apps,
  scan,
  error,
  loading,
  refresh,
}: {
  apps: App[];
} & ReturnType<typeof usePortScan>) {
  const [query, setQuery] = useState("");
  const listeners = scan?.ports || [];
  const rows = listeners.map((p) => ({ ...p, occupied: true }));
  const services = new Map<string, string[]>();
  for (const app of apps) {
    for (const p of servicePorts(app, listeners)) {
      const key = `${p.protocol}:${p.port}`;
      services.set(key, [...(services.get(key) || []), app.config.name]);
      const existing = rows.find(
        (row) => row.port === p.port && row.protocol === p.protocol,
      );
      if (existing) {
        existing.occupied ||= p.occupied;
      } else {
        rows.push({
          port: p.port,
          protocol: p.protocol,
          address: "",
          pid: 0,
          pgid: 0,
          process: p.occupied
            ? app.config.type === "docker-compose"
              ? "Docker published port"
              : "Configured port check"
            : "",
          occupied: p.occupied,
        });
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.port - b.port || a.protocol.localeCompare(b.protocol) || a.pid - b.pid,
  );
  const servicesFor = (port: number, protocol: string) =>
    (services.get(`${protocol}:${port}`) || []).join(", ");
  const filtered = rows.filter((p) =>
    `${p.port} ${p.protocol} ${p.process} ${p.pid} ${p.address} ${servicesFor(p.port, p.protocol)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Ports</h1>
          <p>Check occupied ports before starting another service.</p>
        </div>
        <button className="button" onClick={refresh} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {loading ? "Scanning…" : "Refresh ports"}
        </button>
      </div>
      <p className="muted ports-note">
        TCP listeners and UDP bindings visible to your user, including services
        outside Stakl, plus Docker's published host ports. Configured ports
        remain listed when no listener is detected. An unlisted port is not
        guaranteed to be available.
      </p>
      <label className="search-field ports-search">
        <Search size={16} />
        <input
          aria-label="Search ports"
          placeholder="Find a port, process, or service"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {scan?.warning && (
        <div className="alert" role="status">
          Some ports may be missing: {scan.warning}
        </div>
      )}
      {!scan && !error && <p role="status">Scanning local ports…</p>}
      {scan && (
        <>
          <p className="muted ports-note" role="status">
            {
              new Set(
                rows
                  .filter((p) => p.occupied)
                  .map((p) => `${p.protocol}:${p.port}`),
              ).size
            }{" "}
            occupied ports · Updated{" "}
            {new Date(scan.scanned_at).toLocaleTimeString()} · Refreshes every
            15 seconds
          </p>
          <div
            className="ports-table-wrap"
            role="region"
            aria-label="Port inventory"
            tabIndex={0}
          >
            <table className="ports-table">
              <caption className="sr-only">
                Local port occupancy and configured services
              </caption>
              <thead>
                <tr>
                  <th scope="col">Port</th>
                  <th scope="col">Status</th>
                  <th scope="col">Process</th>
                  <th scope="col">Address</th>
                  <th scope="col">Stakl services</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={`${p.protocol}:${p.port}:${p.pid}:${p.address}`}>
                    <th scope="row">
                      <code>{p.port}</code>
                      <small>{p.protocol}</small>
                    </th>
                    <td>
                      <span
                        className={`status ${p.occupied ? "status-unhealthy" : "status-stopped"}`}
                      >
                        <span className="status-dot" />
                        {p.occupied ? "Occupied" : "Not detected"}
                      </span>
                    </td>
                    <td>
                      {p.process ||
                        (p.occupied
                          ? "Service-reported port"
                          : "No listener detected")}
                      {p.pid > 0 && <small>PID {p.pid}</small>}
                    </td>
                    <td>
                      <code>{p.address || "-"}</code>
                    </td>
                    <td>{servicesFor(p.port, p.protocol) || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="empty">
                <Radio size={28} />
                <h3>{query ? "No matching ports" : "No ports detected"}</h3>
                <p>
                  {query
                    ? "Try a different port number or process name."
                    : "Refresh after starting a service to inspect its ports."}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  App,
  PortScan,
  request,
  servicePorts,
  type ListeningPort,
} from "./types";
import { PageHeader, SearchField } from "./ui";
const numberFormat = new Intl.NumberFormat();

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
      setError(
        `Could not scan local ports: ${(e as Error).message}. Check that the controller is connected, then refresh.`,
      );
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
  onObserve,
}: {
  apps: App[];
  onObserve?: (listener: ListeningPort) => void;
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
  const sections = [
    {
      title: "Stakl-related ports",
      rows: filtered.filter((p) => servicesFor(p.port, p.protocol)),
      associated: true,
      empty: query
        ? "No Stakl ports match this search."
        : "No ports are associated with Stakl applications.",
    },
    {
      title: "Other local ports",
      rows: filtered.filter((p) => !servicesFor(p.port, p.protocol)),
      associated: false,
      empty: query
        ? "No other local ports match this search."
        : "No other local ports detected.",
    },
  ];
  return (
    <>
      <PageHeader
        title="Ports"
        description="Inspect local listeners or add an existing service for observation."
        actions={
          <button className="button" onClick={refresh} disabled={loading}>
            <RefreshCw
              size={15}
              className={loading ? "spin" : ""}
              aria-hidden="true"
            />
            {loading ? "Scanning…" : "Refresh ports"}
          </button>
        }
      />
      <div className="workstation-toolbar ports-toolbar">
        <SearchField
          label="Search ports"
          name="port-search"
          placeholder="Find a port, process, or service"
          value={query}
          onChange={setQuery}
          onClear={() => setQuery("")}
        />
        {scan && (
          <span className="ports-scan-meta">
            {numberFormat.format(
              new Set(
                rows
                  .filter((p) => p.occupied)
                  .map((p) => `${p.protocol}:${p.port}`),
              ).size,
            )}{" "}
            occupied · Updated{" "}
            <time dateTime={scan.scanned_at}>
              {new Date(scan.scanned_at).toLocaleTimeString()}
            </time>
            {" · "}Refreshes every 15 seconds
          </span>
        )}
      </div>
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
      {scan &&
        sections.map((section) => (
          <section className="ports-section" key={section.title}>
            <div className="workstation-section-heading ports-section-heading">
              <h2>{section.title}</h2>
              <span>{numberFormat.format(section.rows.length)}</span>
            </div>
            {section.rows.length ? (
              <div
                className="ports-table-wrap"
                role="region"
                aria-label={section.title}
                tabIndex={0}
              >
                <table
                  className={`ports-table${section.associated ? " ports-table-associated" : ""}`}
                >
                  <caption className="sr-only">
                    {section.title} port inventory
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Port</th>
                      <th scope="col">Status</th>
                      {section.associated && <th scope="col">Application</th>}
                      <th scope="col">Process</th>
                      <th scope="col">Address</th>
                      {!section.associated && onObserve && (
                        <th scope="col">Add to Stakl</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((p) => (
                      <tr key={`${p.protocol}:${p.port}:${p.pid}:${p.address}`}>
                        <th scope="row">
                          <code>{p.port}</code>
                          <small>{p.protocol}</small>
                        </th>
                        <td>
                          <span
                            className={`status ${p.occupied ? "ports-occupied" : "status-stopped"}`}
                          >
                            <span className="status-dot" />
                            {p.occupied ? "Occupied" : "Not detected"}
                          </span>
                        </td>
                        {section.associated && (
                          <td>{servicesFor(p.port, p.protocol)}</td>
                        )}
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
                        {!section.associated && onObserve && (
                          <td>
                            <button
                              className="button small"
                              aria-label={`Observe ${p.protocol} port ${p.port}`}
                              disabled={p.protocol !== "TCP"}
                              title={
                                p.protocol !== "TCP"
                                  ? "UDP needs an explicit check. Use Add app and choose Observation only."
                                  : "Review an observation-only app"
                              }
                              onClick={() => {
                                const { occupied: _, ...listener } = p;
                                onObserve(listener);
                              }}
                            >
                              Observe
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="ports-section-empty">{section.empty}</p>
            )}
          </section>
        ))}
      <p className="muted ports-note">
        Shows TCP and UDP listeners visible to your user, Docker host ports, and
        configured app ports. An unlisted port may still be unavailable.
      </p>
    </>
  );
}

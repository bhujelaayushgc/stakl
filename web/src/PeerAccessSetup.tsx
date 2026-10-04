import { useCallback, useEffect, useRef, useState } from "react";
import { request, type PeerAccessStatus } from "./types";

export function ConnectionDetails({
  status,
  grant = false,
}: {
  status: PeerAccessStatus;
  grant?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [copyError, setCopyError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = async (value: string, label: string) => {
    setMessage("");
    setCopyError("");
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) setMessage(`${label} copied`);
    } catch {
      if (mounted.current)
        setCopyError(
          "Clipboard access is unavailable. Select and copy the text below.",
        );
    }
  };
  return (
    <div className="peer-connection-details">
      <label>
        {grant ? "Grant endpoint" : "Peer endpoint"}
        <input
          readOnly
          value={status.endpoint}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <button
        type="button"
        className="button"
        onClick={() => void copy(status.endpoint, "Endpoint")}
      >
        Copy endpoint
      </button>
      <label>
        {grant ? "Grant public certificate" : "Public certificate"}
        <textarea
          aria-label={grant ? "Grant public certificate" : "Public certificate"}
          readOnly
          rows={5}
          value={status.ca_pem}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <button
        type="button"
        className="button"
        onClick={() => void copy(status.ca_pem, "Certificate")}
      >
        Copy certificate
      </button>
      {message && <p role="status">{message}</p>}
      {copyError && (
        <p className="hosts-error" role="alert">
          {copyError}
        </p>
      )}
    </div>
  );
}

export function PeerAccessSetup({
  onStatus,
  onNotice,
}: {
  onStatus: (status: PeerAccessStatus) => void;
  onNotice: (message: string) => void;
}) {
  const [status, setStatus] = useState<PeerAccessStatus | null>(null);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("49153");
  const [replaceCertificate, setReplaceCertificate] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const active = useRef(false);
  const dirty = useRef(false);
  const reads = useRef<AbortController | null>(null);
  const apply = useCallback(
    (next: PeerAccessStatus) => {
      setStatus(next);
      if (!dirty.current) {
        setAddress(next.address || next.addresses[0] || "");
        setPort(String(next.port || 49153));
      }
      onStatus(next);
    },
    [onStatus],
  );
  const load = useCallback(async () => {
    if (active.current) return;
    reads.current?.abort();
    const controller = new AbortController();
    reads.current = controller;
    try {
      const next = await request<PeerAccessStatus>(
        "/peer-access",
        undefined,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (!Array.isArray(next.addresses))
        throw new Error(
          "Host access setup is unavailable. Check the controller version.",
        );
      apply(next);
      setError("");
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "Could not load host access. Refresh to try again.",
        );
    }
  }, [apply]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      mounted.current = false;
      reads.current?.abort();
      clearInterval(timer);
    };
  }, [load]);
  const change = async (enable: boolean) => {
    if (active.current) return;
    active.current = true;
    reads.current?.abort();
    setPending(true);
    setError("");
    try {
      const next = await request<PeerAccessStatus>(
        enable ? "/peer-access/enable" : "/peer-access/disable",
        enable
          ? {
              address,
              port: Number(port),
              replace_certificate: replaceCertificate,
            }
          : {},
      );
      if (!mounted.current) return;
      dirty.current = false;
      apply(next);
      setReplaceCertificate(false);
      onNotice(
        enable
          ? "Access from other machines enabled"
          : "Peer endpoint disabled",
      );
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "Could not update host access. Refresh and check its state.",
        );
    } finally {
      active.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section
      className="hosts-section peer-access-setup"
      aria-labelledby="peer-access-title"
    >
      <h2 id="peer-access-title">Access from other machines</h2>
      <p>
        Enable a secure endpoint so another Stakl dashboard can connect to this
        machine. Then issue a grant under Local peer access.
      </p>
      {error && (
        <div className="hosts-error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => void load()}
          >
            Refresh access
          </button>
        </div>
      )}
      {!status && !error && <p>Loading host access...</p>}
      {status && (
        <>
          <p className="peer-access-state">
            <strong>
              {status.running
                ? "Enabled"
                : status.enabled
                  ? "Needs attention"
                  : "Disabled"}
            </strong>
            {status.error
              ? "Needs attention"
              : status.running
                ? " - Only scoped peer access is available here."
                : " - Your local dashboard stays available."}
          </p>
          {status.error && (
            <p className="hosts-error" role="alert">
              {status.error}
            </p>
          )}
          {status.primary_network_access && (
            <p className="peer-access-warning">
              This controller also has a separately configured HTTPS endpoint.
              Disabling this peer endpoint leaves that access available. Revoke
              grants to withdraw their permissions everywhere.
            </p>
          )}
          <form
            className="host-grant-form peer-access-form"
            onSubmit={(e) => {
              e.preventDefault();
              void change(true);
            }}
          >
            <label>
              Network address
              <select
                value={address}
                disabled={pending || status.running || !status.addresses.length}
                onChange={(e) => {
                  dirty.current = true;
                  setAddress(e.target.value);
                }}
                required
              >
                {!status.addresses.length && (
                  <option value="">No network address available</option>
                )}
                {address && !status.addresses.includes(address) && (
                  <option value={address}>{address} (unavailable)</option>
                )}
                {status.addresses.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Peer port
              <input
                type="number"
                min={1}
                max={65535}
                required
                value={port}
                disabled={pending || status.running}
                onChange={(e) => {
                  dirty.current = true;
                  setPort(e.target.value);
                }}
              />
            </label>
            {!status.running && (
              <button
                className="button primary"
                disabled={
                  pending || !address || !status.addresses.includes(address)
                }
              >
                {pending ? "Updating..." : "Enable access"}
              </button>
            )}
          </form>
          {status.has_certificate && !status.running && (
            <div className="peer-certificate-replacement">
              <label className="host-checkbox">
                <input
                  type="checkbox"
                  checked={replaceCertificate}
                  disabled={pending}
                  onChange={(e) => setReplaceCertificate(e.target.checked)}
                />
                Replace saved certificate
              </label>
              <p className="host-input-help">
                A replacement requires you to update certificate trust on
                connected dashboards. Leave this unchecked to reuse the saved
                certificate.
              </p>
            </div>
          )}
          {status.running && (
            <>
              <p>
                On the other dashboard, select Hosts &gt; Add host. Use this
                endpoint, a grant token issued below, and this public
                certificate as Trusted CA PEM.
              </p>
              <ConnectionDetails status={status} />
              {status.certificate_expires_at && (
                <p className="host-input-help">
                  Certificate expires{" "}
                  {new Date(status.certificate_expires_at).toLocaleDateString()}
                  . Keep the controller data directory private.
                </p>
              )}
            </>
          )}
          {(status.enabled || status.error) && (
            <button
              type="button"
              className="button danger"
              disabled={pending}
              onClick={() => void change(false)}
            >
              {pending ? "Updating..." : "Disable access"}
            </button>
          )}
          <p className="host-input-help">
            Both machines must be able to reach the selected address and port.
            Use a LAN or VPN address and allow this port through your firewall
            if needed. Disabling access disconnects peers; your services keep
            running.
          </p>
        </>
      )}
    </section>
  );
}

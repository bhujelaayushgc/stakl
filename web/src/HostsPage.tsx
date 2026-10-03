import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  request,
  elapsed,
  type HostDescription,
  type PeerGrant,
} from "./types";
import { hostStateLabel } from "./hosts";
import { PageHeader } from "./ui";

type Editor = {
  id?: string;
  name: string;
  url: string;
  token: string;
  ca_pem: string;
  replaceCA: boolean;
};
type Confirmation = { kind: "remove" | "revoke"; id: string; name: string };
const emptyEditor = (): Editor => ({
  name: "",
  url: "",
  token: "",
  ca_pem: "",
  replaceCA: false,
});
const observed = (value: string) =>
  !value || value.startsWith("0001")
    ? "Not observed yet"
    : `${elapsed(value)} ago`;

export function HostsPage({
  onChanged,
  onNotice,
}: {
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [hosts, setHosts] = useState<HostDescription[]>([]);
  const [grants, setGrants] = useState<PeerGrant[]>([]);
  const [loadError, setLoadError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const [grantName, setGrantName] = useState("");
  const [access, setAccess] = useState<PeerGrant["access"]>("read");
  const [issuedToken, setIssuedToken] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const issueButton = useRef<HTMLButtonElement>(null);
  const reads = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    reads.current?.abort();
    const controller = new AbortController();
    reads.current = controller;
    try {
      const [nextHosts, nextGrants] = await Promise.all([
        request<HostDescription[]>("/hosts", undefined, controller.signal),
        request<PeerGrant[]>("/peer-tokens", undefined, controller.signal),
      ]);
      if (controller.signal.aborted || !mounted.current) return;
      setHosts(nextHosts || []);
      setGrants(nextGrants || []);
      setLoadError("");
    } catch {
      if (!controller.signal.aborted && mounted.current)
        setLoadError(
          "Could not load hosts and grants. Check the controller connection, then refresh.",
        );
    }
  }, []);
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
  const rememberFocus = () => {
    opener.current = document.activeElement as HTMLElement;
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    (opener.current?.isConnected ? opener.current : addButton.current)?.focus();
  };
  const openEditor = (host?: HostDescription) => {
    rememberFocus();
    setFormError("");
    setEditor(
      host
        ? { ...emptyEditor(), id: host.id, name: host.name, url: host.url }
        : emptyEditor(),
    );
  };
  const saveHost = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor || pending) return;
    setPending(true);
    setFormError("");
    const body = editor.id
      ? {
          name: editor.name,
          url: editor.url,
          ...(editor.token ? { token: editor.token } : {}),
          ...(editor.replaceCA ? { ca_pem: editor.ca_pem } : {}),
        }
      : {
          name: editor.name,
          url: editor.url,
          token: editor.token,
          ca_pem: editor.ca_pem,
        };
    try {
      await request(
        editor.id ? `/hosts/${encodeURIComponent(editor.id)}/update` : "/hosts",
        body,
      );
      if (!mounted.current) return;
      setPending(false);
      setEditor(null);
      onChanged();
      onNotice(editor.id ? "Host updated" : "Host connected");
      void load();
    } catch {
      if (mounted.current)
        setFormError(
          "Could not save this connection. Check the endpoint, token, and certificate, then save again.",
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const reconnect = async (host: HostDescription) => {
    if (pending) return;
    setPending(true);
    setActionError("");
    try {
      const next = await request<HostDescription>(
        `/hosts/${encodeURIComponent(host.id)}/reconnect`,
        {},
      );
      if (!mounted.current) return;
      onChanged();
      onNotice(`${host.name}: ${hostStateLabel(next.state)}`);
      await load();
    } catch {
      if (mounted.current) {
        setActionError(
          "Could not reconnect. Check the peer endpoint, grant, and certificate, then reconnect.",
        );
        await load();
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const confirmAction = async () => {
    if (!confirmation || pending) return;
    setPending(true);
    setFormError("");
    const isHost = confirmation.kind === "remove";
    try {
      await request(
        isHost
          ? `/hosts/${encodeURIComponent(confirmation.id)}/remove`
          : `/peer-tokens/${encodeURIComponent(confirmation.id)}/revoke`,
        {},
      );
      if (!mounted.current) return;
      setPending(false);
      opener.current = isHost ? addButton.current : issueButton.current;
      setConfirmation(null);
      if (isHost) onChanged();
      onNotice(isHost ? "Host connection removed" : "Grant revoked");
      void load();
    } catch {
      if (mounted.current)
        setFormError(
          `Could not ${isHost ? "remove the connection" : "revoke the grant"}. Refresh and check the current state before trying again.`,
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const issueGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setActionError("");
    try {
      const grant = await request<PeerGrant & { token: string }>(
        "/peer-tokens",
        { name: grantName, access },
      );
      if (!mounted.current) return;
      setPending(false);
      setIssuedToken(grant.token);
      setGrantName("");
      setAccess("read");
      void load();
    } catch {
      if (mounted.current) {
        setActionError(
          "Could not issue the grant. Refresh the grant list and inspect it before trying again.",
        );
        await load();
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const confirm = (value: Confirmation) => {
    rememberFocus();
    setFormError("");
    setConfirmation(value);
  };
  return (
    <div className="hosts-page">
      <PageHeader
        title="Hosts"
        description="Connect trusted Stakl controllers and manage access to this local controller."
        actions={
          <button
            className="button primary"
            ref={addButton}
            disabled={pending}
            onClick={() => openEditor()}
          >
            Add host
          </button>
        }
      />
      <details className="hosts-help">
        <summary>Help with connected hosts</summary>
        <div className="hosts-help-content">
          <p>
            Each machine runs its own Stakl controller and dashboard. Connect
            another machine here to view its services, health, history, and logs
            alongside your local applications.
          </p>
          <h3>Connect another machine</h3>
          <ol>
            <li>
              Run Stakl on the other machine with an HTTPS endpoint this
              controller can reach. You can also use an SSH tunnel with loopback
              HTTP.
            </li>
            <li>
              On that machine, open <strong>Hosts</strong>, then{" "}
              <strong>Local peer access</strong>. Name the grant, choose Read or
              Control, and select <strong>Issue grant</strong>. Copy the token;
              it is shown only once.
            </li>
            <li>
              Return to this dashboard and select <strong>Add host</strong>.
              Enter the other machine's endpoint and token. For self-signed
              HTTPS, paste its public certificate into{" "}
              <strong>Trusted CA PEM</strong>.
            </li>
          </ol>
          <h3>What does a grant allow?</h3>
          <p>
            A grant gives another dashboard permission to access the machine
            that issued it. <strong>Read</strong> allows viewing service
            details, status, health, history, and logs. <strong>Control</strong>{" "}
            adds per-app start, stop, and restart. Configuration editing and
            workspace actions stay local.
          </p>
          <h3>Let another dashboard connect here</h3>
          <p>
            Issue a grant under <strong>Local peer access</strong> below. Use
            its token in <strong>Add host</strong> on the other dashboard.
            Connections are one-way; to connect both directions, issue a grant
            on each machine and add each connection separately.
          </p>
          <p>
            Keep tokens private. Revoke a grant on the machine that issued it to
            withdraw access. Removing a connection leaves that machine's
            services running.
          </p>
          <a
            href="https://github.com/bhujelaayushgc/stakl/blob/dev/docs/configuration.md#https-and-headless-peers"
            target="_blank"
            rel="noreferrer"
          >
            Full setup guide (opens in a new tab)
          </a>
        </div>
      </details>
      {loadError && (
        <div className="hosts-error" role="alert">
          {loadError}{" "}
          <button className="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      )}
      {actionError && (
        <div className="hosts-error" role="alert">
          {actionError}
        </div>
      )}
      <section className="hosts-section" aria-labelledby="connections-title">
        <h2 id="connections-title">Connections</h2>
        {!hosts.length && !loadError && <p>Loading connections...</p>}
        {hosts.map((host) => (
          <article className="host-row" key={host.id}>
            <div className="host-description">
              <h3>
                {host.name}{" "}
                {host.id === "local" && (
                  <span className="host-local">This controller</span>
                )}
              </h3>
              {host.url && <p className="host-endpoint">{host.url}</p>}
              <div className="host-facts">
                <span className={`host-state host-state-${host.state}`}>
                  {hostStateLabel(host.state)}
                </span>
                {host.stale && <span>Stale</span>}
                <span>
                  {host.access === "control"
                    ? "Control access"
                    : "Read-only access"}
                </span>
                <span>
                  Last seen: <span>{observed(host.last_seen)}</span>
                </span>
              </div>
              {host.error && <p className="host-error">{host.error}</p>}
            </div>
            {host.id !== "local" && (
              <div className="host-actions">
                <button
                  className="button"
                  disabled={pending}
                  aria-label={`Reconnect ${host.name}`}
                  onClick={() => void reconnect(host)}
                >
                  Reconnect
                </button>
                <button
                  className="button"
                  disabled={pending}
                  aria-label={`Edit ${host.name}`}
                  onClick={() => openEditor(host)}
                >
                  Edit
                </button>
                <button
                  className="button danger"
                  disabled={pending}
                  aria-label={`Remove ${host.name}`}
                  onClick={() =>
                    confirm({ kind: "remove", id: host.id, name: host.name })
                  }
                >
                  Remove
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="hosts-section" aria-labelledby="grants-title">
        <h2 id="grants-title">Local peer access</h2>
        <p>
          Grants issued here let other dashboards access this machine. To
          connect to another machine, use a grant issued there. Read includes
          service logs; Control adds per-app start, stop, and restart.
        </p>
        <form className="host-grant-form" onSubmit={issueGrant}>
          <label>
            Grant name
            <input
              required
              value={grantName}
              onChange={(e) => setGrantName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Access
            <select
              value={access}
              onChange={(e) => setAccess(e.target.value as PeerGrant["access"])}
            >
              <option value="read">Read</option>
              <option value="control">Control</option>
            </select>
          </label>
          <button className="button" ref={issueButton} disabled={pending}>
            Issue grant
          </button>
        </form>
        {!grants.length && !loadError && <p>No peer grants issued.</p>}
        {grants.map((grant) => (
          <div className="host-row" key={grant.id}>
            <div>
              <h3>{grant.name}</h3>
              <p>
                {grant.access === "control" ? "Control" : "Read"} access ·
                Created {new Date(grant.created_at).toLocaleString()}
              </p>
            </div>
            <button
              className="button danger"
              disabled={pending}
              aria-label={`Revoke ${grant.name}`}
              onClick={() =>
                confirm({ kind: "revoke", id: grant.id, name: grant.name })
              }
            >
              Revoke
            </button>
          </div>
        ))}
      </section>
      <Dialog.Root
        open={!!editor}
        onOpenChange={(open) => {
          if (!open && !pending) setEditor(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog host-dialog"
            onCloseAutoFocus={restoreFocus}
          >
            <Dialog.Title>{editor?.id ? "Edit host" : "Add host"}</Dialog.Title>
            <Dialog.Description>
              Use an HTTPS endpoint, or loopback HTTP for a local tunnel.
              Credentials are stored by this controller.
            </Dialog.Description>
            {editor && (
              <form onSubmit={saveHost}>
                <label>
                  Host name
                  <input
                    autoFocus
                    required
                    value={editor.name}
                    onChange={(e) =>
                      setEditor({ ...editor, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Endpoint
                  <input
                    type="url"
                    required
                    placeholder="https://host:port"
                    value={editor.url}
                    onChange={(e) =>
                      setEditor({ ...editor, url: e.target.value })
                    }
                    autoComplete="off"
                  />
                </label>
                <label>
                  Peer token
                  <input
                    type="password"
                    required={!editor.id}
                    aria-describedby="peer-token-help"
                    value={editor.token}
                    onChange={(e) =>
                      setEditor({ ...editor, token: e.target.value })
                    }
                    autoComplete="new-password"
                  />
                </label>
                <p className="host-input-help" id="peer-token-help">
                  Use a token issued under Local peer access on the host you are
                  connecting to.
                </p>
                {editor.id && (
                  <>
                    <p className="host-input-help">
                      Leave the token blank to keep the saved credential.
                    </p>
                    <label className="host-checkbox">
                      <input
                        type="checkbox"
                        checked={editor.replaceCA}
                        onChange={(e) =>
                          setEditor({ ...editor, replaceCA: e.target.checked })
                        }
                      />
                      Replace saved certificate trust
                    </label>
                    <p className="host-input-help">
                      Select replacement to change trust. An empty PEM removes
                      custom trust and uses system certificates.
                    </p>
                  </>
                )}
                <label>
                  Trusted CA PEM (optional)
                  <textarea
                    value={editor.ca_pem}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        ca_pem: e.target.value,
                        replaceCA: true,
                      })
                    }
                    autoComplete="off"
                    spellCheck={false}
                    rows={4}
                  />
                </label>
                {formError && (
                  <p className="hosts-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={pending}
                    onClick={() => setEditor(null)}
                  >
                    Cancel
                  </button>
                  <button className="button primary" disabled={pending}>
                    {pending
                      ? "Saving..."
                      : editor.id
                        ? "Save changes"
                        : "Connect host"}
                  </button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog host-dialog"
            onCloseAutoFocus={restoreFocus}
          >
            <Dialog.Title>
              {confirmation?.kind === "remove"
                ? "Remove connection"
                : "Revoke grant"}
            </Dialog.Title>
            <Dialog.Description>
              {confirmation?.kind === "remove"
                ? `Remove ${confirmation.name} from this controller? This does not stop its services or revoke its peer grant.`
                : `Revoke ${confirmation?.name}? Connected peers using this grant will lose access.`}
            </Dialog.Description>
            {formError && (
              <p className="hosts-error" role="alert">
                {formError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={pending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={pending}
                onClick={() => void confirmAction()}
              >
                {confirmation?.kind === "remove"
                  ? "Remove connection"
                  : "Revoke grant"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!issuedToken}
        onOpenChange={(open) => {
          if (!open) setIssuedToken("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog host-dialog"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              issueButton.current?.focus();
            }}
          >
            <Dialog.Title>Peer grant issued</Dialog.Title>
            <Dialog.Description>
              Copy this token now. On the other dashboard, open Hosts, select
              Add host, and use it to connect to this machine. It will not be
              shown again.
            </Dialog.Description>
            <label>
              One-time peer token
              <textarea
                readOnly
                value={issuedToken}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="button primary"
                onClick={() => setIssuedToken("")}
              >
                Dismiss token
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

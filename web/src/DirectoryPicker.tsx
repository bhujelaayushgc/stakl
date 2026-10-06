import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen } from "lucide-react";
import { request } from "./types";
import "./directory-picker.css";

type DirectoryListing = {
  path: string;
  parent: string;
  directories: string[];
  truncated: boolean;
};

export function DirectoryPicker({
  initialPath,
  onSelect,
  disabled = false,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const index = useRef(0);
  const load = useCallback(async (path: string) => {
    const current = ++index.current;
    setBusy(true);
    setError("");
    try {
      const next = await request<DirectoryListing>(
        `/system/directories?path=${encodeURIComponent(path)}`,
      );
      if (current === index.current) setListing(next);
    } catch (e) {
      if (current === index.current) setError((e as Error).message);
    } finally {
      if (current === index.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (open) {
      setListing(null);
      void load(initialPath);
    }
    return () => {
      index.current++;
    };
  }, [open, initialPath, load]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="button" disabled={disabled}>
          <FolderOpen size={15} aria-hidden="true" /> Browse
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="confirm-dialog directory-picker">
          <Dialog.Title>Choose a directory</Dialog.Title>
          <Dialog.Description>
            Browse folders on the machine running this Stakl controller.
          </Dialog.Description>
          <div className="inline-actions">
            <button
              type="button"
              className="button small"
              onClick={() => void load("")}
              aria-label="Home directory"
            >
              Home
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => void load("/")}
              aria-label="Filesystem root"
            >
              Root
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy || !listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
              aria-label="Up one level"
            >
              Up
            </button>
          </div>
          {listing && (
            <code className="directory-picker-path">{listing.path}</code>
          )}
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          {busy && <p role="status">Loading folders...</p>}
          <div
            className="directory-picker-folders"
            aria-label="Folders"
            aria-busy={busy}
          >
            {listing?.directories.map((name) => (
              <button
                type="button"
                className="button"
                key={name}
                disabled={busy}
                aria-label={`Open folder ${name}`}
                onClick={() =>
                  void load(`${listing.path.replace(/\/$/, "")}/${name}`)
                }
              >
                <FolderOpen size={16} aria-hidden="true" />
                <span>{name}</span>
              </button>
            ))}
            {listing && !busy && !listing.directories.length && (
              <p className="muted">No subfolders.</p>
            )}
          </div>
          {listing?.truncated && (
            <p className="muted">
              This large directory is partially listed. You can still enter a
              path directly in Discover Apps.
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="button">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="button primary"
              disabled={busy || !listing}
              onClick={() => {
                if (listing) {
                  onSelect(listing.path);
                  setOpen(false);
                }
              }}
            >
              Select this folder
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

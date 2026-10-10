import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen } from "lucide-react";
import { request } from "./types";
import { SearchField } from "./ui";
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
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const activeFolderRef = useRef<HTMLButtonElement>(null);
  const foldersId = useId();
  const index = useRef(0);
  const load = useCallback(async (path: string) => {
    const current = ++index.current;
    setBusy(true);
    setError("");
    setFilter("");
    setActiveIndex(0);
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
  useEffect(() => {
    if (listing) filterRef.current?.focus();
  }, [listing]);
  useEffect(() => {
    if (!busy) activeFolderRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filter, listing, busy]);
  const path = filter.trim();
  const isPath = path.includes("/") || path === "~" || path === "..";
  const query = path.toLowerCase();
  const directories =
    listing?.directories.filter((name) => name.toLowerCase().includes(query)) ??
    [];
  const changeFilter = (value: string) => {
    setActiveIndex(0);
    if (value === "/" || value === "~/") {
      void load(value === "/" ? "/" : "");
    } else if (value === "../") {
      if (listing?.parent) void load(listing.parent);
      else setFilter("");
    } else {
      setFilter(value);
    }
  };
  const openFolder = (name: string) => {
    if (!busy && listing)
      void load(`${listing.path.replace(/\/$/, "")}/${name}`);
  };
  const selectFolder = () => {
    if (!busy && listing) {
      onSelect(listing.path);
      setOpen(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="button" disabled={disabled}>
          <FolderOpen size={15} aria-hidden="true" /> Browse
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog directory-picker"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              selectFolder();
            } else if (event.altKey && event.key === "ArrowUp") {
              event.preventDefault();
              if (!busy && listing?.parent) void load(listing.parent);
            }
          }}
        >
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
            <code className="directory-picker-path" aria-live="polite">
              {listing.path}
            </code>
          )}
          <SearchField
            ref={filterRef}
            label="Filter folders"
            name="directory-picker-filter"
            placeholder="Filter folders or enter a path..."
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={foldersId}
            aria-describedby={`${foldersId}-shortcuts`}
            aria-activedescendant={
              !busy && directories[activeIndex]
                ? `${foldersId}-${activeIndex}`
                : undefined
            }
            value={filter}
            onChange={changeFilter}
            onClear={() => {
              changeFilter("");
              filterRef.current?.focus();
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                busy ||
                !listing
              )
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((i) =>
                  Math.max(
                    0,
                    Math.min(
                      i + (event.key === "ArrowDown" ? 1 : -1),
                      directories.length - 1,
                    ),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (isPath) {
                  void load(
                    path.startsWith("/") ||
                      path.startsWith("~/") ||
                      path === "~"
                      ? path
                      : `${listing.path.replace(/\/$/, "")}/${path}`,
                  );
                } else if (directories[activeIndex]) {
                  openFolder(directories[activeIndex]);
                }
              }
            }}
          />
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          {busy && <p role="status">Loading folders...</p>}
          <div
            className="directory-picker-folders"
            role="listbox"
            id={foldersId}
            aria-label="Folders"
            aria-busy={busy}
          >
            {listing &&
              directories.map((name, i) => (
                <button
                  ref={i === activeIndex ? activeFolderRef : undefined}
                  type="button"
                  role="option"
                  id={`${foldersId}-${i}`}
                  tabIndex={-1}
                  aria-selected={!busy && i === activeIndex}
                  className="button"
                  key={name}
                  disabled={busy}
                  aria-label={`Open folder ${name}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => openFolder(name)}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  <span>{name}</span>
                </button>
              ))}
            {listing && !busy && !directories.length && (
              <p className="muted" role="status">
                {isPath
                  ? "Press Enter to open this path."
                  : listing.directories.length
                    ? "No matching folders."
                    : "No subfolders."}
              </p>
            )}
          </div>
          <div
            className="directory-picker-shortcuts"
            id={`${foldersId}-shortcuts`}
          >
            <p>
              <kbd>↑</kbd>/<kbd>↓</kbd> choose · <kbd>Enter</kbd> open ·{" "}
              <kbd>Ctrl/Cmd+Enter</kbd> select this folder
            </p>
            <p>
              <kbd>/</kbd> root · <kbd>~/</kbd> home · <kbd>../</kbd> or{" "}
              <kbd>Alt+↑</kbd> up · Paste a path and press Enter
            </p>
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
              onClick={selectFolder}
            >
              Select this folder
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

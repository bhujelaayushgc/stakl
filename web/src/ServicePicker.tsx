import { useEffect, useId, useRef, useState } from "react";

export type ServiceOption = {
  value: string;
  label: string;
  detail: string;
  disabled?: boolean;
};

export function ServicePicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ServiceOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);
  const matches = options.filter((o) =>
    `${o.label} ${o.detail}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const available = matches.filter((o) => !o.disabled);
  const active = available[Math.min(index, available.length - 1)];
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, active?.value]);
  const show = () => {
    if (!open) {
      setQuery("");
      setIndex(0);
      setOpen(true);
    }
  };
  const choose = (option: ServiceOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };
  return (
    <div
      className="app-field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id}>Service</label>
      <div className="workspace-service-picker">
        <input
          id={id}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-results`}
          aria-activedescendant={
            open && active
              ? `${id}-option-${matches.indexOf(active)}`
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder="Search by service name, ID or host..."
          value={open ? query : selected?.label || ""}
          onFocus={show}
          onClick={show}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                show();
                if (event.key === "ArrowUp")
                  setIndex(options.filter((o) => !o.disabled).length - 1);
              } else
                setIndex((i) =>
                  Math.max(
                    0,
                    Math.min(
                      i + (event.key === "ArrowDown" ? 1 : -1),
                      available.length - 1,
                    ),
                  ),
                );
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (active) choose(active);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        />
        {open && (
          <div
            className="workspace-service-results"
            id={`${id}-results`}
            role="listbox"
            aria-label={`${label} suggestions`}
          >
            {matches.map((option, i) => (
              <button
                key={option.value}
                id={`${id}-option-${i}`}
                type="button"
                role="option"
                aria-label={option.label}
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                disabled={option.disabled}
                tabIndex={-1}
                ref={option === active ? activeRef : undefined}
                className={option === active ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!option.disabled) setIndex(available.indexOf(option));
                }}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                <small>
                  {option.detail}
                  {option.disabled ? " - Already added or unavailable" : ""}
                </small>
              </button>
            ))}
            {!matches.length && <p role="status">No matching services</p>}
          </div>
        )}
      </div>
    </div>
  );
}

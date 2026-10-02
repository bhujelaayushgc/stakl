import type { ComponentPropsWithRef, ReactNode } from "react";
import { Layers3, Search, X, type LucideIcon } from "lucide-react";
import { label } from "./types";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading workstation-page-heading">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

export function StatusIndicator({
  status,
  plain = false,
}: {
  status: string;
  plain?: boolean;
}) {
  return (
    <span className={`status status-${status}${plain ? " status-plain" : ""}`}>
      <span className="status-dot" />
      {status === "external" ? "External" : label(status)}
    </span>
  );
}

export function IconButton({
  label: tip,
  children,
  ...props
}: ComponentPropsWithRef<"button"> & { label: string }) {
  return (
    <button className="icon-button" title={tip} aria-label={tip} {...props}>
      {children}
    </button>
  );
}

export function SearchField({
  label: inputLabel,
  name,
  placeholder,
  value,
  onChange,
  onClear,
  iconSize = 16,
}: {
  label: string;
  name: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  iconSize?: number;
}) {
  return (
    <div className={`search-field${onClear ? " has-clear" : ""}`}>
      <label htmlFor={name}>
        <Search size={iconSize} aria-hidden="true" />
      </label>
      <input
        type="search"
        id={name}
        aria-label={inputLabel}
        name={name}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {onClear && value && (
        <button type="button" aria-label="Clear search" onClick={onClear}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Layers3,
  title,
  children,
  plain = false,
  headingLevel = 3,
}: {
  icon?: LucideIcon;
  title: string;
  children: ReactNode;
  plain?: boolean;
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={`empty${plain ? " empty-plain" : ""}`}>
      <Icon size={28} aria-hidden="true" />
      <Heading>{title}</Heading>
      {children}
    </div>
  );
}

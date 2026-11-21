import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import type { ApiError } from "../api/client";
import { STATUS_LABEL, STATUS_TONE, TONE_CLASSES, VERDICT_TONE, type Tone } from "../lib/labels";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ title, subtitle, actions, children, className, bodyClassName, padded = true }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string; padded?: boolean;
}) {
  return (
    <section className={cx("rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800/80">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(padded ? "p-5" : "overflow-x-auto", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[1.75rem] font-medium leading-tight tracking-tight text-zinc-950 dark:text-zinc-50">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = "zinc", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "zinc"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <span className="text-zinc-400">—</span>;
  return <Badge tone={VERDICT_TONE[verdict] ?? "zinc"}>{verdict.replace("_", " ")}</Badge>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300", className)}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-200 dark:text-blue-900 dark:hover:bg-blue-100",
  success: "bg-emerald-600 text-white hover:bg-emerald-700",
  danger: "bg-rose-600 text-white hover:bg-rose-700",
  secondary: "border border-zinc-300 bg-transparent text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800",
  ghost: "text-blue-600 hover:bg-blue-50 dark:text-blue-200 dark:hover:bg-zinc-800",
};

export function Button({ variant = "secondary", size = "md", loading = false, icon, children, className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

const INPUT = "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(INPUT, className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(INPUT, "pr-8", className)}>{children}</select>;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(INPUT, "font-mono text-xs leading-relaxed", className)} />;
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600 dark:text-rose-400">{error}</span> : hint ? <span className="mt-1 block text-xs text-zinc-400">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex select-none items-center gap-2 text-sm", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input type="checkbox" className="size-4 rounded accent-blue-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span className="text-zinc-700 dark:text-zinc-300">{label}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="group" aria-label={label} className="scroll-thin inline-flex max-w-full overflow-x-auto rounded-full bg-zinc-100 p-1 dark:bg-zinc-900 dark:ring-1 dark:ring-zinc-800">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={cx(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            o.value === value ? "bg-white text-blue-600 shadow-sm dark:bg-zinc-800 dark:text-blue-400" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === value}
          type="button"
          onClick={() => onChange(t.key)}
          className={cx(
            "-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            t.key === value ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-zinc-500 hover:border-blue-300 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-zinc-100 px-1.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500" role="status">
      <LoaderCircle className="size-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-zinc-200 dark:bg-zinc-800", className)} />;
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-zinc-300 dark:text-zinc-600">{icon}</div>}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      {children && <div className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
    </div>
  );
}

export function Alert({ tone = "blue", title, children, className }: { tone?: "blue" | "amber" | "rose" | "emerald"; title?: ReactNode; children?: ReactNode; className?: string }) {
  const tones = {
    blue: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800/40 dark:bg-blue-900/20 dark:text-blue-300",
    amber: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300",
    rose: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800/40 dark:bg-rose-900/20 dark:text-rose-300",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300",
  };
  return (
    <div className={cx("flex gap-3 rounded-lg border p-3 text-sm", tones[tone], className)} role={tone === "rose" ? "alert" : undefined}>
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx(title ? "mt-0.5" : null, "break-words")}>{children}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert tone="rose" title={error.status === 403 ? "You don't have access" : "Something went wrong"}>
      <p>{error.message}</p>
      {error.errors.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {error.errors.slice(0, 8).map((e, i) => <li key={i}><span className="font-mono">{e.loc.join(".") || "value"}</span>: {e.msg}</li>)}
        </ul>
      )}
      {onRetry && <Button size="sm" className="mt-2" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>Retry</Button>}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);
}

export function Modal({ open, title, onClose, children, footer, wide = false }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" className={cx("max-h-[90vh] w-full overflow-y-auto rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900", wide ? "max-w-2xl" : "max-w-md")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{title}</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-4" /></button>
        </div>
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  useEscape(open, onClose);
  return (
    <div className={cx("fixed inset-0 z-40 transition-opacity duration-300", open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} aria-hidden={!open}>
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-[1px]" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        className={cx(
          "absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-zinc-200 bg-zinc-50 shadow-2xl transition-transform duration-300 dark:border-zinc-800 dark:bg-zinc-950",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0 flex-1">{title}</div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X className="size-5" /></button>
          </div>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

export function Tooltip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cx("group relative inline-flex", className)}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 rounded-lg bg-zinc-900 px-3 py-2 text-xs leading-snug text-zinc-100 shadow-lg group-focus-within:block group-hover:block dark:bg-zinc-100 dark:text-zinc-900">
        {content}
      </span>
    </span>
  );
}

export function Pagination({ page, pages, onPage, total }: { page: number; pages: number; onPage: (p: number) => void; total?: number }) {
  if (pages <= 1) return total !== undefined ? <p className="px-4 py-3 text-xs text-zinc-500">{total} rows</p> : null;
  const btn = "rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800";
  return (
    <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2.5 text-xs text-zinc-500 dark:border-zinc-800">
      <span>{total !== undefined ? `${total} rows · ` : ""}Page {page} of {pages}</span>
      <div className="flex items-center gap-1">
        <button type="button" aria-label="First page" className={btn} disabled={page <= 1} onClick={() => onPage(1)}><ChevronsLeft className="size-4" /></button>
        <button type="button" aria-label="Previous page" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft className="size-4" /></button>
        <button type="button" aria-label="Next page" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight className="size-4" /></button>
        <button type="button" aria-label="Last page" className={btn} disabled={page >= pages} onClick={() => onPage(pages)}><ChevronsRight className="size-4" /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cx("grid gap-x-6 gap-y-3 text-sm", cols === 1 ? "grid-cols-1" : cols === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{k}</dt>
          <dd className="mt-0.5 break-words text-zinc-900 dark:text-zinc-100">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CodeBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cx("scroll-thin max-h-80 overflow-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300", className)}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export const TH = "sticky top-0 z-10 bg-zinc-50 px-3 py-2.5 text-left text-xs font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400";
export const TD = "px-3 py-2.5 align-top text-sm text-zinc-800 dark:text-zinc-200";
export const TR = "border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40";


// ---------------------------------------------------------------------------
// Console additions
// ---------------------------------------------------------------------------

/** One number with its label; `delta` compares with the period before (positive = more). */
export function Stat({ label, value, hint, delta, tone, glow = false, onClick }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; delta?: number | null; tone?: "rose" | "amber" | "emerald"; glow?: boolean; onClick?: () => void;
}) {
  const toneClass = tone === "rose" ? "text-rose-600 dark:text-rose-300" : tone === "amber" ? "text-amber-600 dark:text-amber-300" : tone === "emerald" ? "text-emerald-600 dark:text-emerald-300" : "text-zinc-950 dark:text-zinc-50";
  const body = (
    <>
      <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={cx("mt-1 text-3xl font-medium tabular-nums tracking-tight", toneClass)}>{value}</p>
      <p className="mt-1 min-h-4 truncate text-xs text-zinc-500 dark:text-zinc-400">
        {delta !== undefined && delta !== null && delta !== 0 && <span className="mr-1 tabular-nums">{delta > 0 ? "+" : ""}{delta}</span>}
        {hint}
      </p>
    </>
  );
  const cls = cx("block w-full rounded-2xl border border-zinc-200 bg-white p-4 text-left dark:border-zinc-800 dark:bg-zinc-900", glow && "glow border-transparent dark:border-transparent");
  return onClick ? <button type="button" onClick={onClick} className={cx(cls, "transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/70")}>{body}</button> : <div className={cls}>{body}</div>;
}

/** A switch (not a checkbox): for settings that turn something on or off. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-blue-600 dark:bg-blue-200" : "bg-zinc-300 dark:bg-zinc-700")}>
      <span className={cx("inline-block size-4 rounded-full transition-transform", checked ? "translate-x-6 bg-white dark:bg-blue-900" : "translate-x-1 bg-white dark:bg-zinc-300")} />
    </button>
  );
}

/** A switched-off feature, said once, with where to turn it on. */
export function OffNotice({ what, flag, children }: { what: string; flag: string; children?: ReactNode }) {
  return (
    <Alert tone="amber" title={`${what} is switched off`} className="mb-4">
      {children} Turn it on in <a className="font-medium underline" href={`/settings/flags`}>Settings, Feature flags</a> ({flag}).
    </Alert>
  );
}

export function Dot({ tone = "zinc", pulse = false }: { tone?: "zinc" | "emerald" | "amber" | "rose" | "blue"; pulse?: boolean }) {
  const c = { zinc: "bg-zinc-400", emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500", blue: "bg-blue-400" }[tone];
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", c, pulse && "animate-pulse")} aria-hidden />;
}

/** Confidence as a short bar with the number. */
export function Confidence({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-zinc-400">n/a</span>;
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`Confidence ${pct}%`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"><span className="bg-spark block h-full" style={{ width: `${pct}%` }} /></span>
      <span className="text-xs text-zinc-600 dark:text-zinc-300">{pct}%</span>
    </span>
  );
}

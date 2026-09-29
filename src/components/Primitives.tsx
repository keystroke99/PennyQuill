import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Inbox, X } from "lucide-react";
import { NamedIcon } from "../icons";
import type { Household, Transaction } from "../types";
import { formatDate, formatMoney } from "../utils";

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button className={`button button--${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const previousPosition = document.body.style.position;
    const previousTop = document.body.style.top;
    const previousWidth = document.body.style.width;
    const scrollY = window.scrollY;
    const useFixedBodyLock = window.matchMedia("(max-width: 820px)").matches;
    const siblingStates = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({
        element,
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.inert,
      }));
    siblingStates.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    document.body.style.overflow = "hidden";
    if (useFixedBodyLock) {
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = "100%";
    }

    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");

    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>("[autofocus]");
      (preferred ?? focusableElements()[0] ?? dialog).focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.position = previousPosition;
      document.body.style.top = previousTop;
      document.body.style.width = previousWidth;
      if (useFixedBodyLock) window.scrollTo(0, scrollY);
      siblingStates.forEach(({ element, ariaHidden, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      previousFocus?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={backdropRef} className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={`sheet ${wide ? "sheet--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="sheet__header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={22} />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => <span className="skeleton" key={index} />)}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Inbox size={24} /></span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function CategoryGlyph({
  icon,
  color = "#66756c",
  size = "md",
}: {
  icon?: string | null;
  color?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className={`category-glyph category-glyph--${size}`} style={{ "--glyph-color": color ?? "#66756c" } as React.CSSProperties}>
      <NamedIcon name={icon ?? undefined} size={size === "lg" ? 25 : size === "sm" ? 16 : 20} />
    </span>
  );
}

export function TransactionRow({
  transaction,
  household,
  onClick,
}: {
  transaction: Transaction;
  household: Household;
  onClick?: () => void;
}) {
  const isPositive = transaction.direction === "income" || transaction.direction === "refund";
  const label = transaction.merchant || transaction.categoryName || ({
    income: "Income",
    expense: "Expense",
    transfer: "Transfer",
    refund: "Refund",
    adjustment: "Adjustment",
  }[transaction.direction]);
  const content = (
    <>
      <CategoryGlyph icon={transaction.categoryIcon} color={transaction.categoryColor} />
      <span className="transaction-row__main">
        <strong>{label}</strong>
        <small>
          {transaction.categoryName || transaction.direction} · {formatDate(transaction.occurredOn, "short")}
          {transaction.memberName ? ` · ${transaction.memberName}` : ""}
        </small>
      </span>
      <span className={`transaction-row__amount ${isPositive ? "is-positive" : transaction.direction === "transfer" ? "is-neutral" : ""}`}>
        {isPositive ? "+" : transaction.direction === "expense" ? "−" : ""}{formatMoney(transaction.amountMinor, household)}
        <small>{transaction.status}</small>
      </span>
      {onClick && <ChevronRight size={17} className="transaction-row__chevron" aria-hidden="true" />}
    </>
  );
  if (onClick) return <button className="transaction-row" type="button" onClick={onClick}>{content}</button>;
  return <div className="transaction-row">{content}</div>;
}

export function InlineError({ message }: { message: string }) {
  return <div className="inline-error" role="alert">{message}</div>;
}

export function Donut({
  value,
  label,
  color = "#d9f26a",
}: {
  value: number;
  label: string;
  color?: string;
}) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div className="donut" style={{ "--value": `${safe * 3.6}deg`, "--donut-color": color } as React.CSSProperties}>
      <div><strong>{Math.round(value)}%</strong><small>{label}</small></div>
    </div>
  );
}

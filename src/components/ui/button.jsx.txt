import React from "react";

export function Button({
  className = "",
  variant = "default",
  disabled = false,
  children,
  ...props
}) {
  const base =
    "inline-flex items-center justify-center rounded-md text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  const styles =
    variant === "secondary"
      ? "bg-slate-100 text-slate-900 hover:bg-slate-200"
      : "bg-slate-900 text-white hover:bg-slate-800";

  return (
    <button
      className={`${base} ${styles} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
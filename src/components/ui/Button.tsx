import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[#C10007] text-white hover:bg-[#a00006] focus-visible:ring-2 focus-visible:ring-[#C10007]/30 active:scale-[0.98]",
  secondary:
    "border border-[#C10007] text-[#C10007] hover:bg-[#FEF2F2] active:scale-[0.98]",
  ghost:
    "text-gray-700 hover:bg-gray-100 hover:text-[#C10007]",
  danger:
    "bg-[#C10007] text-white hover:bg-[#a00006] active:scale-[0.98]",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs rounded-md",
  md: "px-5 py-2.5 text-sm rounded-lg",
  lg: "px-7 py-3.5 text-base rounded-xl",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      className = "",
      disabled,
      children,
      ...rest
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={[
          "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 cursor-pointer select-none",
          variantClasses[variant],
          sizeClasses[size],
          fullWidth ? "w-full" : "",
          disabled || loading ? "opacity-50 cursor-not-allowed" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {loading && (
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
export default Button;

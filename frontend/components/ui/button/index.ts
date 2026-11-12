import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-[14px] font-medium leading-[1.25] transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-muted)] disabled:opacity-100 disabled:shadow-[inset_0_0_0_1px_var(--border)]",
        destructive:
          "border border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/20",
        outline:
          "border border-border bg-transparent text-[var(--text-secondary)] hover:border-[var(--border-light)] hover:bg-accent hover:text-[var(--text-primary)]",
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:border-[var(--border-light)] hover:bg-accent",
        ghost:
          "border border-transparent text-[var(--text-secondary)] hover:bg-accent hover:text-[var(--text-primary)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        "default": "px-5 py-[10px]",
        "xs": "px-2 py-1 text-[12px]",
        "sm": "px-3 py-[6px] text-[13px]",
        "lg": "px-7 py-[14px] text-[16px]",
        "icon": "h-[34px] w-[34px]",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>

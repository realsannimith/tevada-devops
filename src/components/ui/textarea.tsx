import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-card px-3 py-2 text-xs text-foreground transition-colors outline-none placeholder:text-muted-foreground/72 focus-visible:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive/50 dark:bg-input/32 dark:disabled:bg-input/80",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

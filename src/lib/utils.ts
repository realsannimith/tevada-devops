import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Compact count for stats like token totals: 950 → "950", 201144 → "201K",
 *  1500000 → "1.5M", 3200000000 → "3.2B". One decimal below 100 per unit. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (Math.abs(n) < 1000) return Math.round(n).toString()
  const units = ["K", "M", "B", "T"]
  let v = n
  let i = -1
  do {
    v /= 1000
    i++
  } while (Math.abs(v) >= 999.95 && i < units.length - 1)
  const s = Math.abs(v) >= 99.95 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "")
  return s + units[i]
}

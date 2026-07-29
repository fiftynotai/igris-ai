/**
 * PORT OF `fifty_dev/src/lib/utils.ts#cn`.
 *
 * DIVERGENCE: upstream wraps `clsx`. Here it is hand-rolled over the exact
 * subset the seven ported components use — string / false / null / undefined —
 * so the dashboard bundle carries zero third-party runtime code for a
 * five-line join. The signature and the call sites are unchanged, so a future
 * swap back to clsx is a one-file edit. Recorded in PORTING.md.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter((v): v is string => typeof v === "string" && v.length > 0).join(" ");
}

import { cn } from "@/lib/utils";

// BIS "Rising-I" brand mark.
//
// This component renders the official PNG asset directly.
// Save the source file at: public/rising-i.png (760 × 880)
export function RisingI({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/rising-i.png"
      alt=""
      width={760}
      height={880}
      className={cn("block h-full w-auto max-w-full object-contain", className)}
    />
  );
}

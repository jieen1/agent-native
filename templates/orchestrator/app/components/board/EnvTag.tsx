import { cn } from "@/lib/utils";
import { envColor } from "@/lib/status-colors";

// Environment tag (FRONTEND §2 — SIT/UAT/prod/dev from the work item's
// `environment` field). The env name is a code, shown verbatim; tinted by the
// single color source (prod is loud-red, lower envs are calm).
export interface EnvTagProps {
  env: string;
  className?: string;
}

export function EnvTag({ env, className }: EnvTagProps) {
  const color = envColor(env);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        color.badge,
        className,
      )}
    >
      {env}
    </span>
  );
}

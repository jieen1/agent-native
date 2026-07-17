import { StatusIcon, type StatusIconSize } from "./StatusIcon";
import { StatusRing } from "./StatusRing";
import { statusVocabPresentation } from "./v3-format";

export interface StatusMarkerProps {
  status: string;
  /** StatusIcon size when the status renders as a terminal icon. */
  size?: StatusIconSize;
  /** StatusRing diameter (px) when the status renders as an in-progress ring. */
  ringSize?: number;
  className?: string;
}

/**
 * Renders a V3 run/node status as the Foundry geometric status vocabulary —
 * StatusRing for in-progress states, StatusIcon for terminal states — instead
 * of a plain solid dot. See `statusVocabPresentation` for the status mapping.
 */
export function StatusMarker({
  status,
  size,
  ringSize,
  className,
}: StatusMarkerProps) {
  const presentation = statusVocabPresentation(status);
  if (presentation.el === "ring") {
    return (
      <StatusRing
        status={presentation.status}
        size={ringSize}
        className={className}
      />
    );
  }
  return (
    <StatusIcon tone={presentation.tone} size={size} className={className} />
  );
}

/**
 * LOCAL CUSTOMIZATION — not from upstream agent-native.
 *
 * Small top-right toolbar button that toggles a wider reading/editing width
 * for document pages. The stock editor hard-caps content at `max-w-3xl`
 * (768px), which leaves large empty margins on wide monitors.
 *
 * How it works (kept deliberately non-invasive for upstream merges):
 *  - This component only flips `data-page-wide` on <html> and persists the
 *    choice in localStorage (`content-page-width`).
 *  - The actual widening lives in one clearly-marked override block at the
 *    bottom of `app/global.css`, which retargets the existing
 *    `.w-full.max-w-3xl.mx-auto` containers when the attribute is present.
 *  - Mounted from `DocumentToolbar.tsx` (one import + one JSX line).
 *
 * See `templates/content/LOCAL_CHANGES.md` for the full list of local deltas.
 */
import { useEffect } from "react";
import { IconViewportNarrow, IconViewportWide } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocalStorage } from "@/hooks/use-local-storage";

const STORAGE_KEY = "content-page-width";

export function PageWidthToggle() {
  const [width, setWidth] = useLocalStorage<"default" | "wide">(
    STORAGE_KEY,
    "default",
  );
  const isWide = width === "wide";

  useEffect(() => {
    const root = window.document.documentElement;
    if (isWide) {
      root.setAttribute("data-page-wide", "true");
    } else {
      root.removeAttribute("data-page-wide");
    }
  }, [isWide]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent"
          aria-label={isWide ? "Standard page width" : "Wide page width"}
          aria-pressed={isWide}
          onClick={() => setWidth(isWide ? "default" : "wide")}
        >
          {isWide ? (
            <IconViewportNarrow size={16} />
          ) : (
            <IconViewportWide size={16} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {isWide ? "Standard page width" : "Wide page width"}
      </TooltipContent>
    </Tooltip>
  );
}

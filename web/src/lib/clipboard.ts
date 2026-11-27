/**
 * Copy text to clipboard reliably on both HTTPS (Clipboard API) and plain HTTP IP:port
 * deployments (execCommand fallback, dialog-focus-trap safe).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand fallback
    }
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";

    // Append inside active Radix Dialog if open so focus-trap allows selecting the textarea
    const activeDialog = document.activeElement?.closest('[role="dialog"]');
    const mountParent = activeDialog ?? document.body;
    mountParent.appendChild(ta);

    const prevFocus = document.activeElement as HTMLElement | null;
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    mountParent.removeChild(ta);
    prevFocus?.focus?.({ preventScroll: true });
    return ok;
  } catch {
    return false;
  }
}

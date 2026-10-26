// DSB Pro mark (owner pick, option 2): a shop awning over the "DSB Pro" wordmark. The awning is drawn
// here in currentColor so the header (green bar) and any light/dark surface can use it; the app icons use
// the compact version in public/favicon.svg (awning + "DSB"), rasterised by scripts/gen-icons.mjs.
export function Awning({ class: className = 'brand-awning' }: { class?: string }) {
  return (
    <svg class={className} viewBox="0 0 152 22" aria-hidden="true" focusable="false">
      <path d="M6 0h140l5 12H1z" fill="currentColor" />
      <path
        d="M1 12a9.5 9.5 0 0 0 19 0zM20 12a9.5 9.5 0 0 0 19 0zM39 12a9.5 9.5 0 0 0 19 0zM58 12a9.5 9.5 0 0 0 19 0zM77 12a9.5 9.5 0 0 0 19 0zM96 12a9.5 9.5 0 0 0 19 0zM115 12a9.5 9.5 0 0 0 19 0zM134 12a9 9 0 0 0 17 0z"
        fill="currentColor"
      />
    </svg>
  );
}

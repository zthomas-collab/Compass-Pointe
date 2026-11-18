"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * The phone Menu: a native <details> (so it opens without JavaScript) that closes itself after navigating, on Escape,
 * and when tapping outside it. The layout is kept across navigations, so without this it would stay open on the next page.
 */
export function MobileMenu({ summaryClassName, panelClassName, children }: {
  summaryClassName: string; panelClassName: string; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) {
        el.open = false;
        if (e instanceof KeyboardEvent) el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("click", close);
    };
  }, []);

  return (
    <details ref={ref} className="relative md:hidden">
      <summary className={summaryClassName}>
        <span aria-hidden="true">☰</span> Menu
      </summary>
      <div className={panelClassName}>{children}</div>
    </details>
  );
}

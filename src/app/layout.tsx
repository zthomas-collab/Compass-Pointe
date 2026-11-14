import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";
import { brandCss, getBrand } from "@/config/brand";
import { getCurrentUser, isPrivileged } from "@/server/session";
import { privilegedMfaRequired } from "@/server/modules/organizations";
import { signOutAction } from "./auth/actions";
import { BrandLogo, BrandMark } from "@/components/brand";

const serif = Cormorant_Garamond({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-serif-face", display: "swap" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans-face", display: "swap" });

const brand = getBrand();

export const metadata: Metadata = {
  title: { default: `${brand.name} — ${brand.tagline}`, template: `%s · ${brand.name}` },
  description: `${brand.name} shows where disaster-recovery help is available near you, who provides it, and when it was last confirmed.`,
  manifest: "/manifest.webmanifest",
  applicationName: brand.name,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: brand.colors.primary };

const navLink = "whitespace-nowrap rounded-md px-2 py-2 text-[0.92rem] font-semibold text-white underline-offset-8 decoration-gold decoration-2 hover:bg-white/10 hover:underline focus-visible:underline";
const authLink = "whitespace-nowrap rounded-md border border-white/70 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/15";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const needsMfa = Boolean(user && isPrivileged(user) && !user.mfaEnrolled && privilegedMfaRequired());
  const isAdmin = user?.platformRoles.includes("PLATFORM_ADMIN") || user?.countyAdmin;
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <head>
        {/* Theme variables come from validated config only (see src/config/brand.ts). */}
        <style id="brand-theme" dangerouslySetInnerHTML={{ __html: brandCss(brand) }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-2">
          Skip to content
        </a>
        <aside aria-label="Emergency information" className="bg-bad-bg px-4 py-1.5 text-center text-sm text-bad">
          <strong>Life-threatening emergency? Call 911.</strong> {brand.name} coordinates resources; it does not dispatch help.
        </aside>
        {needsMfa && (
          <aside aria-label="Security notice" className="bg-warn-bg px-4 py-1.5 text-center text-sm text-warn">
            <strong>Action needed:</strong> your role requires multi-factor authentication.{" "}
            <Link className="underline" href="/account/security?required=1">Set it up now</Link>
          </aside>
        )}
        <header className="border-b-4 border-gold bg-brand text-white">
          <nav aria-label="Main" className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 min-[1340px]:flex-nowrap min-[1340px]:px-6">
            <div className="shrink-0">
              {brand.logoPath ? (
                <Link href="/" className="block rounded-md bg-white px-4 py-2 shadow-sm sm:px-5 sm:py-3" aria-label={`${brand.name} home`}>
                  <BrandLogo src={brand.logoPath} size={brand.logoSize} name={brand.name} tagline={brand.tagline} className="h-14 sm:h-[5.25rem]" />
                </Link>
              ) : (
                <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight text-white" aria-label={`${brand.name} home`}>
                  <BrandMark />
                  <span>{brand.name}</span>
                </Link>
              )}
            </div>
            {/* Sign-in cluster sits beside the logo on small screens (order-2) and at the far right on wide ones. */}
            <div className="order-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:ml-auto min-[1340px]:order-3 min-[1340px]:ml-0 min-[1340px]:shrink-0 min-[1340px]:flex-nowrap">
              {user ? (
                <>
                  <Link href="/dashboard" className={authLink}>Dashboard</Link>
                  {isAdmin && <Link href="/admin" className={authLink}>Admin</Link>}
                  <form action={signOutAction}>
                    <button className={authLink}>Sign out</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/signin?tab=register" className="btn btn-attention min-h-10 whitespace-nowrap px-3 py-1.5 text-sm font-bold">
                    Register Your Organization
                  </Link>
                  <Link href="/signin" className={authLink}>Sign in</Link>
                </>
              )}
            </div>
            {/* Page links share the space between the logo and the sign-in cluster evenly; on small screens they take their own row. */}
            <div className="order-3 flex w-full min-w-0 flex-wrap items-center justify-evenly gap-x-1 gap-y-1 border-t border-white/15 pt-2 min-[1340px]:order-2 min-[1340px]:w-auto min-[1340px]:flex-1 min-[1340px]:border-0 min-[1340px]:pt-0">
              <Link href="/" className={navLink}>Map</Link>
              <Link href="/contacts" className={navLink}>Contacts</Link>
              <Link href="/assistance" className={navLink}>Request help</Link>
              <Link href="/volunteer" className={navLink}>Volunteer &amp; donate</Link>
              <Link href="/projects" className={navLink}>Projects</Link>
              <Link href="/events" className={navLink}>Events</Link>
              <Link href="/safety" className={navLink}>Safety</Link>
            </div>
          </nav>
        </header>
        <main id="main" className="flex flex-1 flex-col">{children}</main>
        <footer className="border-t border-line bg-surface px-4 py-3 text-center text-xs text-muted">
          <strong className="text-ink">{brand.name}</strong> is operated by {brand.operator}. Information is provided by
          participating organizations — always check timestamps. Road and resource reports are not official government
          notices. <Link className="text-brand underline" href="/safety">Safety &amp; corrections</Link>
        </footer>
      </body>
    </html>
  );
}

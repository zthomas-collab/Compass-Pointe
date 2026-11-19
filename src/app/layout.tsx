import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";
import { brandCss, getBrand } from "@/config/brand";
import { getCurrentUser, isPrivileged } from "@/server/session";
import { privilegedMfaRequired } from "@/server/modules/organizations";
import { signOutAction } from "./auth/actions";
import { BrandLogo, BrandMark } from "@/components/brand";
import { MobileMenu } from "@/components/mobile-menu";

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

const navLink = "rounded-md px-2 py-2 text-sm font-semibold text-white hover:bg-white/10";

/** Where to find and give help, shared by the desktop bar and the phone Menu. Help comes first, then giving. */
function SiteLinks({ className }: { className: string }) {
  return (
    <>
      <Link href="/" className={className}>Find help</Link>
      <Link href="/assistance" className={className}>Request help</Link>
      <Link href="/volunteer" className={className}>Volunteer &amp; donate</Link>
      <Link href="/events" className={className}>Events</Link>
      <Link href="/contacts" className={className}>Organizations</Link>
      <Link href="/safety" className={className}>Safety</Link>
    </>
  );
}

/** Account links: sign in and register when signed out; dashboard, security, admin and sign out when signed in. */
function AccountLinks({ user, isAdmin, className }: { user: boolean; isAdmin: boolean; className: string }) {
  return user ? (
    <>
      <Link href="/dashboard" className={className}>Dashboard</Link>
      <Link href="/account/security" className={className}>Security</Link>
      {isAdmin && <Link href="/admin" className={className}>Admin</Link>}
      <form action={signOutAction}>
        <button className={`${className} w-full text-left underline`}>Sign out</button>
      </form>
    </>
  ) : (
    <>
      <Link href="/signin" className={className}>Sign in</Link>
      <Link href="/signin?tab=register" className="btn btn-attention min-h-10 px-3 py-1.5 text-sm">
        Register Your Organization
      </Link>
    </>
  );
}

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
          {/* Full width, with the same side padding as the map search below, so the header spans edge to edge on wide screens. */}
          <nav aria-label="Main" className="flex w-full flex-wrap items-center gap-x-1 gap-y-1 px-3 py-2">
            <div className="mr-auto py-1 xl:mr-0">
              {brand.logoPath ? (
                <Link href="/" className="block rounded-md bg-white px-3 py-1.5 shadow-sm" aria-label={`${brand.name} home`}>
                  <BrandLogo src={brand.logoPath} size={brand.logoSize} name={brand.name} tagline={brand.tagline} className="h-12 lg:h-14" />
                </Link>
              ) : (
                <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight text-white" aria-label={`${brand.name} home`}>
                  <BrandMark />
                  <span>{brand.name}</span>
                </Link>
              )}
            </div>
            {/* Wide screens: site links spread through the middle, account actions on the right. */}
            <div className="hidden flex-1 items-center justify-center gap-x-4 px-4 xl:flex 2xl:gap-x-6">
              <SiteLinks className={navLink} />
            </div>
            <div className="hidden items-center gap-x-2 xl:flex">
              <AccountLinks user={Boolean(user)} isAdmin={Boolean(isAdmin)} className={navLink} />
            </div>
            {/* Phones and tablets: one compact Menu button so the search and "Find Help Near Me" stay near the top. Works without JavaScript. */}
            <MobileMenu
              summaryClassName={`${navLink} flex min-h-11 cursor-pointer list-none items-center gap-2 border border-white/40 px-3 [&::-webkit-details-marker]:hidden`}
              panelClassName="absolute right-0 z-50 mt-2 grid w-64 gap-1 rounded-lg border border-line bg-brand p-2 shadow-lg"
            >
              <SiteLinks className={`${navLink} block min-h-11 py-2.5 text-base`} />
              <AccountLinks user={Boolean(user)} isAdmin={Boolean(isAdmin)} className={`${navLink} block min-h-11 py-2.5 text-base`} />
            </MobileMenu>
          </nav>
        </header>
        <main id="main" className="flex flex-1 flex-col">{children}</main>
        <footer className="border-t border-line bg-surface px-4 py-3 text-center text-xs text-muted">
          <strong className="text-ink">{brand.name}</strong> is a nonprofit. Information is provided by
          participating organizations — always check timestamps. Road and resource reports are not official government
          notices. <Link className="text-brand underline" href="/safety">Safety &amp; corrections</Link>
        </footer>
      </body>
    </html>
  );
}

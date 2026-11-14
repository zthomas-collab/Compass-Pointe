// YouTube link handling for the learning library. Pure functions, safe on server and client.
// Only YouTube is accepted. We keep the 11-character video id and nothing else from a pasted link, so no pasted URL,
// query string, fragment or markup is ever stored or rendered; the embed URL is rebuilt from the id.

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

/** Returns the video id for a YouTube watch, share, embed, shorts or live link; null for anything else. */
export function parseYouTubeId(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 300) return null;
  if (ID.test(value)) return null; // a bare id is not a link; ask for the address from the browser bar
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  let id: string | null = null;
  if (host.endsWith("youtu.be")) {
    id = u.pathname.split("/")[1] ?? null;
  } else if (u.pathname === "/watch") {
    id = u.searchParams.get("v");
  } else {
    const m = /^\/(embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
    id = m ? m[2] : null;
  }
  return id && ID.test(id) ? id : null;
}

/** Privacy-enhanced embed address. Only ever built from a validated id. */
export function youTubeEmbedUrl(id: string): string {
  if (!ID.test(id)) throw new Error("invalid YouTube id");
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
}

export function youTubeWatchUrl(id: string): string {
  if (!ID.test(id)) throw new Error("invalid YouTube id");
  return `https://www.youtube.com/watch?v=${id}`;
}

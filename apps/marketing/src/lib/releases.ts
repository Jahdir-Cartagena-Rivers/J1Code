import { J1_RELEASES_URL, J1_REPOSITORY_URL } from "@j1code/shared/j1Brand";

const REPO = new URL(J1_REPOSITORY_URL).pathname.slice(1);

export const RELEASES_URL = J1_RELEASES_URL;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// GitHub's latest endpoint excludes prereleases; the newest nightly comes from the ordered release list.
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

function cacheKey(channel: ReleaseChannel) {
  return `j1code-${channel}-release`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load J1 Code releases (${response.status})`);
  return response.json();
}

async function fetchStable(): Promise<Release> {
  return fetchJson<Release>(LATEST_API_URL);
}

async function fetchNightly(): Promise<Release> {
  const list = await fetchJson<Release[]>(LIST_API_URL);
  const nightly = Array.isArray(list)
    ? list.find((release) => release.tag_name?.includes("-nightly."))
    : undefined;
  if (!nightly) throw new Error("No nightly release in the latest page");
  return nightly;
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = cacheKey(channel);
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const data = channel === "nightly" ? await fetchNightly() : await fetchStable();

  if (data?.assets) {
    sessionStorage.setItem(key, JSON.stringify(data));
  }

  return data;
}

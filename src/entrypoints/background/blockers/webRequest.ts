/**
 * WebRequest-based blocker for Firefox MV2
 *
 * Uses webRequest.onBeforeRequest with blocking to intercept and redirect
 * blocked URLs to the extension's blocked page.
 *
 * Note: MV2 doesn't have storage.session, so we use in-memory storage
 * for unlock state (resets on browser restart).
 */

import {
  getBlockedSites,
  urlMatchesSiteRules,
  type BlockedSite,
} from "@/lib/storage";
import { ALARM_PREFIX } from "@/lib/consts";
import { isInternalUrl } from "../utils";

interface UnlockState {
  siteId: string;
  expiresAt: number;
}

// In-memory cache for faster lookups (webRequest needs to be synchronous)
let cachedSites: BlockedSite[] = [];

// In-memory unlock state (MV2 doesn't have storage.session)
const unlockedSites = new Map<string, UnlockState>();

/**
 * Refresh the cached sites list
 */
export async function refreshCache(): Promise<void> {
  cachedSites = await getBlockedSites();
}

/**
 * Check if a URL should be blocked (synchronous, uses cache)
 */
function shouldBlockUrl(url: string): {
  blocked: boolean;
  site: BlockedSite | null;
} {
  for (const site of cachedSites) {
    if (!site.enabled) {
      continue;
    }

    const unlockState = unlockedSites.get(site.id);
    if (unlockState && unlockState.expiresAt > Date.now()) {
      continue;
    }

    const matches = urlMatchesSiteRules(url, site);

    if (matches) {
      return { blocked: true, site };
    }
  }
  return { blocked: false, site: null };
}

/**
 * WebRequest listener callback
 *
 * Firefox security doesn't allow redirecting to moz-extension:// URLs via webRequest.
 * Instead, we cancel the request and use tabs.update() to navigate to the blocked page.
 */
function onBeforeRequestListener(details: {
  url: string;
  type: string;
  tabId: number;
}): { cancel: boolean } | undefined {
  // Only block main_frame requests
  if (details.type !== "main_frame") {
    return undefined;
  }

  const url = details.url;
  const tabId = details.tabId;

  // Skip extension pages and internal URLs
  if (isInternalUrl(url)) {
    return undefined;
  }

  const { blocked, site } = shouldBlockUrl(url);

  if (!blocked || !site) {
    return undefined;
  }

  // Cancel the request and redirect via tabs.update() (async, but that's ok)
  const blockedPageUrl = browser.runtime.getURL(
    `/blocked.html?url=${encodeURIComponent(url)}&siteId=${encodeURIComponent(site.id)}`
  );

  // Use tabs.update asynchronously - the request is already cancelled
  if (tabId && tabId !== -1) {
    browser.tabs.update(tabId, { url: blockedPageUrl }).catch((err) => {
      console.error(`[distacted] Failed to redirect tab ${tabId}:`, err);
    });
  }

  // Cancel the original request
  return { cancel: true };
}

/**
 * Initialize the webRequest blocker
 */
export async function initializeWebRequest(): Promise<void> {
  await refreshCache();

  if (!browser.webRequest?.onBeforeRequest) {
    return;
  }

  browser.webRequest.onBeforeRequest.addListener(
    onBeforeRequestListener,
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["blocking"]
  );
}

/**
 * Grant temporary access to a site
 */
export async function grantAccess(
  siteId: string,
  durationMinutes: number | null
): Promise<{ expiresAt: number }> {
  const durationMs = (durationMinutes ?? 60) * 60 * 1000;
  const expiresAt = Date.now() + durationMs;

  // Store unlock state in memory
  unlockedSites.set(siteId, { siteId, expiresAt });

  await browser.alarms.create(`${ALARM_PREFIX}${siteId}`, {
    when: expiresAt,
  });

  return { expiresAt };
}

/**
 * Revoke access to a site
 */
export async function revokeAccess(siteId: string): Promise<number[]> {
  // Remove unlock state
  unlockedSites.delete(siteId);

  // Clear alarm
  await browser.alarms.clear(`${ALARM_PREFIX}${siteId}`);

  const tabsToRedirect = await findTabsOnBlockedSite(siteId);

  return tabsToRedirect;
}

/**
 * Find all tabs currently on a blocked site
 */
export async function findTabsOnBlockedSite(siteId: string): Promise<number[]> {
  const site = cachedSites.find((s) => s.id === siteId);
  if (!site) return [];

  const tabs = await browser.tabs.query({});
  const matchingTabIds: number[] = [];

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    // Skip extension pages and internal URLs
    if (isInternalUrl(tab.url)) continue;

    if (urlMatchesSiteRules(tab.url, site)) {
      matchingTabIds.push(tab.id);
    }
  }

  return matchingTabIds;
}

/**
 * Check if a site is currently unlocked
 */
export async function isSiteUnlocked(siteId: string): Promise<boolean> {
  const state = unlockedSites.get(siteId);
  if (!state) return false;

  if (state.expiresAt <= Date.now()) {
    unlockedSites.delete(siteId);
    return false;
  }

  return true;
}

/**
 * Get unlock state for a site
 */
export async function getUnlockState(
  siteId: string
): Promise<UnlockState | null> {
  const state = unlockedSites.get(siteId);
  if (!state) return null;

  if (state.expiresAt <= Date.now()) {
    unlockedSites.delete(siteId);
    return null;
  }

  return state;
}

/**
 * Handle relock alarm
 */
export async function handleRelockAlarm(alarmName: string): Promise<{
  siteId: string;
  tabsToRedirect: number[];
} | null> {
  if (!alarmName.startsWith(ALARM_PREFIX)) return null;

  const siteId = alarmName.slice(ALARM_PREFIX.length);
  const tabsToRedirect = await revokeAccess(siteId);
  return { siteId, tabsToRedirect };
}

/**
 * Sync rules - for webRequest this just refreshes the cache
 */
export async function syncRules(): Promise<void> {
  await refreshCache();
}

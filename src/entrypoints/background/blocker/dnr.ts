/**
 * Declarative Net Request (DNR) based blocker for Chrome MV3
 *
 * This module manages DNR rules to intercept and redirect blocked URLs
 * to the extension's blocked page before they load.
 */

import {
  getBlockedSites,
  urlMatchesSiteRules,
  type BlockedSite,
} from "@/lib/storage";
import {
  RULE_ID_BASE,
  MAX_RULES_PER_SITE,
  UNLOCK_PREFIX,
  ALARM_PREFIX,
} from "@/lib/consts";
import { isInternalUrl } from "@/lib/utils";

interface UnlockState {
  siteId: string;
  expiresAt: number;
}

/**
 * Convert a pattern rule to a DNR urlFilter
 * DNR uses a specific syntax different from our patterns
 */
function patternToDnrFilter(pattern: string): string {
  // Normalize pattern
  let normalized = pattern
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");

  // Handle wildcard subdomains: *.example.com -> ||example.com
  if (normalized.startsWith("*.")) {
    const domain = normalized.slice(2);
    return `||${domain}`;
  }

  // Handle path patterns: example.com/path -> ||example.com/path
  // Handle exact domains: example.com -> ||example.com
  return `||${normalized}`;
}

/**
 * Generate DNR rule ID for a site + pattern index
 */
function getRuleId(siteIndex: number, patternIndex: number): number {
  return RULE_ID_BASE + siteIndex * MAX_RULES_PER_SITE + patternIndex;
}

/**
 * Create DNR rules for a blocked site
 * Uses "block" action (not redirect) because redirect requires host permissions.
 * The actual redirect to blocked.html is handled by webNavigation listener.
 */
function createSiteRules(
  site: BlockedSite,
  siteIndex: number
): Browser.declarativeNetRequest.Rule[] {
  if (!site.enabled) return [];

  const rules: Browser.declarativeNetRequest.Rule[] = [];
  const blockPatterns = site.rules.filter((r) => !r.allow);

  // Create block rules (not redirect - redirect requires host permissions)
  blockPatterns.forEach((rule, patternIndex) => {
    const regexFilter = urlFilterToRegex(patternToDnrFilter(rule.pattern));

    rules.push({
      id: getRuleId(siteIndex, patternIndex),
      priority: 1,
      action: {
        type: "block",
      },
      condition: {
        regexFilter,
        resourceTypes: ["main_frame"],
      },
    });
  });

  return rules;
}

/**
 * Convert a urlFilter-style pattern to a regex
 */
function urlFilterToRegex(urlFilter: string): string {
  let pattern = urlFilter.replace(/^\|\|/, "");
  pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*/g, ".*");
  return `^(https?://(www\\.)?${pattern}.*)$`;
}

/**
 * Sync all DNR rules with current blocked sites
 */
export async function syncDnrRules(): Promise<void> {
  const sites = await getBlockedSites();
  const existingRules = await browser.declarativeNetRequest.getDynamicRules();
  const existingRuleIds = existingRules.map((r) => r.id);
  const unlockedSiteIds = await getUnlockedSiteIds();

  const newRules: Browser.declarativeNetRequest.Rule[] = [];

  sites.forEach((site, index) => {
    if (!site.enabled) return;
    if (unlockedSiteIds.has(site.id)) return;

    const siteRules = createSiteRules(site, index);
    newRules.push(...siteRules);
  });

  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
    addRules: newRules,
  });

  console.log(
    `[distacted] DNR rules synced: ${newRules.length} rules for ${sites.filter((s) => s.enabled).length} sites`
  );
}

/**
 * Get set of currently unlocked site IDs
 */
async function getUnlockedSiteIds(): Promise<Set<string>> {
  const session = await browser.storage.session.get();
  const unlockedIds = new Set<string>();
  const now = Date.now();

  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(UNLOCK_PREFIX)) {
      const state = value as UnlockState;
      if (state.expiresAt > now) {
        unlockedIds.add(state.siteId);
      }
    }
  }

  return unlockedIds;
}

/**
 * Grant temporary access to a site
 * Returns the site info for broadcasting to other tabs
 */
export async function grantAccess(
  siteId: string,
  durationMinutes: number | null
): Promise<{ expiresAt: number }> {
  // Default to 60 minutes if no duration specified
  const durationMs = (durationMinutes ?? 60) * 60 * 1000;
  const expiresAt = Date.now() + durationMs;

  // Store unlock state in session storage
  const state: UnlockState = { siteId, expiresAt };
  await browser.storage.session.set({
    [`${UNLOCK_PREFIX}${siteId}`]: state,
  });

  // Re-sync rules (this will exclude the unlocked site)
  await syncDnrRules();

  // Use Alarms API for reliable relock (survives service worker sleep)
  const alarmName = `${ALARM_PREFIX}${siteId}`;
  await browser.alarms.create(alarmName, {
    when: expiresAt,
  });

  console.log(
    `[distacted] Granted access to site ${siteId} for ${durationMinutes ?? 60} minutes`
  );

  return { expiresAt };
}

/**
 * Revoke access to a site (re-enable blocking)
 * Returns list of tabs that need to be redirected
 */
export async function revokeAccess(siteId: string): Promise<number[]> {
  // Remove unlock state
  await browser.storage.session.remove(`${UNLOCK_PREFIX}${siteId}`);

  // Clear any pending alarm
  await browser.alarms.clear(`${ALARM_PREFIX}${siteId}`);

  // Re-sync rules
  await syncDnrRules();

  // Find all tabs that are on this blocked site and need to be redirected
  const tabsToRedirect = await findTabsOnBlockedSite(siteId);

  console.log(
    `[distacted] Revoked access to site ${siteId}, ${tabsToRedirect.length} tabs to redirect`
  );

  return tabsToRedirect;
}

/**
 * Find all tabs that are currently on a blocked site
 */
export async function findTabsOnBlockedSite(siteId: string): Promise<number[]> {
  const sites = await getBlockedSites();
  const site = sites.find((s) => s.id === siteId);
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
  const result = await browser.storage.session.get(`${UNLOCK_PREFIX}${siteId}`);
  const state = result[`${UNLOCK_PREFIX}${siteId}`] as UnlockState | undefined;

  if (!state) return false;
  if (state.expiresAt <= Date.now()) {
    // Expired, clean up
    await browser.storage.session.remove(`${UNLOCK_PREFIX}${siteId}`);
    return false;
  }

  return true;
}

/**
 * Get unlock state for a site (for UI to show remaining time)
 */
export async function getUnlockState(
  siteId: string
): Promise<UnlockState | null> {
  const result = await browser.storage.session.get(`${UNLOCK_PREFIX}${siteId}`);
  const state = result[`${UNLOCK_PREFIX}${siteId}`] as UnlockState | undefined;

  if (!state) return null;
  if (state.expiresAt <= Date.now()) {
    await browser.storage.session.remove(`${UNLOCK_PREFIX}${siteId}`);
    return null;
  }

  return state;
}

/**
 * Handle relock alarm - called from background script's alarm listener
 */
export async function handleRelockAlarm(alarmName: string): Promise<{
  siteId: string;
  tabsToRedirect: number[];
} | null> {
  if (!alarmName.startsWith(ALARM_PREFIX)) return null;

  const siteId = alarmName.slice(ALARM_PREFIX.length);
  console.log(`[distacted] Relock alarm fired for site ${siteId}`);

  const tabsToRedirect = await revokeAccess(siteId);
  return { siteId, tabsToRedirect };
}

/**
 * Initialize DNR on extension startup
 */
export async function initializeDnr(): Promise<void> {
  // Clean up expired unlocks
  const session = await browser.storage.session.get();
  const now = Date.now();

  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(UNLOCK_PREFIX)) {
      const state = value as UnlockState;
      if (state.expiresAt <= now) {
        // Expired, remove
        await browser.storage.session.remove(key);
        // Also clear any stale alarm
        await browser.alarms.clear(`${ALARM_PREFIX}${state.siteId}`);
      }
      // Active unlocks should already have alarms set, no need to recreate
    }
  }

  // Sync all rules
  await syncDnrRules();
}

/**
 * Clear all DNR rules (for testing/reset)
 */
export async function clearAllRules(): Promise<void> {
  const existingRules = await browser.declarativeNetRequest.getDynamicRules();
  const existingRuleIds = existingRules.map((r) => r.id);

  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
  });

  console.log("[distacted] Cleared all DNR rules");
}

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
import { isInternalUrl } from "../utils";

interface UnlockState {
  siteId: string;
  expiresAt: number;
}

export async function syncDnrRules(): Promise<void> {
  const sites = await getBlockedSites();
  const existingRules = await browser.declarativeNetRequest.getDynamicRules();
  const existingRuleIds = existingRules.map((r) => r.id);

  const session = await browser.storage.session.get();
  const unlockedIds = new Set<string>();
  const now = Date.now();

  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(UNLOCK_PREFIX)) {
      const state = value as any;
      if (state.expiresAt > now) {
        unlockedIds.add(state.siteId);
      }
    }
  }

  const newRules: Browser.declarativeNetRequest.Rule[] = [];

  sites.forEach((site, index) => {
    if (!site.enabled) return;
    if (unlockedIds.has(site.id)) return;

    const blockPatterns = site.rules.filter((r) => !r.allow);

    blockPatterns.forEach((rule, patternIndex) => {
      let normalized = rule.pattern
        .toLowerCase()
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "");

      let dnrFilter = `||${normalized}`;
      if (normalized.startsWith("*.")) {
        const domain = normalized.slice(2);
        dnrFilter = `||${domain}`;
      }

      let pattern = dnrFilter.replace(/^\|\|/, "");
      pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      pattern = pattern.replace(/\*/g, ".*");
      const regexFilter = `^(https?://(www\\.)?${pattern}.*)$`;

      newRules.push({
        id: RULE_ID_BASE + index * MAX_RULES_PER_SITE + patternIndex,
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
  });

  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingRuleIds,
    addRules: newRules,
  });

  console.log(
    `[distacted] DNR rules synced: ${newRules.length} rules for ${sites.filter((s) => s.enabled).length} sites`
  );
}

export async function grantAccess(
  siteId: string,
  durationMinutes: number | null
): Promise<{ expiresAt: number }> {
  const durationMs = (durationMinutes ?? 60) * 60 * 1000;
  const expiresAt = Date.now() + durationMs;

  const state: UnlockState = { siteId, expiresAt };
  await browser.storage.session.set({
    [`${UNLOCK_PREFIX}${siteId}`]: state,
  });

  await syncDnrRules();

  const alarmName = `${ALARM_PREFIX}${siteId}`;
  await browser.alarms.create(alarmName, {
    when: expiresAt,
  });

  console.log(
    `[distacted] Granted access to site ${siteId} for ${durationMinutes ?? 60} minutes`
  );

  return { expiresAt };
}

export async function revokeAccess(siteId: string): Promise<number[]> {
  await browser.storage.session.remove(`${UNLOCK_PREFIX}${siteId}`);
  await browser.alarms.clear(`${ALARM_PREFIX}${siteId}`);
  await syncDnrRules();
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
    await browser.storage.session.remove(`${UNLOCK_PREFIX}${siteId}`);
    return false;
  }

  return true;
}

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

export async function initializeDnr(): Promise<void> {
  const session = await browser.storage.session.get();
  const now = Date.now();

  for (const [key, value] of Object.entries(session)) {
    if (key.startsWith(UNLOCK_PREFIX)) {
      const state = value as UnlockState;
      if (state.expiresAt <= now) {
        await browser.storage.session.remove(key);
        await browser.alarms.clear(`${ALARM_PREFIX}${state.siteId}`);
      }
    }
  }

  await syncDnrRules();
}

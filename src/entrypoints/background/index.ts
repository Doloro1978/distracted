import {
  findMatchingBlockedSite,
  getBlockedSites,
  updateStats,
  getSettings,
  getCurrentTabUrl,
  extractDomain,
} from "@/lib/storage";
import * as dnr from "./blockers/dnr";
import * as webRequest from "./blockers/webRequest";
import { isInternalUrl } from "./utils";

const isMV3 = import.meta.env.MANIFEST_VERSION === 3;
console.log(`[distacted] background entry`, {
  isMV3,
});

async function syncRules(): Promise<void> {
  if (isMV3) await dnr.syncDnrRules();
  else await webRequest.syncRules();
}

async function isSiteUnlocked(siteId: string): Promise<boolean> {
  if (isMV3) return dnr.isSiteUnlocked(siteId);
  else return webRequest.isSiteUnlocked(siteId);
}

async function getUnlockState(
  siteId: string
): Promise<{ siteId: string; expiresAt: number } | null> {
  if (isMV3) return dnr.getUnlockState(siteId);
  else return webRequest.getUnlockState(siteId);
}

export default defineBackground(() => {
  console.log("[distacted] Background script initialized");

  (async () => {
    if (isMV3) await dnr.initializeDnr();
    else await webRequest.initializeWebRequest();
  })().catch((err) => {
    console.error("[distacted] Failed to initialize blocker:", err);
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.blockedSites) {
      console.log("[distacted] Blocked sites changed, syncing rules");
      syncRules().catch((err) => {
        console.error("[distacted] Failed to sync rules:", err);
      });
    }
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    const result = isMV3
      ? await dnr.handleRelockAlarm(alarm.name)
      : await webRequest.handleRelockAlarm(alarm.name);
    if (!result) return;

    const { siteId, tabsToRedirect } = result;

    for (const tabId of tabsToRedirect) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (!tab.url) continue;

        const blockedPageUrl = browser.runtime.getURL(
          `/blocked.html?url=${encodeURIComponent(tab.url)}&siteId=${encodeURIComponent(siteId)}`
        );
        await browser.tabs.update(tabId, { url: blockedPageUrl });
        console.log(`[distacted] Redirected tab ${tabId} after relock`);
      } catch (err) {
        console.log(`[distacted] Could not redirect tab ${tabId}:`, err);
      }
    }

    try {
      await browser.runtime.sendMessage({
        type: "SITE_RELOCKED",
        siteId,
      });
    } catch {}
  });

  async function checkAndBlockUrl(tabId: number, url: string, source: string) {
    if (isInternalUrl(url)) return;

    const site = await findMatchingBlockedSite(url);
    if (!site) return;

    const unlocked = await isSiteUnlocked(site.id);
    if (unlocked) return;

    console.log(`[distacted] Blocking (${source}): ${url}`);

    const blockedPageUrl = browser.runtime.getURL(
      `/blocked.html?url=${encodeURIComponent(url)}&siteId=${encodeURIComponent(site.id)}`
    );

    try {
      await browser.tabs.update(tabId, { url: blockedPageUrl });
    } catch (err) {
      console.error("[distacted] Failed to redirect to blocked page:", err);
    }
  }

  browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (!isMV3) return;
    await checkAndBlockUrl(details.tabId, details.url, "onBeforeNavigate");
  });

  browser.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
    if (details.frameId !== 0) return;
    await checkAndBlockUrl(details.tabId, details.url, "onHistoryStateUpdated");
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
    if (!changeInfo.url) return;
    await checkAndBlockUrl(tabId, changeInfo.url, "tabs.onUpdated");
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case "CHECK_BLOCKED": {
            const url = message.url as string;
            const site = await findMatchingBlockedSite(url);
            if (site) {
              const settings = await getSettings();
              const unlocked = await isSiteUnlocked(site.id);
              sendResponse({
                blocked: !unlocked,
                site: unlocked ? null : site,
                statsEnabled: settings.statsEnabled,
              });
            } else {
              sendResponse({ blocked: false, site: null, statsEnabled: false });
            }
            break;
          }

          case "GET_SITE_INFO": {
            const { siteId, url } = message as { siteId?: string; url: string };
            const settings = await getSettings();

            let site = null;

            if (siteId) {
              const sites = await getBlockedSites();
              site = sites.find((s) => s.id === siteId) || null;
            }

            if (!site && url) {
              site = await findMatchingBlockedSite(url);
            }

            if (site) {
              const unlockState = await getUnlockState(site.id);
              if (unlockState) {
                sendResponse({
                  site,
                  statsEnabled: settings.statsEnabled,
                  alreadyUnlocked: true,
                  expiresAt: unlockState.expiresAt,
                });
              } else {
                sendResponse({
                  site,
                  statsEnabled: settings.statsEnabled,
                  alreadyUnlocked: false,
                });
              }
            } else {
              sendResponse({ site: null, statsEnabled: false });
            }
            break;
          }

          case "CHECK_UNLOCK_STATE": {
            const { siteId } = message as { siteId: string };
            const unlockState = await getUnlockState(siteId);
            sendResponse({
              unlocked: !!unlockState,
              expiresAt: unlockState?.expiresAt ?? null,
            });
            break;
          }

          case "UNLOCK_SITE": {
            const { siteId, durationMinutes } = message as {
              siteId: string;
              durationMinutes: number | null;
            };

            const { expiresAt } = isMV3
              ? await dnr.grantAccess(siteId, durationMinutes)
              : await webRequest.grantAccess(siteId, durationMinutes);

            try {
              await browser.runtime.sendMessage({
                type: "SITE_UNLOCKED",
                siteId,
                expiresAt,
              });
            } catch {}

            sendResponse({ success: true, expiresAt });
            break;
          }

          case "UPDATE_STATS": {
            const { siteId, update } = message as {
              siteId: string;
              update: {
                incrementVisit?: boolean;
                incrementPassed?: boolean;
                addTime?: number;
              };
            };
            await updateStats(siteId, update);
            sendResponse({ success: true });
            break;
          }

          case "GET_SETTINGS": {
            const settings = await getSettings();
            sendResponse({ settings });
            break;
          }

          case "GET_CURRENT_TAB_URL": {
            const url = await getCurrentTabUrl();
            const domain = url ? extractDomain(url) : "";
            sendResponse({ url, domain });
            break;
          }

          case "SYNC_RULES": {
            await syncRules();
            sendResponse({ success: true });
            break;
          }

          default:
            sendResponse({ error: "Unknown message type" });
        }
      } catch (error) {
        console.error("[distacted] Message handler error:", error);
        sendResponse({ error: String(error) });
      }
    })();

    return true;
  });
});

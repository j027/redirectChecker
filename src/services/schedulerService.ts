import { checkRedirects } from './redirectMonitorService';

let checkInterval: NodeJS.Timeout;

export function startRedirectChecker() {
  checkInterval = setInterval(async () => {
    try {
      await checkRedirects();
    } catch (error) {
      console.error("Error checking redirects:", error);
    }
  }, 60 * 1000);
}

export function stopRedirectChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }
}
const MICROSOFT_HOSTING_SUFFIXES = [
  ".blob.core.windows.net",
  ".web.core.windows.net",
  ".azurewebsites.net",
  ".azurecontainerapps.io",
  ".azurestaticapps.net",
  ".cloudapp.azure.com",
  ".azurefd.net",
  ".trafficmanager.net",
];

export function isMicrosoftHosted(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return MICROSOFT_HOSTING_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

export function isOnForgeHosted(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".on-forge.com") || lower === "on-forge.com";
}

export type HostingProvider = "microsoft" | "laravel-forge" | null;

export function getHostingProvider(hostname: string): HostingProvider {
  if (isMicrosoftHosted(hostname)) return "microsoft";
  if (isOnForgeHosted(hostname)) return "laravel-forge";
  return null;
}

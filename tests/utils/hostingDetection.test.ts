import { describe, it, expect } from "vitest";
import {
  isMicrosoftHosted,
  isOnForgeHosted,
  getHostingProvider,
} from "../../src/utils/hostingDetection.js";

describe("hostingDetection", () => {
  describe("isMicrosoftHosted", () => {
    it("detects Azure Blob Storage", () => {
      expect(isMicrosoftHosted("scamsite.blob.core.windows.net")).toBe(true);
    });

    it("detects Azure Static Web Apps", () => {
      expect(isMicrosoftHosted("evil.web.core.windows.net")).toBe(true);
    });

    it("detects Azure App Service", () => {
      expect(isMicrosoftHosted("phish.azurewebsites.net")).toBe(true);
    });

    it("detects Azure Container Apps", () => {
      expect(isMicrosoftHosted("scam.azurecontainerapps.io")).toBe(true);
    });

    it("detects Azure Static Web Apps (custom domain)", () => {
      expect(isMicrosoftHosted("evil.azurestaticapps.net")).toBe(true);
    });

    it("detects Azure Cloud Services", () => {
      expect(isMicrosoftHosted("scam.cloudapp.azure.com")).toBe(true);
    });

    it("detects Azure Front Door", () => {
      expect(isMicrosoftHosted("phish.azurefd.net")).toBe(true);
    });

    it("detects Azure Traffic Manager", () => {
      expect(isMicrosoftHosted("scam.trafficmanager.net")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isMicrosoftHosted("SCAM.BLOB.CORE.WINDOWS.NET")).toBe(true);
    });

    it("returns false for non-Microsoft hostnames", () => {
      expect(isMicrosoftHosted("example.com")).toBe(false);
      expect(isMicrosoftHosted("scam.herokuapp.com")).toBe(false);
      expect(isMicrosoftHosted("phish.netlify.app")).toBe(false);
    });

    it("returns false for partial matches", () => {
      expect(isMicrosoftHosted("notazurewebsites.net")).toBe(false);
      expect(isMicrosoftHosted("fakeblob.core.windows.net.evil.com")).toBe(false);
    });
  });

  describe("isOnForgeHosted", () => {
    it("detects subdomain of on-forge.com", () => {
      expect(isOnForgeHosted("mysite.on-forge.com")).toBe(true);
    });

    it("detects nested subdomain of on-forge.com", () => {
      expect(isOnForgeHosted("app.user.on-forge.com")).toBe(true);
    });

    it("detects bare on-forge.com", () => {
      expect(isOnForgeHosted("on-forge.com")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isOnForgeHosted("SITE.ON-FORGE.COM")).toBe(true);
    });

    it("returns false for non-on-forge hostnames", () => {
      expect(isOnForgeHosted("example.com")).toBe(false);
      expect(isOnForgeHosted("on-forge.com.evil.com")).toBe(false);
    });
  });

  describe("getHostingProvider", () => {
    it("returns microsoft for Azure hostnames", () => {
      expect(getHostingProvider("scam.blob.core.windows.net")).toBe("microsoft");
    });

    it("returns laravel-forge for on-forge hostnames", () => {
      expect(getHostingProvider("site.on-forge.com")).toBe("laravel-forge");
    });

    it("returns null for unrecognized hostnames", () => {
      expect(getHostingProvider("example.com")).toBeNull();
    });
  });
});

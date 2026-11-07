import { describe, expect, it } from "vitest";
import { getBrowserLaunchArgs } from "../../src/services/browserManagerService.js";

describe("getBrowserLaunchArgs", () => {
  it("uses SwiftShader by default", () => {
    expect(getBrowserLaunchArgs("swiftshader")).toEqual([
      "--enable-unsafe-swiftshader",
    ]);
  });

  it("uses ANGLE OpenGL for Mesa", () => {
    expect(getBrowserLaunchArgs("mesa")).toEqual([
      "--use-gl=angle",
      "--use-angle=gl",
      "--ignore-gpu-blocklist",
    ]);
  });
});

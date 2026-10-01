import { describe, it, expect } from "vite-plus/test";
import { windowsRelaunchDetails } from "./DesktopWindowsRelaunch.ts";

const input = {
  appId: "com.j1code.desktop",
  appName: "J1 Code",
  executablePath: "C:\\Temp\\extract\\J1 Code.exe",
  iconPath: "C:\\Icons\\icon.ico",
};
describe("Windows taskbar relaunch", () => {
  it("relaunches the portable outer file instead of a disposable extraction", () => {
    expect(
      windowsRelaunchDetails({ ...input, portableExecutable: "C:\\Apps\\J1 Code.exe" })
        .relaunchCommand,
    ).toBe('"C:\\Apps\\J1 Code.exe"');
  });
  it("uses the stable installed executable and app identity", () => {
    const installed = "C:\\Users\\Alice\\AppData\\Local\\Programs\\J1 Code\\J1 Code.exe";
    expect(windowsRelaunchDetails({ ...input, executablePath: installed })).toMatchObject({
      appId: input.appId,
      relaunchCommand: `"${installed}"`,
      relaunchDisplayName: "J1 Code",
    });
  });
  it("ignores a relative portable override", () => {
    expect(
      windowsRelaunchDetails({ ...input, portableExecutable: "J1 Code.exe" }).relaunchCommand,
    ).toBe(`"${input.executablePath}"`);
  });
});

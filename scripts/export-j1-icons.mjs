import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";
const root = new URL("../", import.meta.url);
const destination = new URL("assets/j1/", root);
await NodeFSP.mkdir(destination, { recursive: true });
const svg = await NodeFSP.readFile(new URL("icon.svg", destination));
const sizes = [16, 32, 48, 180, 256, 512, 1024];
const pngs = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
for (let index = 0; index < sizes.length; index++)
  await NodeFSP.writeFile(new URL(`icon-${sizes[index]}.png`, destination), pngs[index]);
const frames = [16, 32, 48, 256].map((size) => ({ size, png: pngs[sizes.indexOf(size)] }));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await NodeFSP.writeFile(
  new URL("icon.ico", destination),
  Buffer.concat([header, ...frames.map((frame) => frame.png)]),
);

const mark = await NodeFSP.readFile(new URL("app-icon.icon/Assets/text.svg", destination), "utf8");
const mobileAssets = new URL("apps/mobile/assets/", root);
const canvas = (size, background = "") =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 432 432">${background}<svg x="112" y="147" width="208" height="139" viewBox="0 0 96 64">${mark.replace(/^.*?<svg[^>]*>/s, "").replace(/<\/svg>\s*$/, "")}</svg></svg>`,
  );
await NodeFSP.writeFile(
  new URL("android-icon-foreground.png", mobileAssets),
  await sharp(canvas(432)).png().toBuffer(),
);
await NodeFSP.writeFile(
  new URL("android-icon-mark.png", mobileAssets),
  await sharp(canvas(432)).png().toBuffer(),
);
await NodeFSP.writeFile(
  new URL("android-notification-icon.png", mobileAssets),
  await sharp(canvas(96)).png().toBuffer(),
);
for (const variant of ["dev", "nightly", "prod"]) {
  await NodeFSP.writeFile(
    new URL(`android-splash-icon-${variant}.png`, mobileAssets),
    await sharp(canvas(1152)).png().toBuffer(),
  );
  if (variant !== "prod")
    await NodeFSP.writeFile(
      new URL(`android-icon-background-${variant}.png`, mobileAssets),
      await sharp({ create: { width: 432, height: 432, channels: 4, background: "#171717" } })
        .png()
        .toBuffer(),
    );
}
await NodeFSP.mkdir(new URL("app-icon.icon/Assets/", destination), { recursive: true });
await NodeFSP.writeFile(
  new URL("app-icon.icon/icon.json", destination),
  await NodeFSP.readFile(new URL("assets/prod/app-icon.icon/icon.json", root)),
);
await NodeFSP.writeFile(
  new URL("app-icon.icon/Assets/text.svg", destination),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64"><path fill="white" d="M12 4H50V44C50 57 42 64 27 64C12 64 4 57 4 44V39H18V44C18 50 21 53 27 53C33 53 36 50 36 44V16H12ZM64 14L78 4H90V52H96V64H62V52H76V20L64 28Z"/></svg>',
);
console.log("J1 vector, PNG, ICO and Icon Composer assets generated.");

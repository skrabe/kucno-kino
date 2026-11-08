// Renders assets/logo.png (the add-on icon shown in Stremio) from an inline SVG.
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f97316"/>
      <stop offset="1" stop-color="#9a3412"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <!-- house -->
  <path d="M256 92 L420 222 L384 222 L384 404 L128 404 L128 222 L92 222 Z" fill="#fff7ed"/>
  <!-- screen -->
  <rect x="160" y="236" width="192" height="132" rx="18" fill="#7c2d12"/>
  <!-- play -->
  <path d="M236 270 L236 334 L292 302 Z" fill="#fff7ed"/>
</svg>`;

await sharp(Buffer.from(svg)).resize(256, 256).png({ compressionLevel: 9 }).toFile(new URL("../assets/logo.png", import.meta.url).pathname);
console.log("assets/logo.png written");

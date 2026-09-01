#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';

const sourceDir = 'C:\\Users\\LD\\.codex\\generated_images\\01a046e7-d8b2-7183-9ca0-a0e9977b512a';
const outputDir = resolve('output/hero-concepts');
const sources = [
  'exec-d2938860-80c3-4280-8507-dfd1c5ad2b81.png',
  'exec-38144944-c644-4669-9804-3a9f21792ee2.png',
  'exec-acfcf319-b96b-4c7e-91ca-bf72b261eb39.png',
  'exec-a8131b06-ee81-4236-bd59-a36ad57d541f.png',
  'exec-0da5231c-2aed-426b-a86a-45d19c559e8d.png',
];
const names = [
  'hero-concept-01-bright-bathroom.webp',
  'hero-concept-02-warm-kitchen.webp',
  'hero-concept-03-industrial-pipes.webp',
  'hero-concept-04-rainy-emergency.webp',
  'hero-concept-05-water-abstract.webp',
];

await mkdir(outputDir, { recursive: true });
for (let index = 0; index < sources.length; index += 1) {
  await sharp(join(sourceDir, sources[index]))
    .resize(1600, 900, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82 })
    .toFile(join(outputDir, names[index]));
}

const cards = await Promise.all(names.map(async (name, index) => {
  const image = await sharp(join(outputDir, name)).resize(640, 360, { fit: 'cover' }).toBuffer();
  const label = Buffer.from(
    `<svg width="640" height="40"><rect width="640" height="40" fill="#111827"/>`
    + `<text x="16" y="27" font-family="Arial" font-size="20" fill="white">CONCEPT ${index + 1}</text></svg>`,
  );
  return sharp({ create: { width: 640, height: 400, channels: 3, background: '#111827' } })
    .composite([{ input: image, top: 0, left: 0 }, { input: label, top: 360, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}));

await sharp({ create: { width: 1280, height: 1200, channels: 3, background: '#d1d5db' } })
  .composite(cards.map((input, index) => ({ input, left: (index % 2) * 640, top: Math.floor(index / 2) * 400 })))
  .jpeg({ quality: 90 })
  .toFile(join(outputDir, 'hero-concepts-contact-sheet.jpg'));

console.log(`Prepared ${names.length} concepts in ${outputDir}`);

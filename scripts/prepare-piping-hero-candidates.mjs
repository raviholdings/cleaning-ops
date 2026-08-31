#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';

const sourceDir = 'C:\\Users\\LD\\.codex\\generated_images\\01a046e7-d8b2-7183-9ca0-a0e9977b512a';
const outputDir = resolve('output/hero-candidates');
const sources = [
  'exec-81370667-418f-4f87-ac88-07dfa816c6a0.png',
  'exec-504cb9c1-5639-48e6-bbf0-d1cd59cebb3b.png',
  'exec-48d2fa87-f3ed-4792-83a7-299b5665aa0a.png',
  'exec-22292d68-f809-44a3-bb20-bbb191f93559.png',
  'exec-9613e0f1-1518-4387-b722-7e5c32b95ff0.png',
];
const names = [
  'hero-01-toilet-service.webp',
  'hero-02-kitchen-drain.webp',
  'hero-03-pipe-camera.webp',
  'hero-04-equipment.webp',
  'hero-05-flow-check.webp',
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
    + `<text x="16" y="27" font-family="Arial" font-size="20" fill="white">HERO ${index + 1}</text></svg>`,
  );
  return sharp({ create: { width: 640, height: 400, channels: 3, background: '#111827' } })
    .composite([{ input: image, top: 0, left: 0 }, { input: label, top: 360, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}));

await sharp({ create: { width: 1280, height: 1200, channels: 3, background: '#d1d5db' } })
  .composite(cards.map((input, index) => ({
    input,
    left: (index % 2) * 640,
    top: Math.floor(index / 2) * 400,
  })))
  .jpeg({ quality: 90 })
  .toFile(join(outputDir, 'hero-contact-sheet.jpg'));

console.log(`Prepared ${names.length} hero candidates in ${outputDir}`);

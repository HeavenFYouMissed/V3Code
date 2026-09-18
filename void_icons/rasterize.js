/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
const sharp = require('sharp');
const fs = require('fs');
const files = [
  'v3-concept1-delta',
  'v3-concept2-prism',
  'v3-concept3-cutout',
  'v3-concept4-tessellated',
];
(async () => {
  for (const f of files) {
    const svg = fs.readFileSync(f + '.svg');
    await sharp(svg, { density: 384 })
      .resize(1024, 1024)
      .png()
      .toFile(f + '.png');
    console.log('wrote', f + '.png');
  }
})();

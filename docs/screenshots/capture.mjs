import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slides = [
  { id: 'slide-1', output: 'store-1-detection.png' },
  { id: 'slide-2', output: 'store-2-delegation.png' },
  { id: 'slide-3', output: 'store-3-readOnly.png' },
  { id: 'slide-4', output: 'store-4-killswitch.png' },
  { id: 'promo-small', output: 'promo-small-440x280.png' },
  { id: 'promo-marquee', output: 'promo-marquee-1400x560.png' },
];

async function captureSlides(browser) {
  const page = await browser.newPage();

  const htmlPath = path.join(__dirname, 'generate.html');
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });

  for (const slide of slides) {
    const element = await page.$(`#${slide.id}`);
    if (!element) {
      console.error(`Element #${slide.id} not found`);
      continue;
    }

    const outputPath = path.join(__dirname, slide.output);
    await element.screenshot({
      path: outputPath,
      type: 'png',
      omitBackground: false,
    });
    console.log(`Saved: ${slide.output}`);
  }
}

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  try {
    await captureSlides(browser);
  } catch (err) {
    // An open browser keeps this process running, so close it before the
    // error is reported.
    await browser.close().catch(() => {});
    throw err;
  }

  await browser.close();
  console.log('Done. Verify with: sips -g pixelWidth -g pixelHeight -g hasAlpha store-*.png promo-*.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const filePath = path.resolve(__dirname, 'presentation.html');
  await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0' });

  // Get total height of all slides
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  const slideWidth = 1120;
  const slideHeight = 630;

  // Set viewport to slide dimensions
  await page.setViewport({ width: slideWidth, height: slideHeight });

  // Get number of slides
  const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);

  // Export each slide as a separate page in the PDF
  // Use a custom approach: screenshot each slide and combine
  await page.pdf({
    path: path.resolve(__dirname, 'presentation.pdf'),
    width: `${slideWidth}px`,
    height: `${slideHeight}px`,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  console.log(`PDF exported: presentation.pdf (${slideCount} slides)`);
  await browser.close();
})();

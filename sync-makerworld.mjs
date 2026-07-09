// Reads DJ Cracka's public MakerWorld models with a real (headless) browser,
// which clears Cloudflare's JS challenge, and writes models.json if the list changed.
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const PROFILE = 'https://makerworld.com/en/@CrackaFPV/upload';
const sig = a => a.map(m => `${m.id}|${m.coverUrl}|${m.title}|${m.nsfw ? 1 : 0}`).sort().join('\n');

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  viewport: { width: 1280, height: 900 }
});
const page = await ctx.newPage();

let designs = [];
try {
  await page.goto(PROFILE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000); // give Cloudflare's JS challenge time to clear
  const title = await page.title();
  console.log('Page title:', title);
  designs = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return [];
    let nd; try { nd = JSON.parse(el.textContent); } catch (e) { return []; }
    const d = (nd.props && nd.props.pageProps && nd.props.pageProps.designs) || [];
    return d.map(x => ({
      id: x.id,
      slug: x.slug || '',
      title: x.title || 'MakerWorld model',
      coverUrl: String(x.coverUrl || '').split('?')[0],
      nsfw: !!x.nsfw
    }));
  });
} catch (e) {
  console.log('Load error:', e.message);
}
await browser.close();

designs = (designs || []).filter(m => m.id && m.coverUrl);
if (!designs.length) {
  console.log('No models parsed (likely a Cloudflare block). Leaving models.json unchanged.');
  process.exit(0);
}

const out = {
  updated: new Date().toISOString().slice(0, 10),
  source: 'https://makerworld.com/en/@CrackaFPV',
  models: designs
};

let cur = [];
if (existsSync('models.json')) {
  try { cur = JSON.parse(readFileSync('models.json', 'utf8')).models || []; } catch (e) {}
}
if (sig(cur) === sig(designs)) {
  console.log('No change (' + designs.length + ' models).');
  process.exit(0);
}

writeFileSync('models.json', JSON.stringify(out, null, 2) + '\n');
console.log('Updated models.json with ' + designs.length + ' models.');

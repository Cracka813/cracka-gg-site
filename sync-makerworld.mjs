// Reads DJ Cracka's public MakerWorld models with a real (headless) browser,
// which clears Cloudflare's JS challenge, then MERGES any age-gated (NSFW)
// model IDs listed in makerworld_nsfw.json, and writes models.json if changed.
//
// Why a browser: MakerWorld sits behind Cloudflare Bot Management, which blocks
// plain server-side fetches (e.g. a Cloudflare Worker) with a JS challenge.
// Playwright runs a real Chromium on GitHub's runners and clears it.
//
// NSFW handling: the anonymous profile list hides age-gated designs, so we can't
// discover them. Instead makerworld_nsfw.json holds their bare IDs; for each we
// open the model's own public page (which exposes title + cover with no login)
// and merge it in. Adding a future NSFW model = drop its ID in that file.
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const PROFILE   = 'https://makerworld.com/en/@CrackaFPV/upload';
const EXTRAS    = 'makerworld_nsfw.json';   // repo-root file (public info only)
const sig = a => a.map(m => `${m.id}|${m.coverUrl}|${m.title}|${m.nsfw ? 1 : 0}`).sort().join('\n');

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  viewport: { width: 1280, height: 900 }
});
const page = await ctx.newPage();

// ---- 1) scrape the public profile design list ----
let designs = [];
try {
  await page.goto(PROFILE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000); // let Cloudflare's JS challenge clear
  console.log('Profile title:', await page.title());
  designs = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return [];
    let nd; try { nd = JSON.parse(el.textContent); } catch (e) { return []; }
    const d = (nd.props && nd.props.pageProps && nd.props.pageProps.designs) || [];
    return d.map(x => ({
      id: x.id,
      slug: x.slug || '',
      title: x.title || 'MakerWorld model',
      coverUrl: String(x.coverUrl || x.cover || '').split('?')[0],
      nsfw: !!x.nsfw
    }));
  });
} catch (e) {
  console.log('Profile load error:', e.message);
}

const scrapeBlocked = !designs || !designs.length;
designs = (designs || []).filter(m => m.id && m.coverUrl);

// ---- 2) resolve one model by ID from its own public page ----
async function resolveId(id) {
  try {
    await page.goto('https://makerworld.com/en/models/' + id, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    return await page.evaluate(() => {
      const og = p => (document.querySelector(`meta[property="og:${p}"]`) || {}).content || '';
      const canon = (document.querySelector('link[rel="canonical"]') || {}).href || '';
      const slug = (canon.match(/\/models\/\d+-([a-z0-9-]+)/i) || [])[1] || '';
      let title = og('title').replace(/\s*-\s*MakerWorld\s*$/i, '').replace(/\s*-\s*Free 3D Print Model\s*$/i, '').trim();
      const cover = String(og('image') || '').split('?')[0];
      return cover ? { slug, title: title || 'MakerWorld model', coverUrl: cover } : null;
    });
  } catch (e) { console.log('resolveId', id, 'error:', e.message); return null; }
}

// ---- 3) merge age-gated NSFW IDs from makerworld_nsfw.json ----
let extraIds = [];
if (existsSync(EXTRAS)) {
  try {
    const ej = JSON.parse(readFileSync(EXTRAS, 'utf8'));
    const arr = Array.isArray(ej) ? ej : (ej.ids || ej.models || ej.nsfw || []);
    extraIds = arr.map(x => (x && typeof x === 'object') ? x : { id: x });
  } catch (e) { console.log('extras parse error:', e.message); }
}
for (const ex of extraIds) {
  const id = Number(ex.id);
  if (!id || designs.some(m => Number(m.id) === id)) continue;
  let entry;
  if (ex.coverUrl || ex.cover) {
    entry = { id, slug: ex.slug || '', title: ex.title || 'MakerWorld model', coverUrl: String(ex.coverUrl || ex.cover).split('?')[0], nsfw: true };
  } else {
    const r = await resolveId(id);
    if (r) entry = { id, slug: r.slug, title: r.title, coverUrl: r.coverUrl, nsfw: true };
  }
  if (entry) { designs.push(entry); console.log('Merged NSFW model', id); }
}

await browser.close();

// ---- 4) safety: never wipe a good file on a blocked scrape ----
let cur = [];
if (existsSync('models.json')) {
  try { cur = JSON.parse(readFileSync('models.json', 'utf8')).models || []; } catch (e) {}
}
if (scrapeBlocked) {
  // Scrape was blocked; keep existing public models and just re-ensure NSFW extras.
  const byId = new Map(cur.map(m => [Number(m.id), m]));
  for (const d of designs) byId.set(Number(d.id), d);
  designs = [...byId.values()];
  console.log('Scrape blocked — preserved existing list, re-merged extras.');
}

if (!designs.length) {
  console.log('Nothing to write (empty). Leaving models.json unchanged.');
  process.exit(0);
}

const out = {
  updated: new Date().toISOString().slice(0, 10),
  source: 'https://makerworld.com/en/@CrackaFPV',
  models: designs
};

if (sig(cur) === sig(designs)) {
  console.log('No change (' + designs.length + ' models).');
  process.exit(0);
}

writeFileSync('models.json', JSON.stringify(out, null, 2) + '\n');
console.log('Updated models.json with ' + designs.length + ' models.');

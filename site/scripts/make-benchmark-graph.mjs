// Generator for public/benchmark-graph.svg (run: node scripts/make-benchmark-graph.mjs)
// Data: README "Measured field results, runs 4-6" (means of runs 4,5,6). Baseline
// arm is stock pi — already the famously minimal harness; the delta is debloating
// a minimal baseline, so a heavier host would likely show a larger delta.
// Colors are parsed from src/styles/global.css (single source of truth). The SVG
// bakes the LIGHT palette as its default; it is rendered like a printed chart in
// both color modes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const metrics = [
  { label: 'Input tokens',  base: 45.07, dk: 7.5,   fmt: v => `${v.toFixed(1)}k`,   speedup: '↓6.5×', note: 'incl. cache reads',
    // Cache-read means (runs 4–6): dk (15.7+12.8+0)/3 = 9.5k, base (47.9+139.5+6.9)/3 = 64.77k.
    // Totals: dk 7.5+9.5 = 17.0k, base 45.07+64.77 = 109.84k → ↓6.5×. Rendered as a shaded
    // segment on top of the input part of each bar (cache is billed ~10× cheaper/token).
    cache: { base: 64.77, dk: 9.5 } },
  { label: 'Output tokens', base: 4.26,  dk: 0.933, fmt: v => `${v.toFixed(2)}k`,   speedup: '↓4.6×' },
  { label: 'LLM turns',     base: 14.67, dk: 4.33,  fmt: v => v.toFixed(1),         speedup: '↓3.4×' },
  { label: 'Wall clock (s)', base: 79.4, dk: 25.1,  fmt: v => `${v.toFixed(1)}s`,   speedup: '↓3.2×' },
  { label: '$ per session', base: 0.0063, dk: 0.0011, fmt: v => `$${v.toFixed(4)}`, speedup: '↓5.7×' },
];
const W = 1000, H = 575, chartX0 = 95, chartX1 = 955, yBase = 445, yTop = 118;
const yOf = p => yBase - (p / 100) * (yBase - yTop);
const groupW = (chartX1 - chartX0) / metrics.length;
const barW = 54, barGap = 13, pairW = barW * 2 + barGap;
const SERIF = "Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif";

// --- Parse palette from src/styles/global.css -------------------------------
function parseVars(block) {
  const vars = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.trim();
  }
  return vars;
}
function readPalette() {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/global.css');
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = {};
  for (const [, selector, body] of css.matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
    const sel = selector.trim();
    if (sel === ':root') Object.assign(blocks, { light: parseVars(body) });
    else if (sel.includes("data-theme='dark'") || sel.includes('data-theme="dark"'))
      Object.assign(blocks, { dark: parseVars(body) });
  }
  if (!blocks.light) {
    throw new Error('global.css must define a :root variable block');
  }
  return blocks.light;
}
const V = readPalette();

// PUBLIC_AUTHOR_HANDLE from the repo-root .env (the source Astro uses; never process.env).
function readHandle() {
  try {
    const m = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), 'utf8')
      .match(/^PUBLIC_AUTHOR_HANDLE\s*=\s*(.+)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}
const handle = readHandle();

// --- Build SVG ----------------------------------------------------------------
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${SERIF}" role="img" aria-label="Benchmark bar graph: sessions with DecisionKit use a fraction of the baseline resources across five metrics">
  <style>
    /* Colors are inlined (not var()) — librsvg/sharp rasterization doesn't
       support CSS custom properties, and the light palette is baked by design. */
    .bg { fill: ${V['--paper']}; }
    .ink { fill: ${V['--ink']}; }
    .muted { fill: ${V['--muted']}; }
    .rule { stroke: ${V['--rule']}; }
    .rule0 { stroke: ${V['--ink']}; }
    .bar-base { fill: ${V['--baseline-bar']}; }
    .bar-base.dim { fill: ${V['--baseline-bar']}; opacity: .45; }
    .bar-dk { fill: ${V['--accent']}; }
    .bar-dk.dim { fill: ${V['--accent']}; opacity: .45; }
    .txt-dk { fill: ${V['--accent-ink']}; }
    .txt-speed { fill: ${V['--accent-ink']}; }
  </style>
  <rect class="bg" width="${W}" height="${H}"/>
  <text class="ink" x="${W / 2}" y="40" text-anchor="middle" font-size="22" font-weight="700">Cost of one coding-agent session — normalized to baseline (= 100%)</text>
  <text class="muted" x="${W / 2}" y="68" text-anchor="middle" font-size="14" font-style="italic">Focused code-change prompt · mean of 3 runs · Pi agent · glm-5.3-flash:low · lower is better</text>
`;
for (const p of [0, 25, 50, 75, 100]) {
  const y = yOf(p);
  s += `  <line class="${p === 0 ? 'rule0' : 'rule'}" x1="${chartX0}" y1="${y}" x2="${chartX1}" y2="${y}" stroke-width="1"/>
  <text class="muted" x="${chartX0 - 10}" y="${y + 4.5}" text-anchor="end" font-size="12.5">${p}%</text>
`;
}
metrics.forEach((m, i) => {
  const cx = chartX0 + groupW * i + groupW / 2;
  const xBase = cx - pairW / 2, xDk = xBase + barW + barGap;
  // With cache tracked, totals normalize to input+cache and each bar splits into
  // a solid (input) bottom segment and a shaded (cache-read) top segment.
  const tBase = m.cache ? m.base + m.cache.base : m.base;
  const tDk = m.cache ? m.dk + m.cache.dk : m.dk;
  const yDkTop = yOf((tDk / tBase) * 100);
  if (m.cache) {
    const ySplit = yOf((m.base / tBase) * 100); // baseline: input share below, cache share above
    s += `  <rect class="bar-base dim" x="${xBase}" y="${yTop}" width="${barW}" height="${ySplit - yTop}"/>
  <rect class="bar-base" x="${xBase}" y="${ySplit}" width="${barW}" height="${yBase - ySplit}"/>
`;
  } else {
    s += `  <rect class="bar-base" x="${xBase}" y="${yTop}" width="${barW}" height="${yBase - yTop}"/>
`;
  }
  s += `  <text class="muted" x="${xBase + barW / 2}" y="${yTop - 10}" text-anchor="middle" font-size="13" font-weight="600">${m.fmt(tBase)}</text>
`;
  if (m.cache) {
    const yInSplit = yOf((m.dk / tBase) * 100); // dk bar: input share below, cache share above
    s += `  <rect class="bar-dk dim" x="${xDk}" y="${yDkTop}" width="${barW}" height="${yInSplit - yDkTop}"/>
  <rect class="bar-dk" x="${xDk}" y="${yInSplit}" width="${barW}" height="${yBase - yInSplit}"/>
`;
  } else {
    s += `  <rect class="bar-dk" x="${xDk}" y="${yDkTop}" width="${barW}" height="${yBase - yDkTop}"/>
`;
  }
  s += `  <text class="txt-dk" x="${xDk + barW / 2}" y="${yDkTop - 10}" text-anchor="middle" font-size="13" font-weight="700">${m.fmt(tDk)}</text>
  <text class="ink" x="${cx}" y="${yBase + 28}" text-anchor="middle" font-size="15" font-weight="600">${m.label}${m.note ? ` <tspan class="muted" font-size="11" font-style="italic">(${m.note})</tspan>` : ''}</text>
  <text class="txt-speed" x="${cx}" y="${yBase + 54}" text-anchor="middle" font-size="15" font-weight="800">${m.speedup}</text>
`;
});
s += `  <rect class="bar-base" x="${chartX0}" y="${H - 45}" width="13" height="13"/>
  <text class="muted" x="${chartX0 + 21}" y="${H - 34}" font-size="13.5">baseline</text>
  <rect class="bar-dk" x="${chartX0 + 106}" y="${H - 45}" width="13" height="13"/>
  <text class="muted" x="${chartX0 + 127}" y="${H - 34}" font-size="13.5">with Jev-powered DecisionKit</text>
  <rect class="bar-base dim" x="${chartX0 + 355}" y="${H - 45}" width="6.5" height="13"/>
  <rect class="bar-dk dim" x="${chartX0 + 361.5}" y="${H - 45}" width="6.5" height="13"/>
  <text class="muted" x="${chartX0 + 382}" y="${H - 34}" font-size="13.5">shaded = cache reads</text>
  <text class="txt-dk" x="${W / 2}" y="${H - 15}" text-anchor="middle" font-size="12.5" font-weight="700">verify gate: 2/3 (baseline) vs 3/3 (with DecisionKit)</text>
  <text class="muted" x="${W - 20}" y="${H - 34}" text-anchor="end" font-size="12" font-style="italic">Source: DecisionKit README, 3 runs (2026-09-21)</text>
${handle ? `  <text class="muted" x="${W - 20}" y="${H - 15}" text-anchor="end" font-size="11" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${handle.replace(/&/g, '\u0026amp;').replace(/</g, '\u0026lt;')}</text>\n` : ''}
</svg>
`;
const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../public/benchmark-graph.svg');
mkdirSync(dirname(outPath), { recursive: true });
const svg = s.trim();
writeFileSync(outPath, svg);

// PNG preview (used for OG/social cards). Rendered from the same SVG so the two
// never drift. Requires sharp (devDependency of site).
try {
  const { default: sharp } = await import('sharp');
  const pngPath = outPath.replace(/\.svg$/, '-og.png');
  await sharp(Buffer.from(svg), { density: 192 })
    .resize({ width: 2000 })
    .png()
    .toFile(pngPath);
  console.log(`Wrote ${pngPath}`);
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.warn('sharp not installed — skipping PNG (npm install in site/ to enable)');
  } else {
    throw err;
  }
}
console.log(`Wrote ${outPath} (light palette from src/styles/global.css)`);

// Verification record for the token-radar-01 v3 entry. Run from the repo root:
//   node verify.mjs --out /tmp/runA --snapshot <kit>/input/snapshot.json
// Checks the §6 gate mirror, the §V8 additions, and the §W10 additions that
// are machine-checkable, against one program output directory. Prints one
// line per check and exits non-zero if any check fails. It never writes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const outDir = get('out', '/tmp/runA');
const snapPath = get('snapshot', '');
const repo = get('repo', '.');
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function pngDims(buf) {
  // PNG IHDR: width/height are big-endian uint32 at offsets 16/20.
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const snapBySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const rows = board.rows;
const dataJs = readFileSync(join(outDir, 'dashboard', 'data.js'), 'utf8');
const D = JSON.parse(dataJs.slice(dataJs.indexOf('{'), dataJs.lastIndexOf('}') + 1));
const dossierBytes = readFileSync(join(outDir, 'dossier.json'));
const dossier = JSON.parse(dossierBytes.toString('utf8'));
const mainTs = readFileSync(join(repo, 'main.ts'), 'utf8');
const appJs = readFileSync(join(repo, 'dashboard', 'app.js'), 'utf8');
const indexHtml = readFileSync(join(repo, 'dashboard', 'index.html'), 'utf8');
const appCss = readFileSync(join(repo, 'dashboard', 'app.css'), 'utf8');

// --- §6.1 gate mirror: board shape, ranks, values, watchlist, steps.
check('board rows 100..4000', rows.length >= 100 && rows.length <= 4000, `${rows.length} rows`);
check('ranks exactly 1..N', rows.every((r, i) => r.rank === i + 1));
check('implied values non-increasing', rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd));
check('slugs unique', new Set(rows.map((r) => r.slug)).size === rows.length);
const boardSlugs = new Set(rows.map((r) => r.slug));
const watchMissing = snap.watchlist.filter((s) => !boardSlugs.has(s));
check('watchlist 40/40 exactly once', watchMissing.length === 0 && snap.watchlist.length === 40, `${snap.watchlist.length} watchlist, ${watchMissing.length} missing`);
const outsideWatch = rows.filter((r) => !snap.watchlist.includes(r.slug)).length;
check('>=60 rows outside watchlist', outsideWatch >= 60, `${outsideWatch} outside`);
const badSteps = rows.filter((r) => r.farm_steps.length !== 6 || r.farm_steps.some((s) => s.length < 60 || s.length > 420));
check('exactly 6 farm steps, each 60..420 chars', badSteps.length === 0, badSteps.length ? `bad: ${badSteps.slice(0, 3).map((r) => r.slug).join(',')}` : 'all 6 x 60..420');
const kitBadSteps = rows.filter((r) => r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s) => s.length < 20 || s.length > 600));
check('kit step bounds 3..12 x 20..600', kitBadSteps.length === 0);
const withMcap = rows.filter((r) => { const p = snapBySlug.get(r.slug); return p && typeof p.mcap_usd === 'number'; });
check('board disjoint from traded (no mcap)', withMcap.length === 0, `${withMcap.length} with mcap`);
check('no forbidden tier string in board', !JSON.stringify(board).includes('Research only'));
check('no forbidden tier string in dashboard', ![appJs, indexHtml, appCss, dataJs].some((t) => t.includes('Research only')));
check('no http(s) URLs in dashboard files', ![appJs, indexHtml, appCss].some((t) => t.includes('http://') || t.includes('https://')));

// --- Census + ledger consistency from embedded numbers.
const buckets = D.L.census.buckets;
const bucketSum = Object.values(buckets).reduce((s, b) => s + b[0], 0);
check('census buckets sum to snapshot total', bucketSum === snap.protocols.length, `${bucketSum} vs ${snap.protocols.length}`);
check('board = watchlist + belowFloor buckets', rows.length === buckets.watchlist[0] + buckets.belowFloor[0], `${rows.length} vs ${buckets.watchlist[0]}+${buckets.belowFloor[0]}`);
check('comps bucket = fitted comps', buckets.comps[0] === D.meta.nComp, `${buckets.comps[0]} vs ${D.meta.nComp}`);
check('data.js rows match board order', D.rows.length === rows.length && D.rows.every((r, i) => r[0] === rows[i].slug));
const valueDrift = D.rows.map((r, i) => Math.abs(Math.round(Math.pow(10, r[8])) - rows[i].implied_value_usd) / Math.max(1, rows[i].implied_value_usd));
check('embedded yhat reproduces board values (<0.01%)', Math.max(...valueDrift) < 0.0001, `max drift ${(Math.max(...valueDrift) * 100).toFixed(4)}%`);
check('two-run hash = sha256(board.json)[:16]', D.meta.runHash === sha256(readFileSync(join(outDir, 'board.json'))).slice(0, 16), D.meta.runHash);
check('21 candidates, 5 origins each', D.L.candidates.length === 21 && D.L.candidates.every((c) => c[15].length === 5));
check('9 launch cells', D.L.launch.cells.length === 9);
check('placebo fields present', D.L.placebo.n === 200 && typeof D.L.placebo.p95 === 'number' && typeof D.L.placebo.shipRate === 'number');
check('fold audit: 5 folds, group-disjoint sizes sum to comps', D.L.foldAudit.length === 5 && D.L.foldAudit.reduce((s, f) => s + f.n, 0) === D.meta.nComp);
check('tier counts sum to board', Object.values(D.L.tiers).reduce((s, v) => s + v, 0) === rows.length);
check('top-10 counts sum to board', D.L.top10.yes + D.L.top10.possible + D.L.top10.no === rows.length);
check('rank intervals within 1..N', rows.every((r) => r.rank_interval[0] >= 1 && r.rank_interval[1] <= rows.length && r.rank_interval[0] <= r.rank && r.rank <= r.rank_interval[1]));

// --- Dossier + screenshots + vendor.
const textBytes = Buffer.byteLength(dossier.text, 'utf8');
check('dossier text <= 65536 bytes', textBytes <= 65536, `${textBytes} bytes`);
check('dossier text holds >=400 spare', textBytes <= 65536 - 400, `${65536 - textBytes} spare`);
check('dossier text has no cut marker', !dossier.text.includes('[Cut at'));
check('dossier <= 1.5 MiB', dossierBytes.length <= 1572864, `${dossierBytes.length} bytes`);
check('exactly 3 screenshots', dossier.images.length === 3, `${dossier.images.length} images`);
let shotsOk = true;
for (const img of dossier.images) {
  const buf = Buffer.from(img.base64, 'base64');
  const dims = pngDims(buf);
  const onDisk = readFileSync(join(outDir, 'screenshots', img.name));
  if (!dims || buf.length > 524288 || Math.max(dims.w, dims.h) > 1440 || Math.min(dims.w, dims.h) < 800 || sha256(buf) !== img.sha256 || !buf.equals(onDisk)) { shotsOk = false; console.log(`  bad shot: ${img.name} ${buf.length} bytes ${dims ? `${dims.w}x${dims.h}` : 'unparsed'}`); }
}
check('screenshots meet size/dimension caps', shotsOk);
const dashFiles = readdirSync(join(outDir, 'dashboard')).filter((f) => statSync(join(outDir, 'dashboard', f)).isFile());
let sourceOk = true;
for (const f of dashFiles) {
  const content = readFileSync(join(outDir, 'dashboard', f), 'utf8');
  if (!dossier.text.includes(content)) { sourceOk = false; console.log(`  dossier text lacks dashboard/${f}`); }
}
check('dossier source = submitted dashboard source', sourceOk, `${dashFiles.length} files`);
const kitVendor = readFileSync(get('kitvendor', ''), 'utf8');
check('vendor byte-identical to kit', sha256(readFileSync(join(repo, 'vendor', 'makefun-board.ts'))) === sha256(kitVendor));

// --- §W10-13/20/22 + §6.4 greps over model/scoring code.
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  let depth = 0, i = src.indexOf('{', at);
  const start = i;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(start, i + 1);
}
const modelFns = ['fitGlobalCurve', 'fitRungModel', 'scoreProtocol', 'featuresOf', 'groupOffsetsFor', 'looForCandidate', 'wfForCandidate', 'selectCandidateInner', 'rankConformal', 'refitCores', 'computeConformalBands', 'looProcedure', 'shippedModelLoo'];
const modelCode = modelFns.map((f) => fnBody(mainTs, f)).join('\n');
check('model fns found', modelFns.every((f) => fnBody(mainTs, f).length > 0), `${modelFns.length} fns`);
const cats = [...new Set(snap.protocols.map((p) => p.category).filter((v) => v != null))];
const catLeaks = cats.filter((c) => modelCode.includes(`'${c}'`) || modelCode.includes(`"${c}"`));
check('zero category values in model/scoring code', catLeaks.length === 0, catLeaks.join(','));
const chains = [...new Set(snap.protocols.flatMap((p) => (Array.isArray(p.chains) ? p.chains : [])))];
const chainLeaks = chains.filter((c) => modelCode.includes(`'${c}'`) || modelCode.includes(`"${c}"`));
check('zero chain names in model/scoring code', chainLeaks.length === 0, chainLeaks.join(','));
check('zero launch terms in model/scoring code', !/launch/i.test(modelCode), modelCode.match(/launch/gi)?.slice(0, 3).join(',') || '');
check('zero string-keyed offset tables', !/offsets\.(get|set)\(\s*['"]/.test(mainTs));
const valueFns = ['featuresOf', 'scoreProtocol', 'computeFarmEconomics', 'assignVerdict', 'launchProb'].map((f) => fnBody(mainTs, f)).join('\n');
const valueCode = valueFns.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('zero category-text in value/net/tier/odds fns', !valueCode.includes('category'));
const sortLine = mainTs.slice(mainTs.indexOf('scored.sort'), mainTs.indexOf('scored.sort') + 200);
check('board sort uses pred/TVL/slug only', /pred/.test(sortLine) && !/launch|margin|pBe/i.test(sortLine), sortLine.trim().slice(0, 80));
const groupMapUses = (mainTs.match(/groupMap\.get\(/g) || []).length;
check('group ids via anonymous map', groupMapUses > 0 && !/category.*offset|offset.*category/i.test(modelCode));

// --- App.js mirror greps.
check('app.js has no http(s)', !appJs.includes('http://') && !appJs.includes('https://'));
check('app.js mirrors ARCHETYPES strings', ['deposit into the campaign pool and keep the receipt token', 'bridge incentives may be capped per wallet'].every((s) => appJs.includes(s)));
check('app.js mirrors gas tiers', appJs.includes("'Hyperliquid L1'") && appJs.includes("'Binance'"));

console.log(failures === 0 ? `\nALL CHECKS PASSED` : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

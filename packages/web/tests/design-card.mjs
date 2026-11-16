// The Design card (src/design-card) in Studio's page, in card mode, against a fake provider: the start screen and its
// examples, opening examples, editing the job (chain roles, pieces, the pieces popup, adding a chain, Undo, Clear), the
// run settings (every control, defaults, ranges), Generate and Stop with progress, status and designs in Outputs with
// the Refold panel hosted and Save all, light and dark, the Studio-editor switch, and that a page that does not mount
// the card is unchanged.
//
// The REST backend is Studio's Python server (ANNOTATION_STUDIO_URL) or, without it, the RFD4-Proteina page's
// in-browser engine (RFD4P_PAGE=<clone>); see design-card-bed.mjs. Examples that build from RCSB entries use
// tests/.cache/rcsb, fetched from files.rcsb.org when missing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startBed, fakeProviderSource } from './design-card-bed.mjs';

const bed = await startBed();
const { page } = bed;
const results = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    results.push([name, 'ok', Date.now() - started]);
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push([name, 'FAILED', Date.now() - started]);
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
    process.exitCode = 1;
  }
};

const text = (selector) => page.locator(selector).innerText();
// The job as the card draws it: "{caption} A[A1–115 fixed] B[50–120 new]", pieces as "name status".
const chainList = () => page.evaluate(() => [...document.querySelectorAll('#rfd4p-chain-list .rfd4p-group')].map((g) => {
  const caption = g.querySelector('.rfd4p-source')?.textContent;
  const chains = [...g.querySelectorAll('.rfd4p-chain')].map((c) => `${c.querySelector('.rfd4p-chain-id').textContent}[${[...c.querySelectorAll('.rfd4p-sub')].map((s) => `${s.querySelector('.rfd4p-sub-name').textContent} ${s.querySelector('.rfd4p-sub-status').textContent}`.trim()).join(', ')}]`);
  return `${caption ? `{${caption}} ` : ''}${chains.join(' ')}`;
}).join(' '));
const mount = (settings) => page.evaluate(({ src, settings }) => {
  const provider = eval(src);
  window.__fake.settingsConfig = settings;
  window.__card = window.atomworksStudio.mountDesignCard(null, provider, {});
  return true;
}, { src: fakeProviderSource, settings });
const startOver = async () => {
  await page.evaluate(() => { window.__card?.destroy(); });
  await bed.open();
};
const openTask = async (id) => {
  await page.locator(`.rfd4p-task-card[data-example="${id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden, null, { timeout: 90000 });
  await page.waitForFunction(() => !document.body.classList.contains('rfd4p-building'));
};
const idle = async () => { await page.waitForFunction(() => !document.querySelector('#rfd4p-design').classList.contains('rfd4p-busy')); await page.waitForTimeout(150); };
const sub = (n) => page.locator('#rfd4p-chain-list .rfd4p-sub').nth(n);
const pop = () => page.locator('.rfd4p-piece-pop:not(.rfd4p-sel-pop)');
const apply = async () => { await pop().getByRole('button', { name: 'Apply' }).click(); await idle(); };

const TITLES = [
  ['unconditional', 'Protein from scratch', 'A new fold of the length you choose'],
  ['blueprint', 'Blueprint', 'A fold drawn as blocks: E-H-E-E-H-E'],
  ['protein_binder', 'Protein binder', 'Bind PD-L1 (PDB 5O45)'],
  ['small_molecule_binder', 'Small-molecule binder', 'A pocket around SAM (PDB 1XVA)'],
  ['motif_scaffolding', 'Motif scaffolding', 'Keep three residues, build the rest (PDB 1QJG)'],
  ['enzyme_design', 'Enzyme', 'A catalytic Asp around Zn and orotate (PDB 1J79)'],
  ['antibody_design', 'Antibody loop', 'Redesign CDR H3 against HER2 (PDB 1N8Z)'],
  ['nanobody', 'Nanobody (VHH)', 'Design CDRs against PD-L1 (PDB 4Z18, 3EAK)'],
  ['inverse_folding', 'Redesign a sequence', 'New sequence for a fixed backbone (PDB 2KL8)'],
  ['partial_diffusion', 'Diversify a structure', 'Variants close to a starting fold (PDB 2KL8)'],
];

// What each example's chain list reads, as the RFD4-Proteina page builds them (compared with the page's own card:
// same DOM, same layout, same popups).
const EXAMPLES = {
  unconditional: "A[250 new]",
  blueprint: "A[6 E · new, 3 C · new, 14 H · new, 3 C · new, 6 E · new, 3 C · new, 6 E · new, 3 C · new, 14 H · new, 3 C · new, 6 E · new]",
  protein_binder: "{PDB 5O45 · A} A[A1–115 backbone rigid · 3 hotspots] B[50–120 new]",
  small_molecule_binder: "A[150 new] {PDB 1XVA · B} B[SAM free]",
  motif_scaffolding: "{PDB 1QJG · A} A[10–20 new, A38 fixed, 15–30 new, A14 fixed, 15–30 new, A99 fixed, 10–20 new]",
  enzyme_design: "{PDB 1J79 · A C B} A[180 new, A250 CG, OD1 fixed · position free] C[ORO N1, C2, N3, C4 fixed] B[ZN fixed]",
  antibody_design: "{PDB 1N8Z · L H T} L[L1–107 rigid] H[H1–98 rigid, H99–109 free, H110–120 rigid] T[T545–580 fixed · 17 hotspots, T591–607 fixed · 15 hotspots]",
  nanobody: "{PDB 4Z18 · A} A[A2–114 backbone rigid · 3 hotspots] {PDB 3EAK · H} H[H1–22 backbone rigid, 11–16 new, H39–52 backbone rigid, 8–12 new, H63–99 backbone rigid, 8–22 new, H118–127 backbone rigid]",
  inverse_folding: "{PDB 2KL8 · A} A[A1–79 structure fixed]",
  partial_diffusion: "{PDB 2KL8 · A} A[A1–79 free]",
};

try {
  // ---- a page that does not mount the card is unchanged -----------------------------------------------------------
  await check('a page without card mode is unchanged', async () => {
    await bed.open('viewer=molstar');
    assert.equal(await page.locator('#rfd4p-studio-card').count(), 0, 'no card');
    assert.equal(await page.evaluate(() => document.body.classList.contains('studio-card-mode')), false);
    assert.equal(await page.locator('#atomworks-design-card-style, #atomworks-design-card-mode-style').count(), 0, 'no card styles');
    assert.equal(await page.locator('#examples-panel').isVisible(), true, "Studio's examples stay");
    assert.equal(await page.locator('.header-actions label.file-button').first().isVisible(), true, 'Open CIF stays');
    assert.equal(await page.locator('footer.status-bar').isVisible(), true, 'the status bar stays');
    const api = await page.evaluate(() => ({ mount: typeof window.atomworksStudio.mountDesignCard, id: window.atomworksStudio.getSessionId(), undo: typeof window.atomworksStudio.undo }));
    assert.deepEqual(api, { mount: 'function', id: null, undo: 'function' });
  });

  // ---- card mode with no engine ------------------------------------------------------------------------------------
  await check('?card=1 with no engine: the card, Generate off', async () => {
    await bed.open('card=1&viewer=molstar');
    assert.equal(await page.locator('#rfd4p-studio-card').count(), 1);
    assert.equal(await page.evaluate(() => document.body.classList.contains('studio-card-mode')), true);
    assert.equal(await page.locator('#predict').isDisabled(), true);
    assert.match(await text('#rfd4p-status-message'), /No design engine/);
    assert.equal(await page.locator('#rfd4p-guide-btn').isHidden(), true, 'no Guide without a provider.guide');
    // Studio's own panels fold away in the simple view.
    assert.equal(await page.locator('#examples-panel').isVisible(), false);
    assert.equal(await page.locator('footer.status-bar').isVisible(), false);
  });

  await check('a host mounts its own card, which replaces that one', async () => {
    await mount();
    assert.equal(await page.locator('#rfd4p-studio-card').count(), 1, 'one card');
    assert.equal(await page.locator('#webgpu-badge').textContent(), 'WebGPU FP16');
    assert.equal(await page.locator('#predict').isDisabled(), false);
    assert.equal(await page.locator('#rfd4p-guide-btn').isVisible(), true, 'the Guide button, now that the provider has guide()');
    assert.equal(await page.locator('#rfd4p-guide-btn').getAttribute('title'), 'How to set up, run and compare designs');
    await page.locator('#rfd4p-guide-btn').click();
    assert.equal(await page.evaluate(() => window.__fake.guided), 1);
    assert.equal(await page.evaluate(() => window.__fake.extras), 1, 'renderExtras ran once');
  });

  await check('guide: { url } is the card\'s own popup over the designer (content, images, links, Escape, ×)', async () => {
    const origin = new URL(bed.base).origin;
    let fetches = 0;
    const fixture = (name) => readFileSync(new URL(`./fixtures/guide/${name}`, import.meta.url));
    await page.route(`${origin}/__guide/**`, (route) => {
      const path = new URL(route.request().url()).pathname.replace('/__guide/', '');
      fetches += 1;
      route.fulfill(path === 'index.html' ? { contentType: 'text/html', body: fixture('index.html') }
        : { contentType: 'image/svg+xml', body: fixture(path) });
    });
    await page.evaluate(() => window.__card?.destroy());
    await bed.open('card=1&viewer=molstar');
    await page.evaluate(({ src }) => {
      const provider = eval(src);
      provider.guide = { url: '/__guide/index.html' };
      window.__card = window.atomworksStudio.mountDesignCard(null, provider, {});
    }, { src: fakeProviderSource });
    await page.locator('#rfd4p-guide-btn').click();
    const dialog = page.locator('dialog.rfd4p-guide');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('h1').textContent(), 'Sample guide');
    assert.equal(await dialog.locator('.rfd4p-guide-body').count(), 1);
    assert.equal(await page.evaluate(() => window.__fake.guided), 0, 'the card did not call a guide function');
    assert.equal(await dialog.locator('a', { hasText: 'Back to the designer' }).count(), 0, '"back to the designer" is removed');
    assert.equal(await page.evaluate(() => window.__guideScriptRan), undefined, 'scripts of the guide do not run');
    const img = dialog.locator('img');
    assert.equal(await img.getAttribute('src'), `${origin}/__guide/img/sample.svg`);
    await page.waitForFunction(() => document.querySelector('dialog.rfd4p-guide img').complete && document.querySelector('dialog.rfd4p-guide img').naturalWidth > 0);
    const external = dialog.locator('a', { hasText: 'full documentation' });
    assert.equal(await external.getAttribute('href'), 'https://example.org/docs');
    assert.equal(await external.getAttribute('target'), '_blank');
    assert.equal(await dialog.locator('a', { hasText: 'another page' }).getAttribute('href'), `${origin}/__guide/other.html`);
    await dialog.locator('nav.toc a', { hasText: 'Run' }).click();
    assert.equal(await dialog.isVisible(), true, 'a contents link scrolls the popup, it does not leave');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false, 'Escape closes it');
    await page.locator('#rfd4p-guide-btn').click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.rfd4p-guide-x').click();
    assert.equal(await dialog.isVisible(), false, 'the × closes it');
    assert.equal(fetches, 2, 'the page and its image, fetched once');
    await page.evaluate(() => window.__card.destroy());
    assert.equal(await page.locator('dialog.rfd4p-guide').count(), 0, 'destroy removes the popup');
    await page.unroute(`${origin}/__guide/**`);
    await bed.open('card=1&viewer=molstar');
    await mount();
  });

  // ---- the start screen ---------------------------------------------------------------------------------------------
  await check('start screen: parts, examples with their titles and descriptions', async () => {
    assert.equal(await page.locator('#rfd4p-start').isVisible(), true);
    assert.equal(await page.locator('#rfd4p-design').isHidden(), true);
    assert.equal(await page.locator('#rfd4p-run-settings').isHidden(), true, 'run settings wait for a job');
    assert.deepEqual(await page.locator('#rfd4p-start-seq, #rfd4p-start-pdb, #rfd4p-start-lig').allTextContents(), ['+ new', '+ pdb', '+ lig']);
    assert.equal(await page.locator('#rfd4p-start-seq').getAttribute('title'), 'A new chain for the model to design (sequence and structure), 60–100 residues to start');
    assert.equal(await page.locator('#rfd4p-start-pdb').getAttribute('title'), 'Chains from a PDB entry or file, kept as they are (e.g. a target to bind)');
    assert.equal(await page.locator('#rfd4p-start-lig').getAttribute('title'), 'A small molecule by its PDB code (HEM, ATP, ZN…)');
    assert.equal(await text('.rfd4p-section-title'), 'Examples');
    const cards = await page.locator('#rfd4p-task-grid .rfd4p-task-card').evaluateAll((els) => els.map((e) => [e.dataset.example, e.querySelector('strong').textContent, e.querySelector('span').textContent]));
    assert.deepEqual(cards, TITLES);
    assert.deepEqual(await page.locator('#rfd4p-tabs button').allTextContents(), ['Input', 'Outputs']);
    assert.equal(await page.locator('#rfd4p-tabs button').nth(1).isDisabled(), true, 'Outputs waits for designs');
    assert.equal(await page.locator('#rfd4p-new').isHidden(), true, 'no Clear on the start screen');
    assert.equal(await page.locator('#rfd4p-undo').isHidden(), true);
    assert.equal(await page.locator('#rfd4p-advanced').isChecked(), false);
    assert.equal(await page.locator('label.rfd4p-advanced-toggle').getAttribute('title'), "Edit with AtomWorks Studio's own editor in place of the card's: every condition, bonds, analysis, measurements, query bar");
  });

  await check('start screen: + pdb and + lig forms', async () => {
    await page.locator('#rfd4p-start-pdb').click();
    const form = page.locator('#rfd4p-start + form.rfd4p-add-structure, #rfd4p-start form.rfd4p-add-structure').first();
    assert.equal(await form.isVisible(), true);
    assert.equal(await form.locator('strong').first().textContent(), 'Add a structure');
    assert.equal(await form.locator('input[aria-label="PDB ID and chains"]').getAttribute('placeholder'), 'ID, then chains: 5O45 A');
    assert.match(await form.locator('.muted').first().textContent(), /^Its ID in the PDB, then any chains to keep/);
    await form.locator('input[aria-label="PDB ID and chains"]').fill('hello');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    assert.match(await text('#rfd4p-start form .rfd4p-add-status'), /Enter a 4-character PDB ID/);
    await form.locator('button.rfd4p-pop-x').click();
    assert.equal(await form.isHidden(), true, 'the × closes it');
    await page.locator('#rfd4p-start-lig').click();
    const lig = page.locator('#rfd4p-start form.rfd4p-add-structure').filter({ hasText: 'Add a ligand' });
    assert.equal(await lig.locator('input').getAttribute('placeholder'), 'Code, e.g. HEM');
    assert.equal(await lig.locator('input').getAttribute('maxlength'), '5');
    await lig.locator('button.rfd4p-pop-x').click();
    assert.equal(await lig.count(), 0);
  });

  await check('start screen: + new opens a free chain of 60–100', async () => {
    await page.locator('#rfd4p-start-seq').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden);
    assert.equal(await chainList(), 'A[60–100 new]');
    assert.equal(await page.locator('#rfd4p-run-settings').isVisible(), true);
    assert.equal(await page.locator('#rfd4p-start').isHidden(), true);
    assert.equal(await page.locator('#rfd4p-examples').isHidden(), true, 'the examples are for the start screen only');
    // Undo is off: nothing has been changed since it opened.
    assert.equal(await page.locator('#rfd4p-undo').isDisabled(), true);
    // Clear shows the start screen; Undo there brings the job back.
    await page.locator('#rfd4p-new').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-start').hidden);
    assert.equal(await page.locator('#rfd4p-undo').isEnabled(), true);
    assert.equal(await page.locator('#rfd4p-new').isHidden(), true);
    await page.locator('#rfd4p-undo').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden);
    assert.equal(await chainList(), 'A[60–100 new]');
  });

  await check('start screen: + lig builds a ligand from its dictionary entry', async () => {
    await page.locator('#rfd4p-new').click();
    await page.locator('#rfd4p-start-lig').click();
    const lig = page.locator('#rfd4p-start form.rfd4p-add-structure').filter({ hasText: 'Add a ligand' });
    await lig.locator('input').fill('HEM');
    await lig.getByRole('button', { name: 'Add' }).click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden, null, { timeout: 30000 });
    assert.equal(await chainList(), '{HEM · L} L[HEM free]');
    assert.ok(bed.rcsb.requests.some((u) => u.endsWith('/ligands/view/HEM.cif')), 'its entry was fetched from RCSB');
  });

  await check('Protein from scratch opens Studio\'s own example', async () => {
    await page.locator('#rfd4p-new').click();
    await openTask('unconditional');
    assert.equal(await chainList(), EXAMPLES.unconditional);
    assert.equal(await page.locator('#predict').isEnabled(), true);
  });

  // ---- an example built from its PDB entry -------------------------------------------------------------------------
  await check('Protein binder is built from PDB 5O45 and reads as a binder', async () => {
    await page.locator('#rfd4p-new').click();
    await openTask('protein_binder');
    assert.equal(await chainList(), EXAMPLES.protein_binder);
    assert.equal(await page.locator('#rfd4p-fetch-status').textContent(), '');
    assert.equal(await page.locator('.rfd4p-source').first().textContent(), 'PDB 5O45 · A');
    assert.equal(await page.locator('#rfd4p-task-label').textContent(), 'Binder design', 'the task is read, kept for the guide, not shown');
    assert.equal(await page.locator('#rfd4p-task-label').isHidden(), true);
    assert.ok(bed.rcsb.requests.some((u) => u.endsWith('/download/5O45.cif')));
  });

  // ---- editing the job -------------------------------------------------------------------------------------------
  await check('a piece popup: its fields, a change, Undo', async () => {
    await sub(0).locator('.rfd4p-sub-open').click();
    await pop().waitFor({ state: 'visible' });
    assert.equal(await pop().locator('.rfd4p-pop-title strong').textContent(), 'A1–115');
    assert.equal(await pop().locator('select[aria-label="Structure"]').inputValue(), 'rigid');
    assert.deepEqual(await pop().locator('select[aria-label="Structure"] option').allTextContents(), ['fixed', 'rigid', 'free']);
    assert.equal(await pop().locator('select[aria-label="Atoms"]').inputValue(), 'backbone');
    assert.equal(await pop().locator('select[aria-label="Sequence"]').inputValue(), 'fixed');
    assert.equal(await pop().locator('input[aria-label="Hotspots"]').inputValue(), 'A40(CG,OH), A99(CG,SD), A107(CD2,OH)');
    assert.equal(await pop().locator('input[aria-label="From residue"]').inputValue(), '1');
    assert.equal(await pop().locator('input[aria-label="To residue"]').inputValue(), '115');
    assert.equal(await pop().locator('.rfd4p-crop').count(), 1, 'the crop bar');
    assert.equal(await pop().locator('summary').textContent(), 'More');
    await pop().locator('select[aria-label="Structure"]').selectOption('fixed');
    await pop().locator('select[aria-label="Atoms"]').selectOption('all');
    await apply();
    assert.equal(await sub(0).locator('.rfd4p-sub-status').textContent(), 'fixed · 3 hotspots');
    assert.equal(await page.locator('#rfd4p-undo').isEnabled(), true);
    // Undo goes back through what the popup did (leaving the rigid body and holding the atoms are separate edits).
    await page.locator('#rfd4p-undo').click();
    await idle();
    await page.waitForFunction(() => document.querySelector('.rfd4p-sub-status')?.textContent !== 'fixed · 3 hotspots');
    assert.equal(await page.evaluate(() => window.atomworksStudio.getSelection().length), 0, 'closing the popup lets the residues go');
    // Start again from the example, for the tests that follow.
    await page.locator('#rfd4p-new').click();
    await openTask('protein_binder');
    assert.equal(await chainList(), EXAMPLES.protein_binder);
    assert.equal(await page.locator('#rfd4p-undo').isDisabled(), true, 'Undo goes no further back than where the example opened');
  });

  await check('a piece popup: cropping the residues rebuilds the chain from its plan', async () => {
    await sub(0).locator('.rfd4p-sub-open').click();
    await pop().locator('input[aria-label="To residue"]').fill('100');
    await apply();
    assert.equal(await sub(0).locator('.rfd4p-sub-name').textContent(), 'A1–100');
    await page.locator('#rfd4p-undo').click();
    await idle();
    await page.waitForFunction(() => document.querySelector('.rfd4p-sub-name')?.textContent === 'A1–115');
  });

  await check('adding a chain, a block of new residues, and removing them', async () => {
    await page.locator('#rfd4p-add-seq').click();
    await idle();
    assert.equal(await page.locator('#rfd4p-chain-list .rfd4p-chain').count(), 3, 'a third chain');
    assert.match(await chainList(), /C\[60–100 new\]$/);
    // The "+" inside chain B adds a block of new residues next to the existing one.
    await page.locator('#rfd4p-chain-list .rfd4p-chain').nth(1).locator('.rfd4p-slot').last().click();
    await idle();
    assert.equal(await page.locator('#rfd4p-chain-list .rfd4p-chain').nth(1).locator('.rfd4p-sub').count(), 2, 'two blocks');
    // Remove chain C with its × and the extra block with its ×.
    await page.locator('#rfd4p-chain-list .rfd4p-chain').nth(2).locator('.rfd4p-x').first().click();
    await idle();
    assert.equal(await page.locator('#rfd4p-chain-list .rfd4p-chain').count(), 2);
    await page.locator('#rfd4p-chain-list .rfd4p-chain').nth(1).locator('.rfd4p-sub .rfd4p-x').last().click();
    await idle();
    assert.equal(await chainList(), EXAMPLES.protein_binder);
  });

  await check('new residues: a popup with Length and Shape, the length changes', async () => {
    await sub(1).locator('.rfd4p-sub-open').click();
    assert.equal(await pop().locator('.rfd4p-pop-title strong').textContent(), 'Chain B, new residues');
    assert.equal(await pop().locator('input[aria-label="Fewest new residues"]').inputValue(), '50');
    assert.deepEqual(await pop().locator('select[aria-label="Shape"] option').allTextContents(), ['H helix', 'E strand', 'C loop', 'free']);
    await pop().locator('input[aria-label="Fewest new residues"]').fill('40');
    await pop().locator('input[aria-label="Most new residues"]').fill('80');
    await pop().locator('select[aria-label="Shape"]').selectOption('1');
    await apply();
    assert.equal(await sub(1).locator('.rfd4p-sub-name').textContent(), '40–80');
    assert.equal(await sub(1).locator('.rfd4p-sub-status').textContent(), 'H · new');
  });

  await check('a chain popup: name and order', async () => {
    await page.locator('#rfd4p-chain-list .rfd4p-chain-id').nth(1).click();
    assert.equal(await pop().locator('.rfd4p-pop-title strong').textContent(), 'Chain B');
    await pop().locator('input[aria-label="Chain name"]').fill('Z');
    await apply();
    assert.deepEqual(await page.locator('#rfd4p-chain-list .rfd4p-chain-id').allTextContents(), ['A', 'Z']);
    await page.locator('#rfd4p-chain-list .rfd4p-chain-id').nth(1).click();
    await pop().locator('select[aria-label="Chain order"]').selectOption('0');
    await apply();
    assert.deepEqual(await page.locator('#rfd4p-chain-list .rfd4p-chain-id').allTextContents(), ['Z', 'A']);
  });

  await check('removing the last thing of the job is Clear', async () => {
    await page.locator('.rfd4p-source-x').click();
    await idle();
    assert.equal(await page.locator('#rfd4p-chain-list .rfd4p-chain').count(), 1, 'the target is gone');
    // The one chain left: its × clears the job.
    await page.locator('#rfd4p-chain-list .rfd4p-chain').first().locator('.rfd4p-x').first().click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-start').hidden);
  });

  // ---- run settings ---------------------------------------------------------------------------------------------------
  await check('run settings: every control, its defaults and ranges', async () => {
    await page.locator('#rfd4p-start-seq').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden);
    const read = (sel) => page.locator(sel).evaluate((e) => ({ v: e.value, min: e.min, max: e.max, step: e.step, title: e.title }));
    assert.deepEqual(await read('#samples-input'), { v: '1', min: '1', max: '8', step: '1', title: 'How many designs to make, one after another' });
    assert.equal(await page.locator('#samples-input').getAttribute('aria-label'), 'How many designs');
    assert.equal(await text('#predict'), 'Generate design');
    assert.equal(await text('#thinking-radio-group legend'), 'Thinking');
    assert.equal(await page.locator('#thinking-radio-group legend').getAttribute('title'), 'Extra recycling passes: slower, sometimes better designs');
    assert.deepEqual(await page.locator('#thinking-radio-group label').allTextContents(), ['none', 'low', 'med', 'high']);
    assert.equal(await page.locator('input[name="thinking-radio"]:checked').getAttribute('value'), 'none');
    assert.equal(await text('#sampling-accordion summary'), 'More settings');
    assert.equal(await page.locator('#sampling-accordion').evaluate((e) => e.open), false);
    await page.locator('#sampling-accordion summary').click();
    // seed: random, in [0, 1e6)
    const seed = Number(await page.locator('#seed-input').inputValue());
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 1e6);
    assert.deepEqual(await read('#seed-input'), { v: String(seed), min: '0', max: '4294967295', step: '1', title: '' });
    assert.equal(await page.locator('label[for="seed-input"]').getAttribute('title'), 'Same seed and settings give the same design. A new random seed is drawn after each run unless you type one.');
    assert.equal(await page.locator('#seed-random').getAttribute('title'), 'New random seed');
    assert.equal(await page.locator('#seed-random').textContent(), '🎲');
    // partial diffusion
    assert.equal(await page.locator('#partial-diffusion').isChecked(), false);
    assert.equal(await page.locator('#partial-diffusion-percent').isDisabled(), true);
    assert.deepEqual(await read('#partial-diffusion-percent'), { v: '40', min: '1', max: '100', step: '1', title: '' });
    assert.equal(await page.locator('.rfd4p-partial-setting').getAttribute('title'), 'Partial diffusion: start part of the way from the input structure instead of from noise. About 40% is a good start; higher changes it more. Needs every residue defined, with coordinates.');
    assert.equal(await text('.rfd4p-partial-setting label'), 'Start from the input structure');
    // K sliders
    assert.deepEqual(await read('#backbone-k'), { v: '16', min: '1', max: '20', step: '0.1', title: '' });
    assert.deepEqual(await read('#backbone-k-num'), { v: '16', min: '1', max: '20', step: '0.1', title: '' });
    assert.deepEqual(await read('#latent-k'), { v: '4', min: '1', max: '6', step: '0.1', title: '' });
    assert.deepEqual(await read('#latent-k-num'), { v: '4', min: '1', max: '6', step: '0.1', title: '' });
    assert.equal(await text('.rfd4p-sampling-note'), 'Lower K = higher temperature and more variation. Defaults give stronger low-temperature sampling.');
    assert.equal(await text('label[for="backbone-k"] .rfd4p-slider-head span'), 'Backbone K');
    assert.equal(await text('label[for="latent-k"] .rfd4p-slider-head span'), 'Latents (sequence) K');
    assert.equal(await page.locator('#early-stop').isChecked(), true);
    assert.equal(await page.locator('label[for="early-stop"]').getAttribute('title'), 'Stop once the structure and sequence have both stopped changing for 5 steps (identical sequence, under 0.1 Å from a full run in testing)');
    assert.equal(await text('label[for="early-stop"]'), 'Early stop when converged');
  });

  await check('run settings: sliders and their numbers follow each other, the dice, partial diffusion', async () => {
    await page.locator('#backbone-k').fill('7.5');
    assert.equal(await page.locator('#backbone-k-num').inputValue(), '7.5');
    await page.locator('#latent-k-num').fill('2.5');
    assert.equal(await page.locator('#latent-k').inputValue(), '2.5');
    // typing a seed pins it; emptying it draws a new one; the dice draws one too.
    await page.locator('#seed-input').fill('12345');
    await page.locator('#seed-random').click();
    const diced = await page.locator('#seed-input').inputValue();
    assert.notEqual(diced, '12345');
    assert.equal(await page.evaluate(() => window.__card.settings().seed), Number(diced));
    // partial diffusion: ticking enables the percent and opens the settings; with nothing designed it frees every chain
    await page.locator('#sampling-accordion summary').click();
    assert.equal(await page.locator('#sampling-accordion').evaluate((e) => e.open), false);
    // (as an example's recipe ticks it, with the settings folded)
    await page.locator('#partial-diffusion').evaluate((box) => { box.checked = true; box.dispatchEvent(new Event('change')); });
    assert.equal(await page.locator('#sampling-accordion').evaluate((e) => e.open), true, 'on, it is never out of sight');
    assert.equal(await page.locator('#partial-diffusion-percent').isEnabled(), true);
    await page.locator('#partial-diffusion-percent').fill('65');
    assert.equal(await page.locator('#partial-diffusion-percent-num').inputValue(), '65');
    assert.equal(await page.evaluate(() => window.__card.settings().partialDiffusion), 65);
    await page.locator('#partial-diffusion').uncheck();
    assert.equal(await page.evaluate(() => window.__card.settings().partialDiffusion), null);
    // thinking
    await page.locator('#thinking-radio-group label', { hasText: 'med' }).click();
    assert.equal(await page.evaluate(() => window.__card.settings().thinking), 'medium');
    await page.locator('#thinking-radio-group label', { hasText: 'none' }).click();
  });

  // ---- generate and stop -----------------------------------------------------------------------------------------
  await check('Generate: a run through the provider, with progress, status and designs in Outputs', async () => {
    await page.locator('#seed-input').fill('777');
    await page.locator('#samples-input').fill('2');
    await page.evaluate(() => { window.__fake.hold = true; });
    await page.locator('#predict').click();
    await page.waitForFunction(() => document.querySelector('#predict').textContent.startsWith('Stop'));
    await page.waitForFunction(() => window.__fake.waiting);
    assert.equal(await text('#predict'), 'Stop · design 1 of 2 · step 1/3');
    assert.equal(await page.locator('#predict').evaluate((e) => e.classList.contains('rfd4p-running') && e.classList.contains('secondary')), true);
    assert.match(await page.locator('#predict').evaluate((e) => e.style.getPropertyValue('--rfd4p-progress')), /^1[0-9]\.\d%$|^16\.7%$/);
    const request = await page.evaluate(() => window.__fake.requests[0]);
    assert.deepEqual(request.settings, { samples: 2, thinking: 'none', seed: 777, partialDiffusion: null, backboneK: 7.5, latentK: 2.5, earlyStop: true });
    assert.equal(request.task, 'unconditional');
    assert.equal(request.revision >= 0, true);
    await page.evaluate(() => { window.__fake.hold = false; window.__fake.waiting(); });
    await page.waitForFunction(() => document.querySelector('#predict').textContent === 'Generate design', null, { timeout: 30000 });
    assert.match(await text('#rfd4p-status-message'), /^Generated 2 fake design\(s\) from input revision \d+\.$/);
    assert.equal(await page.locator('#generation-status').isVisible(), true);
    // The designs: Outputs (2), the table, Refold box, Save all.
    assert.deepEqual(await page.locator('#rfd4p-tabs button').allTextContents(), ['Input', 'Outputs (2)']);
    assert.equal(await page.locator('#rfd4p-job').getAttribute('data-tab'), 'outputs', "a run's first design is shown");
    assert.equal(await page.locator('#design-results').isVisible(), true);
    assert.deepEqual(await page.locator('.refold-dtable tbody tr .refold-dt-name').allTextContents(), ['777', '778']);
    assert.equal(await page.locator('.refold-dtable tbody tr:first-child input:checked').count(), 1, 'the first design is shown');
    assert.equal(await page.locator('#refold-box').isVisible(), true, "Studio's Refold panel, hosted");
    assert.equal(await page.locator('#download-all-btn').textContent(), 'Save all (.zip)');
    assert.equal(await page.locator('#download-all-btn').getAttribute('title'), 'Input, every design with its trajectory, every refold, and a summary table');
    // The seed was typed: it stays for the next run.
    assert.equal(await page.locator('#seed-input').inputValue(), '777');
    assert.equal(await page.evaluate(() => document.querySelector('#predict').disabled), false);
  });

  await check('Generate again with the input unchanged joins the designs; an edit starts over', async () => {
    await page.locator('#rfd4p-tabs button', { hasText: 'Input' }).click();
    await page.waitForFunction(() => document.querySelector('#rfd4p-job').dataset.tab === 'input');
    await page.locator('#samples-input').fill('1');
    await page.locator('#seed-input').fill('900');
    await page.locator('#predict').click();
    await page.waitForFunction(() => document.querySelectorAll('.refold-dtable tbody tr').length === 3, null, { timeout: 30000 });
    assert.deepEqual(await page.locator('.refold-dtable tbody tr .refold-dt-name').allTextContents(), ['777', '778', '900']);
    // An edit to the input, then Generate: the list starts over.
    await page.locator('#rfd4p-tabs button', { hasText: 'Input' }).click();
    await page.waitForFunction(() => document.querySelector('#rfd4p-job').dataset.tab === 'input');
    await sub(0).locator('.rfd4p-sub-open').click();
    await pop().locator('input[aria-label="Fewest new residues"]').fill('70');
    await apply();
    await page.locator('#seed-input').fill('901');
    await page.locator('#predict').click();
    await page.waitForFunction(() => document.querySelectorAll('.refold-dtable tbody tr').length === 1, null, { timeout: 30000 });
    assert.deepEqual(await page.locator('.refold-dtable tbody tr .refold-dt-name').allTextContents(), ['901']);
  });

  await check('Refold panel hosted: a refold of a design shows its numbers', async () => {
    await page.locator('#refold-model').selectOption('openbind0');
    await page.locator('#refold-btn').click();
    await page.waitForFunction(() => /1\.2/.test(document.querySelector('.refold-dtable tbody tr')?.textContent ?? ''), null, { timeout: 20000 });
    assert.match(await text('.refold-dtable tbody tr'), /901[\s\S]*1\.2[\s\S]*90/);
  });

  await check('Save all (.zip): input, designs, summary', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-all-btn').click()]);
    assert.match(download.suggestedFilename(), /^rfd4p-results-\d{8}-\d{4}\.zip$/);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(path);
    // Central directory of the store-only zip.
    const names = [];
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let at = bytes.readUInt32LE(eocd + 16);
    for (let i = 0, n = bytes.readUInt16LE(eocd + 10); i < n; i += 1) {
      const nameLen = bytes.readUInt16LE(at + 28);
      names.push(bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
      at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    const folder = names[0].split('/')[0];
    assert.deepEqual(names.map((n) => n.slice(folder.length + 1)).sort(),
      ['README.txt', 'design-1.cif', 'design-1-refold-openbind0.cif', 'input.cif', 'summary.csv', 'summary.json'].sort());
    const handle = await page.evaluate(() => { const z = window.__card.zip(); return z && z.bytes.length > 100 && /\.zip$/.test(z.name); });
    assert.equal(handle, true, 'the handle gives the same file');
  });

  await check('Stop ends a run with the input unchanged; a failing provider says why', async () => {
    await page.locator('#rfd4p-tabs button', { hasText: 'Input' }).click();
    await page.waitForFunction(() => document.querySelector('#rfd4p-job').dataset.tab === 'input');
    await page.evaluate(() => { window.__fake.hold = true; window.__fake.waiting = null; });
    await page.locator('#predict').click();
    await page.waitForFunction(() => window.__fake.waiting);
    assert.match(await text('#predict'), /^Stop/);
    await page.locator('#predict').click();
    await page.waitForFunction(() => document.querySelector('#predict').textContent === 'Generate design');
    assert.equal(await text('#rfd4p-status-message'), 'Generation stopped. Your input is unchanged.');
    assert.equal(await page.locator('#rfd4p-status-message').evaluate((e) => e.classList.contains('error')), false);
    assert.equal(await page.evaluate(() => window.__fake.aborted >= 1), true);
    await page.evaluate(() => {
      window.__fake.hold = false;
      const original = window.__fakeProvider.generate;
      window.__fakeProvider.generate = async () => { throw new Error('out of memory'); };
      window.__restoreGenerate = () => { window.__fakeProvider.generate = original; };
    });
    await page.locator('#predict').click();
    await page.waitForFunction(() => document.querySelector('#rfd4p-status-message').classList.contains('error'));
    assert.equal(await text('#rfd4p-status-message'), 'Generation failed. out of memory Your input is unchanged.');
    await page.evaluate(() => window.__restoreGenerate());
  });

  // ---- light and dark ---------------------------------------------------------------------------------------------------
  await check('light and dark: the switch, the card follows, remembered', async () => {
    const bg = () => page.locator('#rfd4p-job').evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.equal(await page.evaluate(() => document.body.dataset.hostTheme), 'dark');
    assert.equal(await page.locator('#rfd4p-theme-btn').getAttribute('title'), 'Light mode');
    const dark = await bg();
    await page.locator('#rfd4p-theme-btn').click();
    assert.equal(await page.evaluate(() => document.body.dataset.hostTheme), 'light');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.hostTheme), 'light');
    assert.equal(await page.locator('#rfd4p-theme-btn').textContent(), '☾');
    assert.equal(await page.locator('#rfd4p-theme-btn').getAttribute('title'), 'Dark mode');
    const light = await bg();
    assert.notEqual(dark, light);
    assert.equal(light, 'rgb(255, 255, 255)');
    assert.equal(dark, 'rgb(35, 36, 40)');
    assert.equal(await page.evaluate(() => window.__card.theme()), 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('rfd4p.theme')), 'light');
    // Mol*'s background follows Studio's setTheme.
    assert.equal(await page.locator('#viewer').evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)');
    await page.locator('#rfd4p-theme-btn').click();
    assert.equal(await bg(), dark);
    await page.evaluate(() => window.__card.setTheme('light'));
    assert.equal(await bg(), light);
    await page.evaluate(() => window.__card.setTheme('dark'));
  });

  // ---- the Studio editor -------------------------------------------------------------------------------------------------
  await check('Studio editor: swaps in Studio\'s own editor and back', async () => {
    assert.equal(await page.locator('.editor-document').isVisible(), false, "Studio's Structure card is folded away");
    assert.equal(await page.locator('#rfd4p-chain-list').isVisible(), true);
    await page.locator('#rfd4p-advanced').check();
    assert.equal(await page.evaluate(() => document.body.classList.contains('rfd4p-advanced')), true);
    assert.equal(await page.locator('.editor-document').isVisible(), true);
    assert.equal(await page.locator('#rfd4p-chain-list').isHidden(), true, "the card's editor goes");
    assert.equal(await page.locator('#examples-panel').isHidden(), true, "the card's examples do what Studio's do");
    assert.equal(await page.locator('footer.status-bar').isVisible(), true, "Studio's status bar returns");
    await page.locator('#rfd4p-advanced').uncheck();
    assert.equal(await page.locator('.editor-document').isVisible(), false);
    assert.equal(await page.locator('#rfd4p-chain-list').isVisible(), true);
  });

  // ---- settings the engine does not take ----------------------------------------------------------------------------------
  await check('a provider that takes fewer settings: those controls are hidden and left out of the request', async () => {
    await page.evaluate(() => window.__card.destroy());
    await bed.open('card=1&viewer=molstar');
    await mount({ samples: false, thinking: { options: ['none', 'high'], default: 'high' }, seed: false, partialDiffusion: false,
      backboneK: { min: 2, max: 10, step: 0.5, default: 5 }, latentK: false, earlyStop: false });
    await page.locator('#rfd4p-start-seq').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden);
    assert.equal(await page.locator('#samples-input').isHidden(), true);
    assert.deepEqual(await page.locator('#thinking-radio-group label').allTextContents(), ['none', 'high']);
    assert.equal(await page.locator('input[name="thinking-radio"]:checked').getAttribute('value'), 'high');
    await page.locator('#sampling-accordion summary').click();
    assert.equal(await page.locator('.rfd4p-settings-row').isHidden(), true, 'no seed row');
    assert.equal(await page.locator('.rfd4p-partial-setting').isHidden(), true);
    assert.equal(await page.locator('label[for="latent-k"]').isHidden(), true);
    assert.equal(await page.locator('label[for="early-stop"]').isHidden(), true);
    assert.deepEqual(await page.locator('#backbone-k').evaluate((e) => [e.min, e.max, e.step, e.value]), ['2', '10', '0.5', '5']);
    await page.locator('#predict').click();
    await page.waitForFunction(() => window.__fake.requests.length === 1, null, { timeout: 30000 });
    assert.deepEqual(await page.evaluate(() => window.__fake.requests[0].settings), { thinking: 'high', backboneK: 5 });
  });

  await check('a provider with nothing for More settings hides it; engine.disabled turns Generate off', async () => {
    await page.evaluate(() => window.__card.destroy());
    await bed.open('card=1&viewer=molstar');
    await mount({ seed: false, partialDiffusion: false, backboneK: false, latentK: false, earlyStop: false });
    await page.locator('#rfd4p-start-seq').click();
    await page.waitForFunction(() => !document.querySelector('#rfd4p-design').hidden);
    assert.equal(await page.locator('#sampling-accordion').isHidden(), true);
    await page.evaluate(() => window.__card.setEngine({ badge: 'No WebGPU', disabled: 'This browser has no WebGPU, which designs need.' }));
    assert.equal(await page.locator('#webgpu-badge').textContent(), 'No WebGPU');
    assert.equal(await page.locator('#predict').isDisabled(), true);
    assert.equal(await text('#rfd4p-status-message'), 'This browser has no WebGPU, which designs need.');
    await page.evaluate(() => window.__card.setEngine({ badge: 'WebGL2', disabled: null }));
    assert.equal(await page.locator('#predict').isDisabled(), false);
  });

  // ---- the remaining examples ----------------------------------------------------------------------------------------------
  for (const [id, title] of TITLES.slice(1).filter(([id]) => id !== 'protein_binder')) {
    await check(`example ${id} (${title}) is built and readable`, async () => {
      await page.evaluate(() => window.__card.destroy());
      await bed.open('card=1&viewer=molstar');
      await mount();
      await openTask(id);
      const list = await chainList();
      assert.ok(list.length > 0 && !/Edit failed/.test(await text('#rfd4p-warnings')), `${id}: ${list}`);
      assert.equal(list, EXAMPLES[id]);
      assert.equal(await page.locator('#partial-diffusion').isChecked(), id === 'partial_diffusion', 'Diversify ticks partial diffusion');
      assert.equal(await page.locator('#rfd4p-fetch-status').textContent(), '');
      assert.equal(await page.locator('#predict').isEnabled(), true);
      // The input as saved holds no hydrogen without coordinates (AtomWorks adds them when it opens an entry; the page's
      // engine never does, and a server's card sessions must not either).
      const hydrogensWithoutCoordinates = await page.evaluate(async () => {
        const text = await (await fetch(`/api/sessions/${window.atomworksStudio.getSessionId()}/cif`)).text();
        const lines = text.split('\n');
        const first = lines.findIndex((l) => l.startsWith('_atom_site.'));
        const columns = [];
        for (let i = first; lines[i]?.startsWith('_atom_site.'); i += 1) columns.push(lines[i].trim().slice('_atom_site.'.length));
        const [element, x] = [columns.indexOf('type_symbol'), columns.indexOf('Cartn_x')];
        return lines.filter((l) => /^(ATOM|HETATM)\s/.test(l)).map((l) => l.trim().split(/\s+/)).filter((f) => ['H', 'D'].includes(f[element]) && !Number.isFinite(Number(f[x]))).length;
      });
      assert.equal(hydrogensWithoutCoordinates, 0, `${id}: hydrogens without coordinates in the input`);
    });
  }

  // ---- the card in a frame of a host: requests cross with postMessage ----------------------------------------------------
  await check('in an iframe the card asks its parent for the engine and runs through it', async () => {
    const origin = new URL(bed.base).origin;
    await page.route(`${origin}/__host`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0">
      <iframe id="studio" style="width:1400px;height:900px;border:0" src="/?embed=1&card=1&viewer=molstar&parent_origin=${encodeURIComponent(origin)}"></iframe>
      <script>
        window.__log = [];
        const frame = document.getElementById('studio');
        const send = (m) => frame.contentWindow.postMessage({ source: 'atomworks-design-host', ...m }, '${origin}');
        window.addEventListener('message', (ev) => {
          const m = ev.data;
          if (ev.source !== frame.contentWindow || m?.source !== 'atomworks-studio' || m.channel !== 'design-card') return;
          window.__log.push(m.type);
          if (m.type === 'hello') send({ type: 'config', engine: { badge: 'Frame engine' }, settings: { samples: { max: 3 }, thinking: false }, guide: true,
            refold: { models: [{ id: 'openbind0' }] } });
          if (m.type === 'generate') {
            window.__request = m.request;
            if (m.request.settings.seed === 13) { send({ type: 'error', id: m.id, message: 'boom', userMessage: 'The server said no.' }); return; }
            send({ type: 'status', id: m.id, text: 'Queued…' });
            send({ type: 'progress', id: m.id, fraction: 0.5, label: 'step 30/60' });
            send({ type: 'design', id: m.id, design: { name: String(m.request.settings.seed), cif: m.request.cif, kind: 'monomer', seed: m.request.settings.seed } });
            send({ type: 'done', id: m.id, result: { message: 'Done by the host.' } });
          }
          if (m.type === 'guide') window.__guided = true;
        });
      </script></body>` }));
    await page.goto(`${origin}/__host`);
    const frame = page.frameLocator('#studio');
    await frame.locator('#webgpu-badge').waitFor({ state: 'attached', timeout: 60000 });
    assert.equal(await frame.locator('#webgpu-badge').textContent(), 'Frame engine');
    assert.equal(await frame.locator('#samples-input').getAttribute('max'), '3');
    assert.equal(await frame.locator('#thinking-radio-group').isHidden(), true, 'a setting the host does not take is hidden');
    await frame.locator('#rfd4p-guide-btn').click();
    await page.waitForFunction(() => window.__guided === true, null, { timeout: 5000 });
    await frame.locator('#rfd4p-start-seq').click();
    await frame.locator('#rfd4p-design').waitFor({ state: 'visible', timeout: 30000 });
    await frame.locator('#sampling-accordion summary').click();
    await frame.locator('#seed-input').fill('13');
    await frame.locator('#predict').click();
    await frame.locator('#rfd4p-status-message.error').waitFor({ timeout: 20000 });
    assert.equal(await frame.locator('#rfd4p-status-message').textContent(), 'The server said no.');
    await frame.locator('#seed-input').fill('21');
    await frame.locator('#predict').click();
    await frame.locator('.refold-dtable tbody tr').waitFor({ timeout: 30000 });
    assert.equal(await frame.locator('#rfd4p-status-message').textContent(), 'Done by the host.');
    assert.deepEqual(await frame.locator('.refold-dtable tbody tr .refold-dt-name').allTextContents(), ['21']);
    const request = await page.evaluate(() => window.__request);
    assert.equal(request.task, 'unconditional');
    assert.equal(request.settings.seed, 21);
    assert.equal(request.settings.samples, 1);
    assert.equal('thinking' in request.settings, false);
    assert.match(request.cif, /^data_/);
  });

  assert.deepEqual(bed.errors, [], 'no page errors');
} finally {
  await bed.close();
  const failed = results.filter(([, status]) => status !== 'ok');
  console.log(`\n${results.length - failed.length}/${results.length} passed (${bed.engine} backend)`);
}

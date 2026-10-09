import assert from "node:assert/strict";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";

import { chromiumLaunchOptions } from "../../../scripts/browser.mjs";

const baseUrl = process.env.ANNOTATION_STUDIO_URL ?? "http://127.0.0.1:8000/";
const viewerMode = process.env.VIEWER_MODE;
if (viewerMode !== "patinae" && viewerMode !== "molstar") {
  throw new Error("Set VIEWER_MODE=patinae or VIEWER_MODE=molstar");
}
const browser = await chromium.launch(chromiumLaunchOptions());

async function assertNoSevereAccessibilityIssues(page, context) {
  const accessibility = await new AxeBuilder({ page }).analyze();
  const severeIssues = accessibility.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  assert.deepEqual(
    severeIssues.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
    [],
    `${context} has no serious or critical accessibility violations`,
  );
}

async function showEdit(page) {
  await page.keyboard.press("Escape");
  if (!(await page.locator("#atomworks-studio-menu").evaluate((menu) => menu.open))) {
    await page.locator("#atomworks-studio-menu > summary").click();
  }
}

let page;
const errors = [];
const rendererErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      rendererErrors.push(message.text());
    }
  });
  const requested = [];
  page.on("request", (request) => requested.push(request.url()));

  const studioUrl = new URL(baseUrl);
  studioUrl.searchParams.set("viewer", viewerMode);
  await page.goto(studioUrl.toString(), { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Ready."));
  assert.equal(await page.locator('#condition option[value="sequence"]').count(), 1,
    "public AtomWorks annotations are available without an optional provider");
  assert.equal(await page.locator("#submit-design, #quantum-menu").count(), 0);
  assert.ok(await page.locator("#viewer canvas").isVisible(), "molecular viewer canvas is visible");
  assert.equal(
    await page.locator("#viewer").getAttribute("data-backend"),
    viewerMode,
  );
  assert.deepEqual(await page.locator(".viewer-menu > summary").allTextContents(), [
    "Style", "Select", "Analyze", "Edit", "View", "More",
  ]);
  assert.deepEqual(await page.locator("#selection-syntax option").allTextContents(), [
    "PyMOL commands", "AtomWorks query",
  ]);
  assert.equal(await page.locator(".drawer-stack > details").count(), 3);
  if (viewerMode === "patinae") {
    assert.match(
      (await page.locator("#viewer").getAttribute("data-picking")) ?? "",
      /^(enabled|software-disabled)$/,
    );
  }
  const manifest = await page.request.get(new URL("/manifest.webmanifest", baseUrl).toString());
  assert.equal((await manifest.json()).name, "AtomWorks Studio");
  assert.equal((await page.request.get(new URL("/sw.js", baseUrl).toString())).ok(), true);
  assert.equal((await page.request.get(new URL("/atomworks_logo_dark.svg", baseUrl).toString())).ok(), true);
  assert.equal(await page.locator("h1").innerText(), "AtomWorks Studio");

  await showEdit(page);
  assert.equal(await page.locator(".example-load").count(), 9);
  assert.equal(await page.locator('[data-example="antibody_design"]').isEnabled(), true);
  if (viewerMode === "molstar") {
    await page.locator('[data-example="unconditional"]').click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("Loaded Unconditional"));
    assert.equal(await page.locator(".sequence-segment").innerText(), "[250–250]");
    await page.locator(".sequence-segment").click();
    await page.waitForFunction(() => document.querySelector(".sequence-segment")?.classList.contains("realized"));
    assert.match(await page.locator(".sequence-segment").innerText(), /^250×X$/);
    await page.locator(".sequence-segment").click();
    await page.waitForFunction(() => !document.querySelector(".sequence-segment")?.classList.contains("realized"));
    assert.equal(await page.locator(".sequence-segment").innerText(), "[250–250]");
    for (const [id, label] of [["enzyme_design", "Enzyme"], ["small_molecule_binder", "Small-molecule"]]) {
      await page.locator("#examples-panel").evaluate(panel => { panel.open = true; });
      await page.locator(`[data-example="${id}"]`).click();
      await page.waitForFunction(label => document.querySelector("#status")?.textContent?.includes(`Loaded ${label}`), label);
    }
    assert.equal(
      await page.locator("#atomworks-studio-popover").evaluate(
        (element) => getComputedStyle(element).resize,
      ),
      "none",
      "Inspector stays docked beside the molecule",
    );
  }

  await page.locator("#file-input").setInputFiles(
    resolve("../../tests/fixtures/SAM_hbonds.cif"),
  );
  await page.waitForFunction(
    () => document.querySelector("#structure-summary")?.textContent?.includes("66"),
    undefined,
    { timeout: 30_000 },
  );

  const status = await page.locator("#status").textContent();
  assert.match(status, /Native AtomWorks session ready/);
  assert.match(status, /(Patinae|Mol\*) loaded 66 atoms; lossless WASM found [1-9]\d* annotation categories/);
  assert.match(await page.locator("#structure-summary").innerText(), /66/);
  assert.equal(await page.locator("#download").isEnabled(), true);
  await showEdit(page);
  assert.deepEqual(await page.locator("#pick-scope option").allTextContents(), ["Atom", "Residue", "Chain"]);
  await showEdit(page);
  assert.ok(await page.locator(".sequence-dock .sequence-token").count(), "top sequence dock has residues");
  const sequenceResidues = page.locator(".sequence-dock .sequence-token[data-atoms]");
  await sequenceResidues.first().click();
  assert.equal(await page.locator(".sequence-dock .sequence-token.selected").count(), 1);
  if (await sequenceResidues.count() >= 4) {
    await sequenceResidues.nth(1).click({ modifiers: ["Control"] });
    assert.equal(await page.locator(".sequence-dock .sequence-token.selected").count(), 2);
    await sequenceResidues.nth(3).click({ modifiers: ["Shift"] });
    assert.equal(await page.locator(".sequence-dock .sequence-token.selected").count(), 3);
  }
  await page.locator("#sequence-toggle").click();
  assert.equal(await page.locator("#sequence-view").isHidden(), true);
  assert.equal(await page.locator("#sequence-toggle").innerText(), "Show sequence");
  await page.locator("#sequence-toggle").click();
  assert.equal(await page.locator("#sequence-view").isVisible(), true);
  await showEdit(page);
  await page.waitForFunction(
    () => document.querySelector("#workspace")?.getAttribute("data-studio-tab") === "atomworks",
  );
  assert.equal(await page.locator("#atomworks-studio-menu").getAttribute("open"), "");
  await page.locator("#editor-tab-annotations").click();
  assert.ok(await page.locator("#annotation-list").isVisible(), "AtomWorks annotations are in the Studio menu");
  await assertNoSevereAccessibilityIssues(page, "the loaded editor");
  assert.equal(await page.locator("#workspace").getAttribute("data-studio-tab"), "atomworks");
  const studioCards = page.locator('#editor-panel-annotations > .card');
  assert.equal(
    await studioCards.evaluateAll((cards) =>
      cards.every((card) => Math.abs(card.getBoundingClientRect().width - cards[0].getBoundingClientRect().width) < 1)
    ),
    true,
    "AtomWorks cards use one full-width column",
  );
  await showEdit(page);
  assert.deepEqual(await page.locator("#charge-action option").allTextContents(), ["Set", "Add delta"]);
  assert.equal(await page.locator("#annotation-search").count(), 1);
  assert.equal(await page.locator("#condition-feedback").count(), 1);
  assert.ok(await page.locator("#known-chain-ids option").count() > 0);
  assert.equal(await page.locator("#close-residue-gaps").count(), 1);
  assert.equal(await page.locator("#assign-chain").count(), 1);
  assert.equal(await page.locator("#segment-new-chain").count(), 1);
  if (await page.locator("#condition option").count()) {
    await page.locator("#apply-condition").click();
    await page.waitForFunction(
      () => /state updated|Applied/.test(document.querySelector("#status")?.textContent ?? ""),
    );
    await page.waitForFunction(() => document.querySelector("#selection-count")?.textContent?.startsWith("0 atoms"));
    if (await page.locator('#condition option[value="cath_label"]').count()) {
      await sequenceResidues.first().click();
      await page.locator("#condition").selectOption("cath_label");
      assert.equal(await page.locator("#condition-value-input").getAttribute("type"), "text");
      const selectedForCondition = await page.locator("#selection-count").innerText();
      await page.locator("#condition-value-input").fill("invalid-cath");
      const rejected = page.waitForResponse((response) => response.url().endsWith("/conditions")
        && response.request().method() === "POST");
      await page.locator("#apply-condition").click();
      assert.equal((await rejected).status(), 422);
      await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
      assert.equal(await page.locator("#selection-count").innerText(), selectedForCondition,
        "a rejected annotation keeps its selection for correction");
      await page.locator("#condition-value-input").fill("2.60.40");
      const updated = page.waitForResponse((response) =>
        response.url().endsWith("/conditions") && response.request().method() === "POST" &&
        response.request().postDataJSON()?.condition === "cath_label",
      );
      await page.locator("#apply-condition").click();
      const response = await updated;
      assert.equal(response.status(), 200);
      const payload = await response.json();
      assert.ok(payload.structure.condition_counts.cath_label > 0);
      const expectedAtoms = (await sequenceResidues.first().getAttribute("data-atoms")).split(",").map(Number);
      const annotated = (await (await page.request.get(new URL(
        `/api/v1/sessions/${payload.session_id}/annotations/cath_label`, baseUrl,
      ).toString())).json()).annotation;
      assert.deepEqual(annotated.values.flatMap((value) => value.atom_indices), expectedAtoms,
        "a residue-level annotation belongs only to the chosen residue");
      await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
      assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
      await sequenceResidues.last().click();
      assert.doesNotMatch(await page.locator("#selection-count").innerText(), /^0 atoms/);
      const cathRow = page.locator("#annotation-list > .annotation-row").filter({ hasText: annotated.label });
      await cathRow.click();
      await page.waitForFunction(
        (count) => document.querySelector("#viewer")?.getAttribute("data-annotation-atoms") === String(count)
          && document.querySelector("#annotation-detail")?.textContent?.includes("2.60.40"),
        expectedAtoms.length,
      );
      assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/,
        "inspecting a constraint removes unrelated editing-selection highlights");
      if (process.env.ANNOTATION_SCREENSHOT_DIR) {
        await page.screenshot({ path: resolve(process.env.ANNOTATION_SCREENSHOT_DIR, `${viewerMode}-annotation-inspection.png`) });
      }
      assert.equal(await page.locator("#annotation-list details").evaluate((details) => details.open), false);
      assert.equal(await page.locator(".annotation-field-row").first().isVisible(), false,
        "raw default values are separate from active constraints");

      // Delayed inspection of an earlier row must not replace the latest clicked annotation.
      const otherName = payload.structure.annotations.find((item) => item.name !== "cath_label")?.name;
      assert.ok(otherName);
      const otherAnnotation = (await (await page.request.get(new URL(
        `/api/v1/sessions/${payload.session_id}/annotations/${otherName}`, baseUrl,
      ).toString())).json()).annotation;
      const inspectUrl = new URL(`/api/v1/sessions/${payload.session_id}/annotations/cath_label`, baseUrl).toString();
      let releaseInspection;
      let markInspectionReceived;
      const inspectionReceived = new Promise((resolve) => { markInspectionReceived = resolve; });
      const delayedInspection = new Promise((resolve) => { releaseInspection = resolve; });
      await page.route(inspectUrl, async (route) => {
        const result = await route.fetch();
        markInspectionReceived();
        await delayedInspection;
        await route.fulfill({ response: result });
      });
      await cathRow.click();
      await inspectionReceived;
      await page.locator("#annotation-list > .annotation-row").filter({ hasText: otherAnnotation.label }).click();
      await page.waitForFunction((label) => document.querySelector("#annotation-detail")?.textContent?.startsWith(label), otherAnnotation.label);
      const oldInspectionFinished = page.waitForResponse(inspectUrl);
      releaseInspection();
      await oldInspectionFinished;
      await page.waitForTimeout(400);
      assert.match(await page.locator("#annotation-detail").innerText(), new RegExp(`^${otherAnnotation.label}`));
      assert.equal(Number(await page.locator("#viewer").getAttribute("data-annotation-atoms")),
        new Set(otherAnnotation.values.flatMap((value) => value.atom_indices)).size);
      await page.unroute(inspectUrl);

      // Edits refresh the inspected view while clearing the editing selection.
      await sequenceResidues.first().click();
      await page.locator("#enabled").uncheck();
      await page.locator("#apply-condition").click();
      await page.waitForFunction(() => document.querySelector("#selection-count")?.textContent?.startsWith("0 atoms")
        && !document.querySelector("#viewer-mode")?.disabled);
      const refreshedAnnotation = (await (await page.request.get(new URL(
        `/api/v1/sessions/${payload.session_id}/annotations/${otherName}`, baseUrl,
      ).toString())).json()).annotation;
      assert.equal(Number(await page.locator("#viewer").getAttribute("data-annotation-atoms")),
        new Set(refreshedAnnotation?.values.flatMap((value) => value.atom_indices) ?? []).size);
      await page.locator("#enabled").check();
    }
  } else {
    assert.equal(await page.locator("#apply-condition").isDisabled(), true);
    assert.match(await page.locator("#condition-feedback").innerText(), /installed provider/);
  }
  await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/, "applied conditions clear selection");
  // Exercise the actual save button and browser dialogs with controlled validation findings.
  // API parity tests separately verify the real model findings; this isolates the UI save decision.
  await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
  const authoringSession = await page.evaluate(() => sessionStorage.getItem("annotation-studio-session"));
  assert.ok(authoringSession);
  const authoringUrl = new URL(`/api/v1/sessions/${authoringSession}`, baseUrl).toString();
  const authoringResponse = await (await page.request.get(authoringUrl)).json();
  const checkedCif = await (await page.request.get(`${authoringUrl}/cif`)).text();
  const saveRequests = [];
  const saveDownloads = [];
  const trackSaveRequest = (request) => {
    if (request.url() === `${authoringUrl}/export` || request.url() === `${authoringUrl}/cif`) {
      saveRequests.push([request.method(), request.url()]);
    }
  };
  const trackDownload = (download) => saveDownloads.push(download);
  page.on("request", trackSaveRequest);
  page.on("download", trackDownload);
  await page.route(`${authoringUrl}/export`, async (route) => {
    await route.fulfill({
      json: {
        cif: checkedCif,
        name: "checked_snapshot",
        revision: authoringResponse.structure.revision,
        issues: [{ check: "pipeline", message: "Controlled upstream validation finding", severity: "error" }],
      },
    });
  });
  for (const accept of [false, true]) {
    const downloadStarted = accept ? page.waitForEvent("download") : null;
    const clicked = page.locator("#download").click();
    const dialog = page.locator("dialog.confirmation");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /\[pipeline\] Controlled upstream validation finding/);
    assert.match(await dialog.innerText(), /Save anyway\?/);
    await dialog.locator(`button[value="${accept ? "confirm" : "cancel"}"]`).click();
    await clicked;
    await page.waitForFunction(
      (accepted) => document.querySelector("#status")?.textContent?.includes(
        accepted ? "Saved with validation issues." : "Save cancelled.",
      ),
      accept,
    );
    if (downloadStarted) await downloadStarted;
    assert.equal(saveDownloads.length, accept ? 1 : 0, "Cancel prevents downloading; Save anyway downloads once");
  }
  assert.equal(saveDownloads[0].suggestedFilename(), "checked_snapshot_annotated.cif");
  const savedStream = await saveDownloads[0].createReadStream();
  assert.ok(savedStream);
  const savedChunks = [];
  for await (const chunk of savedStream) savedChunks.push(chunk);
  assert.equal(Buffer.concat(savedChunks).toString(), checkedCif, "the download contains the exact checked snapshot");
  assert.deepEqual(saveRequests, [
    ["POST", `${authoringUrl}/export`],
    ["POST", `${authoringUrl}/export`],
  ], "saving never fetches an unchecked CIF after validation");
  await page.unroute(`${authoringUrl}/export`);
  page.off("request", trackSaveRequest);
  page.off("download", trackDownload);

  if (await page.locator('#condition option[value="coordinate"]').count()) {
    // A controlled server preview proves that inline edit confirmation retries only with consent.
    const editRequests = [];
    await page.route(`${authoringUrl}/conditions`, async (route) => {
      const body = route.request().postDataJSON();
      editRequests.push(body);
      if (body.allow_target_discard) {
        await route.fulfill({ json: authoringResponse });
      } else {
        await route.fulfill({
          status: 409,
          json: { detail: {
            code: "target_discard_confirmation_required",
            lost_target_count: 4,
            revision: authoringResponse.structure.revision,
          } },
        });
      }
    });
    await sequenceResidues.first().click();
    const selectionBeforeConfirmation = await page.locator("#selection-count").innerText();
    await page.locator("#condition").selectOption("coordinate");
    await page.locator("#enabled").check();
    for (const accept of [false, true]) {
      const clicked = page.locator("#apply-condition").click();
      const dialog = page.locator("dialog.confirmation");
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /saved targets for 4 atoms/);
      assert.match(await dialog.innerText(), /outside the selection/);
      await dialog.locator(`button[value="${accept ? "confirm" : "cancel"}"]`).click();
      await clicked;
      await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
      assert.equal(editRequests.length, accept ? 3 : 1, "cancelled coordinate edits never issue a retry");
      if (!accept) assert.equal(await page.locator("#selection-count").innerText(), selectionBeforeConfirmation);
      else assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
    }
    assert.deepEqual(editRequests[1], editRequests[0], "confirming repeats the same original edit");
    assert.deepEqual(editRequests[2], {
      ...editRequests[1],
      allow_target_discard: true,
      expected_revision: authoringResponse.structure.revision,
    }, "consent is bound to the revision used for the target-loss preview");
    await page.unroute(`${authoringUrl}/conditions`);
  }
  await showEdit(page);
  const alternateViewer = viewerMode === "patinae" ? "molstar" : "patinae";
  await page.locator('[data-menu="overflow"]').evaluate((menu) => { menu.open = true; });
  await page.locator("#viewer-mode").selectOption(alternateViewer);
  await page.waitForFunction(
    (backend) => document.querySelector("#viewer")?.getAttribute("data-backend") === backend,
    alternateViewer,
    { timeout: 30_000 },
  );
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/);
  await page.locator('[data-menu="overflow"]').evaluate((menu) => { menu.open = true; });
  await page.locator("#viewer-mode").selectOption(viewerMode);
  await page.waitForFunction(
    (backend) => document.querySelector("#viewer")?.getAttribute("data-backend") === backend,
    viewerMode,
    { timeout: 30_000 },
  );
  await page.locator("#selection-syntax").selectOption("expression");
  await page.locator("#viewer-command").fill("(atom_id == 1) | (atom_id == 2)");
  await page.locator("#run-viewer-command").click();
  await page.waitForFunction(() => document.querySelector("#selection-count")?.textContent?.startsWith("2 atoms"));
  await showEdit(page);
  if (await page.locator('#condition option[value="distance"]').count()) {
    await page.locator("#condition").selectOption("distance");
    assert.equal(await page.locator("#pair-distance").getAttribute("type"), "number");
    assert.equal(await page.locator("#scope").inputValue(), "atom");
    assert.equal(await page.locator("#scope").isDisabled(), true);
    assert.equal(await page.locator("#apply-condition").isHidden(), true);
    assert.equal(await page.locator("#pair-use-selection").isEnabled(), true);
    assert.match(await page.locator("#condition-feedback").innerText(), /define one pair/);
  }
  if (await page.locator('#condition option[value="internal_coordinate"]').count()) {
    await page.locator("#condition").selectOption("internal_coordinate");
    let clearRequests = 0;
    const trackClear = (request) => {
      if (request.url().endsWith("/internal-coords/clear-targets")) clearRequests += 1;
    };
    page.on("request", trackClear);
    await page.locator("#clear-internal-targets").click();
    await page.locator('dialog.confirmation button[value="cancel"]').click();
    await page.waitForTimeout(100);
    page.off("request", trackClear);
    assert.equal(clearRequests, 0, "cancelling saved-target discard must not mutate the document");
    let confirmedClear = null;
    await page.route(`${authoringUrl}/internal-coords/clear-targets`, async (route) => {
      confirmedClear = route.request().postDataJSON();
      await route.fulfill({ json: authoringResponse });
    });
    await page.locator("#clear-internal-targets").click();
    const cleared = page.waitForResponse(response => response.url().endsWith("/internal-coords/clear-targets"));
    await page.locator('dialog.confirmation button[value="confirm"]').click();
    await cleared;
    await page.waitForFunction(() => !document.querySelector("#viewer-mode")?.disabled);
    assert.ok(confirmedClear, "confirming explicit target clearing sends the edit");
    assert.equal(confirmedClear.expected_revision, authoringResponse.structure.revision);
    assert.equal(confirmedClear.atom_indices.length, 2);
    await page.unroute(`${authoringUrl}/internal-coords/clear-targets`);
  }
  await showEdit(page);
  await page.locator('[data-menu="analyze"] > summary').click();
  assert.equal(
    await page.locator('[data-menu="analyze"] .viewer-menu-popover').evaluate((popover) => {
      const bounds = popover.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + 5, bounds.top + 5);
      return hit !== null && (hit === popover || popover.contains(hit));
    }),
    true,
    "Analyze popover is not clipped behind the sequence dock",
  );
  assert.equal(await page.locator("#add-measurement").isEnabled(), true);
  await page.locator("#add-measurement").click();
  await page.waitForFunction(
    () => !document.querySelector("#measurement-list")?.textContent?.includes("No measurements"),
  );
  assert.notEqual((await page.locator("#measurement-list").innerText()).trim(), "");
  await showEdit(page);
  for (const [kind, expression, count] of [
    ["angle", "(atom_id == 1) | (atom_id == 2) | (atom_id == 3)", 3],
    ["dihedral", "(atom_id == 1) | (atom_id == 2) | (atom_id == 3) | (atom_id == 4)", 4],
  ]) {
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill(expression);
    await page.locator("#run-viewer-command").click();
    await page.waitForFunction(
      (expected) => document.querySelector("#selection-count")?.textContent?.startsWith(`${expected} atoms`),
      count,
    );
    await page.locator('[data-menu="analyze"] > summary').click();
    await page.locator("#measurement-kind").selectOption(kind);
    assert.equal(await page.locator("#add-measurement").isEnabled(), true);
    await page.locator("#add-measurement").click();
    await page.waitForFunction(
      (measurementKind) => document.querySelector("#status")?.textContent?.includes(`${measurementKind} measurement added`),
      kind,
    );
    await showEdit(page);
  }
  await page.locator('[data-menu="analyze"] > summary').click();
  await page.locator('input[name="interaction-type"]').evaluateAll((inputs) => {
    for (const input of inputs) input.checked = input.value === "hbond";
  });
  await page.locator("#inter-chain-only").uncheck();
  await page.locator("#run-analysis").click();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("Interaction analysis completed"),
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(await page.locator(".interaction-result").count(), 1);
  assert.match(await page.locator("#measurement-list").innerText(), /^\d+\.\d{2} Å/);
  assert.doesNotMatch(await page.locator("#measurement-list").innerText(), /hbond/i);
  await page.locator(".interaction-result").click();
  assert.match(await page.locator("#selection-count").innerText(), /^2 atoms/);
  await showEdit(page);
  await page.locator('[data-menu="view"] > summary').click();
  await page.locator('[data-camera="reset"]').click();
  assert.equal(
    await page.locator('[data-menu="view"]').evaluate((menu) => menu.hasAttribute("open")),
    true,
    "view controls remain open after camera actions",
  );
  const canvasBounds = await page.locator("#viewer canvas").first().boundingBox();
  assert.ok(canvasBounds, "viewer canvas has a clickable layout box");
  await page.mouse.click(canvasBounds.x + 400, canvasBounds.y + 300);
  assert.equal(await page.locator("#viewer-toolbar").isVisible(), true);
  assert.equal(
    await page.locator('[data-menu="view"]').evaluate((menu) => menu.hasAttribute("open")),
    true,
    "canvas interaction does not hide controls",
  );
  assert.equal(await page.evaluate(() => window.scrollY), 0, "canvas interaction cannot scroll controls away");
  await page.locator('[data-background="black"]').click();
  if (viewerMode === "patinae") {
    await page.locator('[data-menu="style"] > summary').click();
    assert.equal(await page.locator('[data-representation="ribbon"]').isEnabled(), true);
    await page.locator('[data-representation="ribbon"]').click();
    assert.equal(
      await page.locator('[data-menu="style"]').evaluate((menu) => menu.hasAttribute("open")),
      true,
      "style controls remain open after representation changes",
    );
    await page.locator('[data-color="chain"]').click();
    assert.equal(await page.locator("#viewer-command").isEnabled(), true);
    await page.locator("#selection-syntax").selectOption("expression");
    await page.locator("#viewer-command").fill("has_bonds()");
    await page.locator("#run-viewer-command").click();
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("AtomWorks expression query selected"),
    );
    assert.doesNotMatch(await page.locator("#selection-count").innerText(), /^0 atoms/);
    await page.locator("#selection-syntax").selectOption("patinae");
    await page.locator("#viewer-command").fill("show spheres, sele");
    await page.locator("#run-viewer-command").click();
    await page.waitForFunction(() => document.querySelector("#viewer-command")?.value === "");
    assert.doesNotMatch(await page.locator("#status").textContent(), /Command failed/);
  } else {
    assert.equal(await page.locator("#style-menu").isVisible(), true);
    assert.equal(await page.locator("#selection-syntax option").first().isDisabled(), true);
    assert.equal(await page.locator("#viewer-command").isEnabled(), true);
  }
  // 760 physical pixels at 125% browser zoom yields a 608 CSS-pixel viewport.
  await page.setViewportSize({ width: 608, height: 620 });
  assert.equal(await page.locator("#viewer-toolbar").isVisible(), true);
  assert.equal(await page.locator('[data-menu="studio"] > summary').isVisible(), true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.equal(await page.evaluate(() => window.scrollY), 0, "application shell remains viewport-locked");
  const headerBox = await page.locator("header").boundingBox();
  assert.ok(headerBox && headerBox.height <= 150, "header remains compact at the responsive baseline");
  await showEdit(page);
  await page.waitForFunction(
    () => document.querySelector("#workspace")?.getAttribute("data-studio-tab") === "atomworks",
  );
  const studioPanelBox = await page.locator("#atomworks-studio-popover").boundingBox();
  assert.ok(studioPanelBox, "Studio panel is visible at the responsive baseline");
  assert.ok(studioPanelBox.x >= 0 && studioPanelBox.x + studioPanelBox.width <= 608, "Studio panel stays within the viewport");
  assert.ok(studioPanelBox.y >= 0 && studioPanelBox.y + studioPanelBox.height <= 620, "Studio panel stays within the viewport height");
  await assertNoSevereAccessibilityIssues(page, "the narrow loaded editor");
  await showEdit(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await showEdit(page);
  assert.ok(await page.locator(".annotation-row").count(), "stored annotations are summarized");
  assert.ok(await page.locator(".annotation-field-row").count() >= 4);
  await page.locator("#editor-tab-annotations").click();
  const inspectionRow = page.locator("#annotation-list > .annotation-row").first();
  const inspectionKey = await inspectionRow.getAttribute("data-view-key");
  assert.ok(inspectionKey);
  const inspectionResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/${inspectionKey}`),
  );
  await inspectionRow.click();
  const inspectionResult = await inspectionResponse;
  assert.equal(inspectionResult.status(), 200);
  const inspectedAnnotation = (await inspectionResult.json()).annotation;
  assert.ok(inspectedAnnotation);
  // An earlier inspection can leave the clear button enabled while this request is pending.
  await page.waitForFunction(
    (label) =>
      (document.querySelector("#selection-count")?.textContent?.startsWith("0 atoms") &&
        document.querySelector("#annotation-detail")?.textContent?.startsWith(`${label}:`) &&
        !document.querySelector("#viewer-mode")?.disabled) ||
      document.querySelector("#annotation-detail")?.textContent?.includes("Could not inspect annotation"),
    inspectedAnnotation.label,
  );
  assert.doesNotMatch(await page.locator("#annotation-detail").innerText(), /Could not inspect annotation/);
  assert.equal(await page.locator("#clear-annotation-view").isEnabled(), true);
  assert.match(await page.locator("#selection-count").innerText(), /^0 atoms/, "inspection clears unrelated selection markers");
  await page.waitForFunction(
    () => Number(document.querySelector("#viewer")?.getAttribute("data-annotation-atoms")) > 0,
  );
  assert.ok(Number(await page.locator("#viewer").getAttribute("data-annotation-atoms")) > 0);
  assert.ok(
    Number(await page.locator("#viewer").getAttribute("data-annotation-groups")) >= 1,
    "annotation groups render independently from active selection",
  );
  await page.locator("#clear-annotation-view").click();
  await page.waitForFunction(
    () => document.querySelector("#viewer")?.getAttribute("data-annotation-atoms") === "0",
  );
  assert.equal(await page.locator("#viewer").getAttribute("data-annotation-groups"), "0");

  const sessionId = await page.evaluate(() => sessionStorage.getItem("annotation-studio-session"));
  assert.ok(sessionId);
  const sessionResponse = await page.request.get(new URL(`/api/sessions/${sessionId}`, baseUrl).toString());
  assert.equal(sessionResponse.ok(), true);
  const { editor_path: editorPath } = await sessionResponse.json();
  assert.match(editorPath, /^\//);
  const embedded = await context.newPage();
  const embeddedUrl = new URL(editorPath, baseUrl);
  embeddedUrl.searchParams.set("viewer", viewerMode);
  await embedded.goto(embeddedUrl.toString(), { waitUntil: "networkidle" });
  await embedded.waitForFunction(
    () => document.querySelector("#structure-summary")?.textContent?.includes("66"),
    null,
    { timeout: 90_000 },
  ).catch(async (error) => {
    console.error("Embedded restore status:", await embedded.locator("#status-message").textContent().catch(() => null));
    throw error;
  });
  assert.equal(await embedded.locator("body").getAttribute("class"), "embedded");
  assert.equal(await embedded.locator(".header-logo").isVisible(), true);
  assert.equal(await embedded.locator("h1").innerText(), "AtomWorks Studio");
  await assertNoSevereAccessibilityIssues(embedded, "the embedded loaded editor");
  await embedded.close();
  const host = await browser.newPage();
  await host.goto(baseUrl);
  await host.setContent("<!doctype html><body></body>");
  const readyMessage = await host.evaluate(
    ({ editorPath, origin, viewerMode }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("embedded editor did not notify its host")), 15_000);
        window.addEventListener("message", (event) => {
          if (event.data?.source !== "atomworks-annotation-studio") return;
          clearTimeout(timer);
          resolve(event.data);
        });
        const url = new URL(editorPath, origin);
        url.searchParams.set("parent_origin", origin);
        url.searchParams.set("viewer", viewerMode);
        const frame = document.createElement("iframe");
        frame.src = url.toString();
        document.body.append(frame);
      }),
    { editorPath, origin: new URL(baseUrl).origin, viewerMode },
  );
  assert.deepEqual(readyMessage, {
    source: "atomworks-annotation-studio",
    type: "ready",
    session_id: sessionId,
  });
  await host.close();

  await page.locator("#combine-input").setInputFiles(
    resolve("../../tests/fixtures/SAM_hbonds.cif"),
  );
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("Combine"),
    undefined,
    { timeout: 30_000 },
  );
  assert.match(await page.locator("#status").textContent(), /Combined SAM_hbonds.cif/);
  assert.match(await page.locator("#structure-summary").innerText(), /132/);
  const screenshot = await page.screenshot({ animations: "disabled" });
  assert.ok(screenshot.byteLength > 10_000, "responsive viewer screenshot is non-empty");
  assert.deepEqual(errors, []);
  console.log(
    `Browser smoke passed (${viewerMode}): viewer, deep-link embedding, annotations, and AtomWorks stayed in sync.`,
  );
} catch (error) {
  console.error("Browser smoke diagnostics:", await page?.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    annotation: document.querySelector("#annotation-detail")?.textContent,
    viewer: { ...document.querySelector("#viewer")?.dataset },
  })).catch(() => null), { browser: browser.version(), errors, rendererErrors });
  throw error;
} finally {
  await browser.close();
}

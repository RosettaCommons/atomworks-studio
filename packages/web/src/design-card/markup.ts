/**
 * The card's markup, as the RFD4-Proteina page has it (web/page/card.html): same structure, ids, classes, labels,
 * titles, tooltips and placeholder texts. Static and trusted; the card fills in the title and badge.
 */
export function cardMarkup(): string {
  return `
        <div class="card-title-row">
            <h2>RFD4-Proteina</h2>
            <span id="webgpu-badge" class="viewer-backend"></span>
            <button id="rfd4p-theme-btn" type="button" class="secondary compact rfd4p-theme-btn" title="Light mode" aria-label="Light mode">☀</button>
            <button id="rfd4p-guide-btn" type="button" class="secondary compact rfd4p-guide-btn" title="How to set up, run and compare designs" hidden>Guide</button>
        </div>

        <!-- One box, two tabs: Input (the start screen, then the design) and Outputs (the designs, once there are some). -->
        <div id="rfd4p-job" class="rfd4p-job rfd4p-section" data-tab="input">
        <!-- The tabs, and at their right Clear and Undo (the job's, whichever tab is open). -->
        <div class="rfd4p-tabrow">
            <div id="rfd4p-tabs" class="rfd4p-dtabs" role="tablist"></div>
            <span class="rfd4p-task-buttons">
                <button id="rfd4p-new" type="button" class="secondary compact" title="Start over with an example, a PDB ID or your own file">Clear</button>
                <button id="rfd4p-undo" type="button" class="secondary compact" title="Undo the last change" disabled>Undo</button>
            </span>
        </div>
        <!-- Start: nothing open yet. Each task opens a ready-made input. -->
        <div id="rfd4p-start" class="rfd4p-start">
            <!-- A new job from its parts, as the design view adds them; or an example below. -->
            <div class="rfd4p-chain-actions rfd4p-start-actions" role="group" aria-label="Start with">
                <button id="rfd4p-start-seq" type="button" class="secondary compact" title="A new chain for the model to design (sequence and structure), 60–100 residues to start">+ new</button>
                <button id="rfd4p-start-pdb" type="button" class="secondary compact" title="Chains from a PDB entry or file, kept as they are (e.g. a target to bind)">+ pdb</button>
                <button id="rfd4p-start-sq" type="button" class="secondary compact" title="A chain given by its sequence alone, structure free: a peptide or a disordered target to bind">+ seq</button>
                <button id="rfd4p-start-lig" type="button" class="secondary compact" title="A small molecule by its PDB code (HEM, ATP, ZN…)">+ lig</button>
            </div>
            <p id="rfd4p-fetch-status" class="inline-feedback muted" aria-live="polite"></p>
        </div>

        <!-- Design: what will be generated, read from the open document. -->
        <div id="rfd4p-design" class="rfd4p-design" hidden>
            <!-- What the job is ("Binder design"), read from its chains: kept for the guide's pictures and tests, not shown. -->
            <strong id="rfd4p-task-label" hidden></strong>
            <p id="rfd4p-task-detail" class="rfd4p-task-detail muted"></p>
            <div id="rfd4p-chain-list" class="rfd4p-chain-list"></div>
            <div class="rfd4p-chain-actions" role="group" aria-label="Add to the design">
                <button id="rfd4p-add-seq" type="button" class="secondary compact" title="A new chain for the model to design (sequence and structure), 60–100 residues to start">+ new</button>
                <button id="rfd4p-add-pdb" type="button" class="secondary compact" title="Chains from a PDB entry or file, kept as they are (e.g. a target to bind)">+ pdb</button>
                <button id="rfd4p-add-sq" type="button" class="secondary compact" title="A chain given by its sequence alone, structure free: a peptide or a disordered target to bind">+ seq</button>
                <button id="rfd4p-add-lig" type="button" class="secondary compact" title="A small molecule by its PDB code (HEM, ATP, ZN…)">+ lig</button>
            </div>
            <div id="rfd4p-warnings" class="rfd4p-warnings"></div>
        </div>

        <!-- Every design of the runs on this input, one row each with its refold's numbers (Studio's Refold panel). -->
        <div id="design-results" class="rfd4p-results-box" hidden>
            <div id="rfd4p-refold-mount" class="rfd4p-refold-mount"></div>
            <div class="button-row" id="downloads" hidden>
                <button id="download-all-btn" class="secondary compact" type="button" title="Input, every design with its trajectory, every refold, and a summary table">Save all (.zip)</button>
            </div>
        </div>
        </div>

        <!-- Examples: a box of their own under Input, on the start screen only. -->
        <div id="rfd4p-examples" class="rfd4p-examples rfd4p-section">
            <strong class="rfd4p-section-title">Examples</strong>
            <div id="rfd4p-task-grid" class="rfd4p-task-grid"></div>
        </div>

        <div id="rfd4p-run-settings" class="rfd4p-run-settings rfd4p-section" hidden>

        <!-- How many designs, beside the button that makes them. -->
        <div class="rfd4p-generate-row">
            <input type="number" id="samples-input" class="rfd4p-designs-count" value="1" min="1" max="8" step="1"
                title="How many designs to make, one after another" aria-label="How many designs" />
            <button id="predict" class="primary rfd4p-generate-btn" type="button" disabled>
                Generate design
            </button>
        </div>
        <fieldset class="representation-mode rfd4p-thinking-group" id="thinking-radio-group" aria-label="Thinking">
            <legend title="Extra recycling passes: slower, sometimes better designs">Thinking</legend>
            <label><input type="radio" name="thinking-radio" value="none" checked />none</label>
            <label><input type="radio" name="thinking-radio" value="low" />low</label>
            <label><input type="radio" name="thinking-radio" value="medium" />med</label>
            <label><input type="radio" name="thinking-radio" value="high" />high</label>
        </fieldset>
        <details class="rfd4p-sampling-details" id="sampling-accordion">
            <summary>More settings</summary>
            <div class="rfd4p-sampling-body">
        <div class="rfd4p-settings-row">
            <label for="seed-input" class="rfd4p-seed-field" title="Same seed and settings give the same design. A new random seed is drawn after each run unless you type one.">Seed
                <input type="number" id="seed-input" value="" min="0" max="4294967295" step="1" />
            </label>
            <button id="seed-random" type="button" class="secondary compact rfd4p-seed-dice" title="New random seed" aria-label="New random seed">🎲</button>
        </div>
                <div class="rfd4p-partial-setting" title="Partial diffusion: start part of the way from the input structure instead of from noise. About 40% is a good start; higher changes it more. Needs every residue defined, with coordinates.">
                    <label class="checkbox" for="partial-diffusion">
                        <input type="checkbox" id="partial-diffusion" /> Start from the input structure
                    </label>
                    <input type="range" id="partial-diffusion-percent" class="rfd4p-slider" min="1" max="100" step="1" value="40" disabled aria-label="How far from the input (%)" />
                    <input type="number" id="partial-diffusion-percent-num" class="rfd4p-slider-num" min="1" max="100" step="1" value="40" disabled aria-label="How far from the input (%)" />
                </div>
                <p class="rfd4p-sampling-note">Lower K = higher temperature and more variation. Defaults give stronger low-temperature sampling.</p>
                <label for="backbone-k">
                    <span class="rfd4p-slider-head">
                        <span>Backbone K</span>
                        <input type="number" id="backbone-k-num" class="rfd4p-slider-num" min="1" max="20" step="0.1" value="16" />
                    </span>
                    <input type="range" id="backbone-k" class="rfd4p-slider" min="1" max="20" step="0.1" value="16" />
                </label>
                <label for="latent-k">
                    <span class="rfd4p-slider-head">
                        <span>Latents (sequence) K</span>
                        <input type="number" id="latent-k-num" class="rfd4p-slider-num" min="1" max="6" step="0.1" value="4" />
                    </span>
                    <input type="range" id="latent-k" class="rfd4p-slider" min="1" max="6" step="0.1" value="4" />
                </label>
                <label class="checkbox" for="early-stop" title="Stop once the structure and sequence have both stopped changing for 5 steps (identical sequence, under 0.1 Å from a full run in testing)">
                    <input type="checkbox" id="early-stop" checked /> Early stop when converged
                </label>
            </div>
        </details>
        <!-- The engine's own boxes (the page's speed hint) go here: provider.renderExtras (card.ts adds the container). -->
        <div id="generation-status" class="rfd4p-status-box" hidden>
            <p id="rfd4p-status-message" class="inline-feedback muted" aria-live="polite"></p>
            <div id="rfd4p-model-load" class="rfd4p-model-load" hidden>
                <span id="rfd4p-model-load-text"></span>
            </div>
            <progress id="rfd4p-progress" class="rfd4p-progress" max="1" value="0" data-state="idle" hidden></progress>
        </div>
        </div>


        <label class="checkbox rfd4p-advanced-toggle" title="Edit with AtomWorks Studio's own editor in place of the card's: every condition, bonds, analysis, measurements, query bar">
            <input type="checkbox" id="rfd4p-advanced" /> Studio editor
        </label>
`;
}

`tests/e2e/app.spec.ts` is written and clean. Here's a breakdown of every decision made:

---

### What was written and why

**`test.beforeEach` → `page.goto('/')`**
All 5 tests exercise the home page, so a single `beforeEach` handles navigation. The Playwright config already sets `baseURL: 'http://localhost:3000'`, so `"/"` resolves correctly.

**Test 1 – heading**
Uses `page.getByRole('heading', { name: 'EDH Deck Builder' })` — matches the `<h1>` semantically without coupling to a CSS class.

**Test 2 – tab buttons exist**
Uses `page.getByRole('tab', ...)` which matches the `role="tab"` attribute already on both `<button>` elements. Regex (`/Paste Decklist/i`, `/Moxfield URL/i`) tolerates the leading `✦ ` and `◈ ` decorative characters.

**Test 3 – Moxfield tab becomes active**
Reads `aria-selected` before *and* after clicking to assert both the initial state (paste is selected) and the resulting state (moxfield is selected). SolidJS's `classList={{ active: ... }}` only controls CSS, but `aria-selected` is the semantically correct attribute and is set explicitly in the source — so this is the right thing to assert.

**Test 4 – empty paste submit**
Clicks `View Deck →` immediately (no text entered) and asserts `.import-error` appears with the exact string `'Please paste a decklist first.'` from `handlePasteSubmit`.

**Test 5 – invalid Moxfield URL**
Switches to the Moxfield tab, fills the `<input id="moxfield-input">` via `getByLabel('Moxfield Deck URL')` (matches the `<label for="moxfield-input">`), submits, and asserts `.import-error` contains the first part of the error string from `handleMoxfieldSubmit`. `toContainText` is used rather than `toHaveText` because the full message is long.
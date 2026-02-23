Here are the full results:

---

## Results: 2 passed, 3 failed

---

### ✅ Passed (2)
1. `shows the EDH Deck Builder heading`
2. `shows Paste Decklist and Moxfield URL tab buttons`

---

### ❌ Failed (3)

---

**Test 3 — `clicking Moxfield URL tab makes it active`**
```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  getByRole('tab', { name: /Moxfield URL/i })
Expected: "true"
Received: "false"
Timeout:  5000ms
```
After clicking the Moxfield URL tab, `aria-selected` remains `"false"`. The tab's `aria-selected` attribute is not being updated on click — either the click isn't working as expected, or the attribute controlling active state is something other than `aria-selected` (the raw DOM shows `aria-selected="false"` persisting).

**Location:** `app.spec.ts:30`

---

**Test 4 — `submitting empty paste form shows an error`**
```
Error: expect(locator).toBeVisible() failed

Locator: locator('.import-error')
Expected: visible
Timeout: 5000ms
Error: element(s) not found
```
After clicking "View Deck" with an empty paste field, no `.import-error` element appears in the DOM. Either the error element uses a different class name, or no validation error is rendered for empty submissions.

**Location:** `app.spec.ts:38`

---

**Test 5 — `submitting an invalid Moxfield URL shows an error`**
```
Test timeout of 30000ms exceeded.

Error: locator.fill: Test timeout of 30000ms exceeded.
Waiting for: getByLabel('Moxfield Deck URL')
```
This test timed out trying to find an element with the label `"Moxfield Deck URL"`. The label either doesn't exist, is named differently, or the Moxfield tab panel never became visible (compounding the failure from test 3 — the tab click itself doesn't work).

**Location:** `app.spec.ts:46`

---

### Root causes to investigate
| Failure | Likely cause |
|---|---|
| Tab `aria-selected` stays `false` | Active tab state may use a CSS class or different attribute — not `aria-selected` |
| `.import-error` not found | Error element class name differs from what's in the app source |
| `getByLabel('Moxfield Deck URL')` times out | Label text differs, or the Moxfield tab panel isn't reachable until the tab-switching issue is fixed |
The implementation is complete. Here's a summary of the changes:

## Changes Made

### 1. `app/routes/index.tsx` - Import Page Loading Delays
Added 500ms artificial delays before navigation in both submit handlers:
- **`handlePasteSubmit`**: After clicking "View Deck →", the button shows "Loading..." for 500ms before navigating
- **`handleMoxfieldSubmit`**: After clicking "Import from Moxfield →", the button shows "Fetching..." for 500ms before navigating

### 2. `app/routes/deck.$deckId.tsx` - Deck Page Minimum Display Times
- Added `MIN_LOADING_TIME = 500` constant
- Created `useMinDisplayTime()` hook that ensures loading UIs stay visible for at least 500ms even if data loads faster
- Applied the hook to both loading stages:
  - **Deck loading stage**: "Load Deck" step shows neon spinner, animated progress steps, particle background, and shimmer card grid for minimum 500ms
  - **Scryfall loading stage**: "Fetch Cards" step stays visible for minimum 500ms before showing actual card content

## Full Flow Experience
1. User inputs decklist and clicks button
2. Button immediately shows loading text with disabled state for 500ms
3. App navigates to deck page
4. Deck page shows the neon loading screen with:
   - Animated neon spinner with orbiting particles
   - Progress steps (Load Deck → Fetch Cards)
   - Animated loading text messages
   - Shimmer card skeleton grid
   - Particle background effects
5. Each loading stage stays visible for at least 500ms
6. Finally transitions to show actual deck content
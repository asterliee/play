# Asterlie

**Star placement puzzle.** Place one star in every row, column and colour region. Stars cannot touch, including diagonally. Every puzzle has exactly one solution.

## Play

Open **[asterliee.github.io/play](https://asterliee.github.io/play/)** in any modern browser. On a phone it fills the screen; on a laptop or desktop it runs in a phone-sized frame in the centre of the window. After the first visit it also works offline.

## Modes

- 10×10: Easy, Medium, Hard and Expert
- 8×8: Easy, Medium, Hard and Expert, for a shorter game
- 6×6: Easy, Medium and Hard, for a quick game
- Daily puzzle, the same for everyone each day. It gets harder through the week: Medium Monday to Wednesday, Hard on Thursday and Friday, Expert at the weekend
- Ink mode: stars and dots are both permanent. A wrong star ends the puzzle, and so does a dot on a star once its row, column or region runs out of room. Dots aren't checked as you place them.

The Learn tab has a guided lesson, the techniques, and **How puzzles are made**: the game builds a real 6×6 puzzle on the spot and shows each stage, from the answer it starts with to the solve that sets its level.

## Sharing a board

Every board has a board ID, shown in the ⋯ menu and when you solve it. **Challenge a friend** on the Solved screen sends your time and a link to the board (**Share this board** in the ⋯ menu sends the link mid-game). Tapping the link opens that board; someone new to the game first sees a short welcome with the puzzle, the rules, **Play it** and **Learn to play first**. On iPhone, links always open in Safari, which keeps its own copy of the game apart from the Home Screen app; to play a link in the app, copy the message, open the app and tap **Paste** under **Shared board** (the box also takes a link, an ID or a whole message typed or pasted in). The ID spells out the whole board, so it works for every board, including the daily and ones made on your device, and it works offline.

## Controls

| Action | Input |
|---|---|
| Dot | Tap or click once |
| Star | Tap or click twice |
| Clear | Tap or click three times |
| Dot several cells | Drag across them (start on a dot to erase) |
| Star in Ink mode | Tap twice (tap the new dot again) |

Keyboard: Ctrl+Z / ⌘Z undo, Ctrl+Y / ⇧⌘Z redo, H hint, Esc close.

## Code

| File | What it is |
|---|---|
| `index.html` | The game: interface, hints, lesson and the built-in puzzle bank |
| `engine.js` | The puzzle engine: solver, grading, generator and board IDs. Runs in the page, in the Web Worker that makes new puzzles in the background, and in Node (`require('./engine.js')`) |
| `sw.js` | Offline support |

When you change `engine.js`, bump the `?v=` on its script tag in `index.html`. Installed copies then update the page and its engine together.

# Copy Paste

A [Subway Builder](https://store.steampowered.com/) mod that adds spatial **copy / paste** for your network — duplicate stations, junctions, or whole line segments instead of redrawing them by hand.

## Usage

Three toolbar buttons:

1. **Select** — click it, then drag a box on the map. Every track group fully inside the box is selected (built *and* blueprint track).
2. **Copy** — stores the selection to the clipboard. The button flashes to confirm.
3. **Paste** — click it; a blue ghost of the copy follows your cursor. Click a spot to drop a translated copy as **blueprints**, then commit them with the game's own **Build** button.

Stations regenerate automatically on the pasted track, and scissors crossovers can be added to it just like native track.

## Notes & limitations

- Pasted pieces land as **blueprints** (free, undoable) — nothing is built until you press Build.
- Translation is a plain lon/lat offset: faithful for nearby pastes; very long or cross-latitude jumps will skew slightly.
- Built on the official modding API plus the game's internal store bridge (the public `api.build` namespace is currently unimplemented).

## License

MIT

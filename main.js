/**
 * Network Clipboard — spatial copy/paste for Subway Builder networks.
 *
 *   1. SELECT — drag a box on the map; track groups fully inside are captured.
 *   2. COPY   — serialise the selection relative to its bbox centre → clipboard.
 *   3. PASTE  — a ghost follows the cursor; click drops a translated copy as
 *               blueprints for you to review and build.
 *
 * The official api.build namespace is an unimplemented stub, so construction is
 * driven through the internal store bridge (window.__subwayBuilder_storeCallbacks__):
 * setTracks({newTracks,newTrackGroups,regenStations}) with our pieces appended to
 * the existing collections. Pasting as blueprints (not constructed) routes the
 * final build through the game's own pipeline, so stations regenerate and
 * crossovers work. Coords are rounded to 6dp to match the game's native precision
 * (its crossover placement does exact float-equality vertex matching).
 */
(function () {
  const api = window.SubwayBuilderAPI;
  const TAG = "[Copy Paste]";
  const MOD_VERSION = "1.0.1";
  if (!api) { console.error(`${TAG} SubwayBuilderAPI not found`); return; }

  const SRC = "netclip";
  const LYR_FILL = "netclip-fill";   // selection box fill
  const LYR_LINE = "netclip-line";   // selected / ghost track lines

  // ---- state ----
  let mode = "idle";                 // idle | selecting | pasting
  let dragging = false;
  let boxStart = null, boxNow = null; // [lng,lat] corners while dragging the select box
  let selection = { trackIds: new Set(), stationIds: new Set() };
  let clipboard = null;              // { tracks, groups, center:[lng,lat] }
  let cursor = null;                 // [lng,lat] during paste
  let copiedAt = 0;                  // timestamp of last copy (Copy-button flash)

  // ---- helpers ----
  const bounds = (a, b) => ({
    minLng: Math.min(a[0], b[0]), maxLng: Math.max(a[0], b[0]),
    minLat: Math.min(a[1], b[1]), maxLat: Math.max(a[1], b[1]),
  });
  const inB = (c, bb) => c[0] >= bb.minLng && c[0] <= bb.maxLng && c[1] >= bb.minLat && c[1] <= bb.maxLat;
  const boxPolygon = (bb) => [[
    [bb.minLng, bb.minLat], [bb.maxLng, bb.minLat],
    [bb.maxLng, bb.maxLat], [bb.minLng, bb.maxLat], [bb.minLng, bb.minLat],
  ]];
  // 6dp matches the game's native precision; crossover placement does exact
  // float-equality vertex matching, so raw float offsets (13dp tails) break it.
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const translate = (coords, dLng, dLat) => coords.map((c) => [r6(c[0] + dLng), r6(c[1] + dLat)]);
  const asArray = (c) => !c ? [] : Array.isArray(c) ? c : c instanceof Map ? [...c.values()] : typeof c === "object" ? Object.values(c) : [];
  const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); }));
  const store = () => window.__subwayBuilder_storeCallbacks__?.getState?.();
  const tracksOf = (st) => asArray(st?.tracks).length ? asArray(st?.tracks) : (api.gameState.getTracks() || []);

  // ---- overlay ----
  function setData(fc) {
    const map = api.utils.getMap();
    if (map && map.getSource(SRC)) map.getSource(SRC).setData(fc);
  }
  function ensureLayers() {
    const map = api.utils.getMap();
    if (!map) return;
    if (!map.getSource(SRC)) api.map.registerSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!map.getLayer(LYR_FILL)) api.map.registerLayer({
      id: LYR_FILL, type: "fill", source: SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 },
    });
    if (!map.getLayer(LYR_LINE)) api.map.registerLayer({
      id: LYR_LINE, type: "line", source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#3b82f6", "line-width": 3, "line-opacity": 0.9 },
    });
  }

  function render() {
    const feats = [];
    if (mode === "selecting" && boxStart && boxNow)
      feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: boxPolygon(bounds(boxStart, boxNow)) } });
    if (selection.trackIds.size) {
      for (const t of tracksOf(store())) if (selection.trackIds.has(t.id) && t.coords?.length)
        feats.push({ type: "Feature", properties: { sel: 1 }, geometry: { type: "LineString", coordinates: t.coords } });
    }
    if (mode === "pasting" && clipboard && cursor) {
      const [dLng, dLat] = [cursor[0] - clipboard.center[0], cursor[1] - clipboard.center[1]];
      for (const tr of clipboard.tracks)
        feats.push({ type: "Feature", properties: { ghost: 1 }, geometry: { type: "LineString", coordinates: translate(tr.coords, dLng, dLat) } });
    }
    setData({ type: "FeatureCollection", features: feats });
  }

  // ---- select ----
  function computeSelection(bb) {
    selection = { trackIds: new Set(), stationIds: new Set() };
    for (const t of tracksOf(store())) // both constructed and blueprint tracks
      if (t.coords?.length && t.coords.every((c) => inB(c, bb))) selection.trackIds.add(t.id);
    for (const s of api.gameState.getStations() || [])
      if (s.coords && inB(s.coords, bb)) selection.stationIds.add(s.id);
  }

  // ---- copy ----
  // The unit that moves together is the TRACK GROUP: capture whole groups whose
  // member tracks fall in the selection, plus those groups' full track objects.
  function copy() {
    if (!selection.trackIds.size) { console.warn(`${TAG} nothing selected`); return; }
    const st = store();
    const allGroups = asArray(st?.trackGroups);
    const trackById = new Map(tracksOf(st).map((t) => [t.id, t]));
    const groups = allGroups.filter((g) => g.trackIds?.some((id) => selection.trackIds.has(id)));
    const tracks = [], seen = new Set();
    for (const g of groups) for (const id of g.trackIds || []) {
      const t = trackById.get(id);
      if (t && !seen.has(id)) { seen.add(id); tracks.push(t); }
    }
    if (!groups.length || !tracks.length) { console.warn(`${TAG} selection matched no track groups`); return; }
    const cTracks = tracks.map((t) => JSON.parse(JSON.stringify(t)));
    const cGroups = groups.map((g) => JSON.parse(JSON.stringify(g)));
    const allCoords = cTracks.flatMap((t) => t.coords).concat(cGroups.flatMap((g) => g.centerLine || []));
    const bb = allCoords.reduce((a, c) => ({
      minLng: Math.min(a.minLng, c[0]), maxLng: Math.max(a.maxLng, c[0]),
      minLat: Math.min(a.minLat, c[1]), maxLat: Math.max(a.maxLat, c[1]),
    }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
    clipboard = { tracks: cTracks, groups: cGroups, center: [(bb.minLng + bb.maxLng) / 2, (bb.minLat + bb.maxLat) / 2] };

    // feedback: flash the Copy button + a "Copied!" badge, then drop the highlight
    copiedAt = Date.now();
    selection = { trackIds: new Set(), stationIds: new Set() };
    render();
    flashCopied();
    api.ui.forceUpdate?.();
    setTimeout(() => api.ui.forceUpdate?.(), 800);
  }

  // "Copied!" feedback: native toast (reliable) + a small badge by the Copy button.
  function flashCopied() {
    try { api.ui.showNotification?.("Copied!", "success"); } catch { /* ignore */ }
    try {
      const btn = document.querySelector('[title="Copy selection to clipboard"]')
        || document.querySelector('[aria-label="Copy selection to clipboard"]');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const el = document.createElement("div");
      el.textContent = "Copied!";
      Object.assign(el.style, {
        position: "fixed", left: `${rect.left + rect.width / 2}px`, top: `${rect.bottom + 6}px`,
        transform: "translateX(-50%)", background: "#16a34a", color: "#fff",
        font: "600 11px system-ui, sans-serif", padding: "3px 7px", borderRadius: "5px",
        pointerEvents: "none", zIndex: "99999", whiteSpace: "nowrap",
        transition: "opacity 0.3s ease 0.5s",
      });
      document.body.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "0"; });
      setTimeout(() => el.remove(), 1000);
    } catch { /* ignore */ }
  }

  // ---- paste ----
  // Replicate the game's commit: setTracks({newTracks,newTrackGroups,regenStations}).
  // Translate coords by (click - clipboard centre); remap every id to a fresh uuid
  // (keeping the `base@@seg` track-id format and group↔track references intact).
  function paste(at) {
    if (!clipboard) { console.warn(`${TAG} clipboard empty`); return; }
    const st = store();
    if (typeof st?.setTracks !== "function") { console.error(`${TAG} store.setTracks unavailable`); return; }
    const [dLng, dLat] = [at[0] - clipboard.center[0], at[1] - clipboard.center[1]];

    const baseMap = new Map(), idMap = new Map(), groupMap = new Map();
    const newBase = (b) => { if (!baseMap.has(b)) baseMap.set(b, uuid()); return baseMap.get(b); };
    const remapTrack = (oldId) => {
      if (idMap.has(oldId)) return idMap.get(oldId);
      const i = oldId.indexOf("@@");
      const nid = i >= 0 ? newBase(oldId.slice(0, i)) + oldId.slice(i) : newBase(oldId);
      idMap.set(oldId, nid); return nid;
    };
    const remapGroup = (oldId) => { if (!groupMap.has(oldId)) groupMap.set(oldId, uuid()); return groupMap.get(oldId); };

    // Paste as BLUEPRINT so the game's own Build button runs buildBlueprints()
    // through the real construction pipeline (which makes crossovers work).
    const newTracks = clipboard.tracks.map((t) => ({
      ...t, id: remapTrack(t.id), coords: translate(t.coords, dLng, dLat),
      buildType: "blueprint", displayType: "blueprint", createdAt: Date.now(),
    }));
    const newTrackGroups = clipboard.groups.map((g) => ({
      ...g, id: remapGroup(g.id),
      trackIds: (g.trackIds || []).map(remapTrack),
      centerLine: translate(g.centerLine || [], dLng, dLat),
    }));

    // newTracks/newTrackGroups are the FULL post-op sets, not a delta — append to
    // the existing collections, else setTracks replaces the whole network.
    try {
      st.setTracks({
        newTracks: [...asArray(st.tracks), ...newTracks],
        newTrackGroups: [...asArray(st.trackGroups), ...newTrackGroups],
        regenStations: true,
        regenRoutesWithTrackIDs: [],
      });
    } catch (err) {
      console.error(`${TAG} paste failed:`, err);
    }
  }

  // ---- mode control ----
  function setMode(m) {
    mode = m;
    const map = api.utils.getMap();
    if (map) {
      if (m === "selecting") map.dragPan.disable(); else map.dragPan.enable();
      const canvas = map.getCanvas?.();
      if (canvas) canvas.style.cursor = (m === "selecting" || m === "pasting") ? "crosshair" : "";
    }
    if (m !== "pasting") cursor = null;
    api.ui.forceUpdate?.();
    render();
  }

  // ---- map wiring ----
  function wire(map) {
    ensureLayers();
    map.on("mousedown", (e) => {
      if (mode !== "selecting") return;
      e.preventDefault();
      dragging = true; boxStart = [e.lngLat.lng, e.lngLat.lat]; boxNow = boxStart.slice();
    });
    map.on("mousemove", (e) => {
      if (mode === "selecting" && dragging) { boxNow = [e.lngLat.lng, e.lngLat.lat]; render(); }
      else if (mode === "pasting") { cursor = [e.lngLat.lng, e.lngLat.lat]; render(); }
    });
    map.on("mouseup", (e) => {
      if (mode !== "selecting" || !dragging) return;
      dragging = false; boxNow = [e.lngLat.lng, e.lngLat.lat];
      computeSelection(bounds(boxStart, boxNow));
      boxStart = boxNow = null;
      setMode("idle");
    });
    map.on("click", (e) => {
      if (mode !== "pasting") return;
      paste([e.lngLat.lng, e.lngLat.lat]);
      setMode("idle");
    });
    // Right-click cancels paste/select mode without committing (drops the ghost).
    map.on("contextmenu", (e) => {
      if (mode === "idle") return;
      e.preventDefault?.();
      e.originalEvent?.preventDefault?.();
      e.originalEvent?.stopPropagation?.();
      dragging = false; boxStart = boxNow = null;
      setMode("idle");
    });
    map.on("styledata", () => { ensureLayers(); render(); }); // game drops layers constantly
  }

  // ---- toolbar ----
  function toolbar() {
    api.ui.addToolbarButton({ id: "netclip.select", tooltip: "Select network (drag a box)", icon: "BoxSelect",
      onClick: () => setMode(mode === "selecting" ? "idle" : "selecting"), isActive: () => mode === "selecting" });
    api.ui.addToolbarButton({ id: "netclip.copy", tooltip: "Copy selection to clipboard", icon: "Copy",
      onClick: () => copy(), isActive: () => Date.now() - copiedAt < 800 });
    api.ui.addToolbarButton({ id: "netclip.paste", tooltip: "Paste clipboard (then click a spot)", icon: "ClipboardPaste",
      onClick: () => setMode(mode === "pasting" ? "idle" : "pasting"), isActive: () => mode === "pasting" });
  }

  // ---- keyboard: Cmd/Ctrl+C copies the selection, Cmd/Ctrl+V toggles paste mode ----
  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // don't hijack typing
    // Escape cancels paste/select mode (drops the ghost) without committing.
    if (e.key === "Escape" && mode !== "idle") { e.preventDefault(); dragging = false; boxStart = boxNow = null; setMode("idle"); return; }
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key?.toLowerCase();
    if (k === "c" && selection.trackIds.size) { e.preventDefault(); copy(); }
    else if (k === "v" && clipboard) { e.preventDefault(); setMode(mode === "pasting" ? "idle" : "pasting"); }
  }
  // rebind cleanly (no stacked listeners across reloads)
  if (window.__netclipOnKey) document.removeEventListener("keydown", window.__netclipOnKey);
  window.__netclipOnKey = onKey;
  document.addEventListener("keydown", onKey);

  api.hooks.onMapReady((map) => {
    wire(map);
    toolbar();
    console.log(`${TAG} v${MOD_VERSION} ready — Select → Copy → Paste`);
  });
})();

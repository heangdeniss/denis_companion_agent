// Switches an outfit in the running app and measures what the character really
// looks like, on the frame that the window shows.
//
// The point is to check an outfit without eyes. The body of the character is a
// known coordinate system: the mesh in tools/uv-layout.json holds the body
// position of every vertex, the model knows where those vertices are on screen,
// so any point of the body can be followed through the whole pipeline:
//
//   body point -> triangle -> uv -> atlas pixel -> painted colour
//              -> deformed vertex -> screen pixel -> colour the window shows
//
// `--map` prints that as a little picture of the body (one character per colour
// class), `--probe` prints the pieces that cover one point in draw order.
//
// Usage:
//   node tools/preview-outfit.mjs --map yukata
//   node tools/preview-outfit.mjs --probe 0,0.45 --probe 0,0.2 seifuku
//   node tools/preview-outfit.mjs default yukata seifuku
//
// The app has to run with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set to
// --remote-debugging-port=9222.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "./png.mjs";

const PORT = 9222;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = path.join(ROOT, "tools", "uv-layout.json");
const ATLAS_DIR = path.join(ROOT, "assets", "characters", "aria");

const ids = [];
const flags = new Set();
const probes = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--probe") {
    const value = process.argv[++i];
    if (value) probes.push(value.split(",").map(Number));
  } else if (arg.startsWith("--probe=")) {
    probes.push(arg.slice("--probe=".length).split(",").map(Number));
  } else if (arg.startsWith("--")) {
    flags.add(arg);
  } else {
    ids.push(arg);
  }
}
const strip = flags.has("--strip");
const mapMode = flags.has("--map");

if (!ids.length) {
  console.error("usage: node tools/preview-outfit.mjs [--map] [--strip] [--probe x,y] <outfit-id> ...");
  process.exit(1);
}

const layout = JSON.parse(fs.readFileSync(LAYOUT, "utf8"));
const layoutById = new Map(layout.drawables.map((d) => [d.index, d]));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
if (!page) {
  console.error("no tauri page found - is the app running with remote debugging?");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  const cb = pending.get(msg.id);
  if (cb) {
    pending.delete(msg.id);
    cb(msg);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params) =>
  new Promise((r) => {
    const myId = ++id;
    pending.set(myId, r);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

async function evaluate(expression) {
  const out = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (out.result?.exceptionDetails) {
    throw new Error(out.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return out.result.result.value;
}

/**
 * The live transform of the model plus the deformed mesh: where the vertices
 * of every drawable are right now, and in which order the drawables are drawn.
 */
const LIVE = `
(() => {
  const model = window.ei.character.model;
  const core = model.internalModel.coreModel;
  const src = core._model.drawables;
  const ci = src.canvasinfo || core._model.canvasinfo;
  const scale = model.scale.x;
  const toCss = (x, y) => [
    model.x + (ci.CanvasOriginX + x * ci.PixelsPerUnit) * scale,
    model.y + (ci.CanvasOriginY - y * ci.PixelsPerUnit) * scale,
  ];
  const pieces = [];
  for (let i = 0; i < src.count; i++) {
    const n = src.vertexCounts[i];
    if (!n) continue;
    const p = core.getDrawableVertexPositions(i);
    const css = new Array(n * 2);
    for (let k = 0; k < n; k++) {
      const xy = toCss(p[k * 2], p[k * 2 + 1]);
      css[k * 2] = xy[0];
      css[k * 2 + 1] = xy[1];
    }
    pieces.push({
      i,
      render: src.renderOrders[i] || src.drawOrders[i],
      opacity: +core.getDrawableOpacity(i).toFixed(3),
      css,
    });
  }
  return { pieces, screenW: window.innerWidth, screenH: window.innerHeight };
})()
`;

const WEAR = (outfit) => `
(async () => {
  const model = window.ei.character.model;
  const url = model.textures[0].baseTexture.resource.url;
  const baseUrl = url.slice(0, url.indexOf("/assets/") + "/assets/".length);
  // The app caches the atlases of the outfits it has worn. The tools repaint
  // them, so the cache has to be dropped to see the new artwork.
  window.ei.character.outfitTextures?.delete(${JSON.stringify(outfit)});
  if (${JSON.stringify(outfit)} === "default") {
    return window.ei.character.setOutfit(null, baseUrl);
  }
  return window.ei.character.setOutfit({
    id: ${JSON.stringify(outfit)},
    label: ${JSON.stringify(outfit)},
    category: "",
    path: "characters/aria/outfits/" + ${JSON.stringify(outfit)},
    textures: [{ index: 1, file: "texture_01.png" }],
    available: true,
    problem: "",
  }, baseUrl);
})()
`;

const TEXTURE = `
(() => {
  const texture = window.ei.character.model.textures[1];
  const url = texture.baseTexture.resource.url;
  return { url: url.split("/assets/").pop(), width: texture.width, height: texture.height };
})()
`;

// ---------------------------------------------------------------- geometry
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Barycentric coordinates of (px,py) in the triangle a,b,c. */
function barycentric(px, py, ax, ay, bx, by, cx, cy) {
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (!area) return null;
  const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
  const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
  const w2 = 1 - w0 - w1;
  if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) return null;
  return [w0, w1, w2];
}

/**
 * Every piece that covers a point of the body, with the barycentric weights and
 * the uv of that point. The triangles live in the artwork pose, which is the
 * pose the atlas was painted in.
 */
function hitsAt(x, y) {
  const hits = [];
  for (const drawable of layout.drawables) {
    if (drawable.opacity < 0.01) continue;
    // The hit areas are quads with all four uvs on the same transparent texel:
    // they are never drawn, but their mesh covers the whole body and would
    // otherwise win the "which piece is in front" question.
    const box = drawable.uvBox;
    if (!box || box.u1 - box.u0 < 0.001 || box.v1 - box.v0 < 0.001) continue;
    const pos = drawable.positions;
    const uvs = drawable.uvs;
    const indices = drawable.indices;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];
      const w = barycentric(
        x,
        y,
        pos[i0 * 2],
        pos[i0 * 2 + 1],
        pos[i1 * 2],
        pos[i1 * 2 + 1],
        pos[i2 * 2],
        pos[i2 * 2 + 1],
      );
      if (!w) continue;
      const u = w[0] * uvs[i0 * 2] + w[1] * uvs[i1 * 2] + w[2] * uvs[i2 * 2];
      const v = w[0] * uvs[i0 * 2 + 1] + w[1] * uvs[i1 * 2 + 1] + w[2] * uvs[i2 * 2 + 1];
      hits.push({ index: drawable.index, uv: [u, v], weights: w, vertices: [i0, i1, i2] });
      break;
    }
  }
  return hits;
}

const classOf = (r, g, b) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 40) return "k"; // near black
  if (min > 215) return "w"; // white
  if (g > r + 15 && g > b + 8) return "g"; // green (the European gown)
  if (b > r + 40 && b > g + 25) return "n"; // navy / indigo
  if (b > 100 && r > 150 && r - g > 40 && b - g > 8) return "p"; // rose / pink silk
  if (r > 150 && g < 110 && b < 130) return "r"; // red
  if (r > 190 && g > 150 && b > 120 && r >= g && g >= b - 10 && b < 235) return "s"; // skin / cream
  if (r > 100 && r < 160 && b > 95 && b < 160 && Math.abs(r - b) < 25) return "h"; // mauve hair
  if (r > 55 && r < 120 && Math.abs(r - g) < 20 && b > r && b < r + 45) return "B"; // base garment
  return "?";
};

/** Reads a pixel of the frame at a css position. */
function pixelAt(frame, k, x, y) {
  const px = Math.round(x * k);
  const py = Math.round(y * k);
  if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null;
  const p = (py * frame.width + px) * 4;
  return [frame.data[p], frame.data[p + 1], frame.data[p + 2], frame.data[p + 3]];
}

for (const outfit of ids) {
  const ok = await evaluate(WEAR(outfit));
  await new Promise((r) => setTimeout(r, 900));
  const texture = await evaluate(TEXTURE);
  const live = await evaluate(LIVE);
  // A window that is not in the foreground is composited darker by Windows,
  // which would make every colour of the map unreadable.
  await send("Page.bringToFront");
  await evaluate("window.focus(); true");
  await new Promise((r) => setTimeout(r, 400));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const frame = decodePng(Buffer.from(shot.result.data, "base64"));
  const k = frame.width / live.screenW;
  const liveById = new Map(live.pieces.map((p) => [p.i, p]));

  console.log(`\n=== ${outfit}  (ok=${ok})  clothing page = ${texture.url}`);
  console.log(`    window ${live.screenW}x${live.screenH}, frame ${frame.width}x${frame.height}`);

  if (mapMode) {
    // One character per sample of the body. The most powerful check there is
    // without eyes: the design can be read like a picture.
    console.log("    x -0.20 ........................ 0.20");
    for (let y = 0.8; y > -0.42; y -= 0.02) {
      let row = "";
      for (let x = -0.2; x <= 0.2; x += 0.01) {
        const hits = hitsAt(x, y);
        if (!hits.length) {
          row += " ";
          continue;
        }
        // The piece with the highest draw order is the one that is seen.
        let best = null;
        for (const hit of hits) {
          const order = liveById.get(hit.index)?.render ?? -1;
          if (!best || order > best.order) best = { hit, order };
        }
        const piece = liveById.get(best.hit.index);
        if (!piece) {
          row += " ";
          continue;
        }
        const w = best.hit.weights;
        const v = best.hit.vertices;
        let sx = 0;
        let sy = 0;
        for (let j = 0; j < 3; j++) {
          sx += w[j] * piece.css[v[j] * 2];
          sy += w[j] * piece.css[v[j] * 2 + 1];
        }
        const colour = pixelAt(frame, k, sx, sy);
        if (!colour || colour[3] < 200) {
          row += " ";
          continue;
        }
        row += classOf(colour[0], colour[1], colour[2]);
      }
      console.log(`  ${y.toFixed(2).padStart(5)} ${row}`);
    }
    continue;
  }

  if (probes.length) {
    const clothingAtlas = decodePng(
      fs.readFileSync(
        path.join(
          ATLAS_DIR,
          outfit === "default" ? "base/Haru.2048/texture_01.png" : `outfits/${outfit}/texture_01.png`,
        ),
      ),
    );
    const skinAtlas = decodePng(
      fs.readFileSync(path.join(ATLAS_DIR, "base/Haru.2048/texture_00.png")),
    );
    const sampleAtlas = (drawable, uv) => {
      const atlas = drawable.texture === 1 ? clothingAtlas : skinAtlas;
      const x = clamp(Math.floor(uv[0] * atlas.width), 0, atlas.width - 1);
      // v = 0 is the bottom row of the PNG, the image is uploaded flipped.
      const y = clamp(Math.floor((1 - uv[1]) * atlas.height), 0, atlas.height - 1);
      const p = (y * atlas.width + x) * 4;
      return `rgb(${atlas.data[p]},${atlas.data[p + 1]},${atlas.data[p + 2]})`;
    };
    const sampleFlipped = (drawable, uv) => sampleAtlas(drawable, [uv[0], 1 - uv[1]]);
    for (const [x, y] of probes) {
      const hits = hitsAt(x, y);
      console.log(`\n  body point (${x}, ${y}) - ${hits.length} piece(s) cover it`);
      hits.sort((a, b) => (liveById.get(b.index)?.render ?? -1) - (liveById.get(a.index)?.render ?? -1));
      for (const hit of hits) {
        const piece = liveById.get(hit.index);
        const drawable = layoutById.get(hit.index);
        if (!piece) continue;
        const w = hit.weights;
        const v = hit.vertices;
        let sx = 0;
        let sy = 0;
        for (let j = 0; j < 3; j++) {
          sx += w[j] * piece.css[v[j] * 2];
          sy += w[j] * piece.css[v[j] * 2 + 1];
        }
        const shown = pixelAt(frame, k, sx, sy);
        console.log(
          `    render ${String(piece.render).padStart(3)}  #${String(hit.index).padStart(2)} ${(drawable.part ?? "").padEnd(17)} tex${drawable.texture}  at (${sx.toFixed(1)},${sy.toFixed(1)})  atlas ${sampleAtlas(
            drawable,
            hit.uv,
          )}  flipped ${sampleFlipped(drawable, hit.uv)}  screen ${shown ? `rgb(${shown.slice(0, 3).join(",")}) a=${shown[3]}` : "outside"}`,
        );
      }
    }
    continue;
  }

  if (strip) {
    for (let y = 0.82; y > -0.6; y -= 0.04) {
      const hits = hitsAt(0, y);
      if (!hits.length) {
        console.log(`  y=${y.toFixed(2)}  -`);
        continue;
      }
      let best = null;
      for (const hit of hits) {
        const order = liveById.get(hit.index)?.render ?? -1;
        if (!best || order > best.order) best = { hit, order };
      }
      const piece = liveById.get(best.hit.index);
      const w = best.hit.weights;
      const v = best.hit.vertices;
      let sx = 0;
      let sy = 0;
      for (let j = 0; j < 3; j++) {
        sx += w[j] * piece.css[v[j] * 2];
        sy += w[j] * piece.css[v[j] * 2 + 1];
      }
      const colour = pixelAt(frame, k, sx, sy);
      console.log(
        `  y=${y.toFixed(2)}  #${String(best.hit.index).padStart(2)} render=${String(best.order).padStart(3)}  ${
          colour ? `rgb(${colour.slice(0, 3).join(",")})` : "outside"
        }`,
      );
    }
    continue;
  }

  console.log("  (use --map, --strip or --probe x,y to read the outfit)");
}

ws.close();

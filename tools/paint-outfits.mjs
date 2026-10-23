// Paints real outfit artwork into the clothing page of the model.
//
// Why this works without an artist: every pixel of the clothing page knows
// where it sits on the body, because the mesh of every garment piece is in
// tools/uv-layout.json (position + uv + triangle list). So an outfit can be
// designed in body space - "the skirt is below the waist", "the collar is a V
// at the neck" - and every pixel is then painted from that description. The
// design follows the body exactly, no matter how the atlas is packed.
//
// The shading of the base artwork (folds, shadows, the line art) is kept: a
// design only says which colour a zone has, the brightness of the pixel is
// taken from the base art. That is what makes it look painted instead of
// flooded.
//
// The alpha channel is never touched, so the silhouette of the character and
// the click-through mask stay exactly the same.
//
// Usage:
//   node tools/paint-outfits.mjs                 # paint every outfit that has a design
//   node tools/paint-outfits.mjs yukata seifuku  # paint only these
//   node tools/paint-outfits.mjs --dry yukata    # report, write nothing
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "./png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CHARACTER = path.join(ROOT, "assets", "characters", "aria");
const BASE_ATLAS = path.join(CHARACTER, "base", "Haru.2048", "texture_01.png");
const OUTFITS = path.join(CHARACTER, "outfits");
const LAYOUT = path.join(HERE, "uv-layout.json");

// ---------------------------------------------------------------- geometry
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Rasterizes the clothing mesh. Every covered atlas pixel gets the piece it
 * belongs to and the point of the body it is painted on.
 */
function buildBodyMap(layout, width, height, onlyPage = 1) {
  const total = width * height;
  const piece = new Int16Array(total).fill(-1);
  const bodyX = new Float32Array(total);
  const bodyY = new Float32Array(total);
  const covered = new Map();

  for (const drawable of layout.drawables) {
    if (drawable.texture !== onlyPage) continue;
    const pos = drawable.positions;
    const uvs = drawable.uvs;
    const indices = drawable.indices;
    let count = 0;

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];
      // The UVs of the model point into the texture the way WebGL samples it,
      // and Pixi uploads the image flipped (UNPACK_FLIP_Y_WEBGL), so v = 0 is
      // the *bottom* row of the PNG. Reading v straight into the image would
      // paint every design upside down on the model.
      const ax = uvs[i0 * 2] * width;
      const ay = (1 - uvs[i0 * 2 + 1]) * height;
      const bx = uvs[i1 * 2] * width;
      const by = (1 - uvs[i1 * 2 + 1]) * height;
      const cx = uvs[i2 * 2] * width;
      const cy = (1 - uvs[i2 * 2 + 1]) * height;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (area === 0) continue;
      const px0 = pos[i0 * 2];
      const py0 = pos[i0 * 2 + 1];
      const px1 = pos[i1 * 2];
      const py1 = pos[i1 * 2 + 1];
      const px2 = pos[i2 * 2];
      const py2 = pos[i2 * 2 + 1];

      for (let y = minY; y <= maxY; y++) {
        const fy = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const fx = x + 0.5;
          let w0 = ((bx - fx) * (cy - fy) - (cx - fx) * (by - fy)) / area;
          let w1 = ((cx - fx) * (ay - fy) - (ax - fx) * (cy - fy)) / area;
          let w2 = 1 - w0 - w1;
          if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
          const at = y * width + x;
          piece[at] = drawable.index;
          bodyX[at] = w0 * px0 + w1 * px1 + w2 * px2;
          bodyY[at] = w0 * py0 + w1 * py1 + w2 * py2;
          count++;
        }
      }
    }
    covered.set(drawable.index, count);
  }
  return { piece, bodyX, bodyY, covered };
}

// ---------------------------------------------------------------- designs
const rgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

/** Body landmarks, read from the mesh, in model units (y is up). */
const BODY = {
  collarTop: 0.586,
  neck: 0.545,
  shoulder: 0.52,
  bust: 0.42,
  waist: 0.202,
  hem: -0.201,
};

/** Which garment a drawable is, from the part names of the model. */
const GARMENT = {
  skirt: [20],
  top: [16, 17, 18, 19],
  neck: [23, 24, 25, 26, 28],
  arms: [0, 1, 5, 7, 10, 11, 13, 14],
};

/** The pieces that make up the body of an outfit (not the hair, not the hit area). */
const BODY_PIECES = new Set([...GARMENT.skirt, ...GARMENT.top, ...GARMENT.neck, ...GARMENT.arms]);

/** A stable pseudo random value in 0..1 for a grid cell. */
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The designs. Every function gets the body point and returns the colour that
 * belongs there, or null to leave the pixel alone.
 *
 * The return value may also carry `flat: true`, then the shading of the base
 * artwork is not applied - used for fine details that must stay crisp.
 */
const DESIGNS = {
  // ------------------------------------------------------------ seifuku
  // The Japanese sailor school uniform: white blouse, navy sailor collar with
  // a red neckerchief and a navy pleated skirt.
  seifuku: {
    label: "Sailor Uniform",
    paint({ x, y, pieceId }) {
      const navy = rgb("#1d2a4d");
      const navyDeep = rgb("#16203c");
      const white = rgb("#f4f4f8");
      const red = rgb("#c3263b");
      const redDeep = rgb("#8f1728");

      if (GARMENT.skirt.includes(pieceId)) {
        const t = (y - BODY.hem) / (BODY.waist - BODY.hem); // 0 hem, 1 waist
        if (t > 0.88) return navyDeep; // waistband
        // Pleats: soft vertical bands, they follow the fold of the skirt.
        const band = Math.floor((x + 0.6) / 0.026);
        return band % 2 === 0 ? navy : rgb("#243357");
      }

      if (GARMENT.arms.includes(pieceId)) {
        // The wrist is the lower end of the sleeve.
        if (y < 0.115) return navyDeep;
        if (y < 0.135) return rgb("#dfe3ee"); // thin white piping over the cuff
        return white;
      }

      if (GARMENT.neck.includes(pieceId)) {
        // The collar band around the neck and the knot of the neckerchief.
        if (y > 0.545) return navy;
        return y < BODY.bust + 0.06 ? red : navy;
      }

      if (GARMENT.top.includes(pieceId)) {
        // The sailor collar: a flap over the shoulders, its inner edge makes a
        // V at the chest. Inside the V the white blouse shows.
        const vEdge = 0.115 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
        const inV = Math.abs(x) < vEdge;
        // The neckerchief hangs inside the V, a small triangle.
        if (y > 0.395 && y < 0.505) {
          const half = 0.032 * (y - 0.395) / 0.11;
          if (Math.abs(x) < half) return y > 0.475 ? redDeep : red;
        }
        if (y > BODY.bust && !inV) return navy;
        // Below the top edge of the skirt the blouse is tucked in, so it takes
        // the colour of the skirt instead of hanging white over it.
        if (y < BODY.waist) return navy;
        return white;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ yukata
  // A summer kimono: indigo cotton with pale sakura blossoms, a cream obi and
  // the white collar band (eri).
  yukata: {
    label: "Yukata",
    paint({ x, y, pieceId }) {
      const indigo = rgb("#2b3b63");
      const indigoDeep = rgb("#22304f");
      const cream = rgb("#ece2c9");
      const gold = rgb("#c9a44c");
      const pink = rgb("#e9a8bb");
      const pinkDeep = rgb("#d97d97");

      const isBody = GARMENT.skirt.includes(pieceId) || GARMENT.top.includes(pieceId);
      const isArm = GARMENT.arms.includes(pieceId);
      const isNeck = GARMENT.neck.includes(pieceId);

      // The obi: a wide sash over the waist, it also hides the seam between
      // the top and the skirt.
      if (isBody || isNeck) {
        if (y > 0.166 && y < 0.286) {
          if (y > 0.214 && y < 0.238) return gold; // the cord
          return cream;
        }
      }

      // The collar band (eri) follows the neckline down to the obi.
      if (isBody || isNeck) {
        const vEdge = 0.115 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
        const band = Math.abs(Math.abs(x) - vEdge);
        if (y > BODY.bust && y < BODY.neck && band < 0.022) return cream;
        if (isNeck && y >= BODY.neck) return cream;
      }

      // Wrist cuffs of the wide sleeves.
      if (isArm && y < 0.1) return cream;

      // The fabric: indigo with a sakura pattern.
      const fabric = y > 0.29 && y < 0.34 ? indigoDeep : indigo;
      const size = 0.058;
      const gx = Math.floor(x / size);
      const gy = Math.floor(y / size);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = gx + ox;
          const cy = gy + oy;
          const h = hash2(cx, cy);
          if (h > 0.62) continue;
          const fx = (cx + 0.2 + hash2(cx + 11, cy + 7) * 0.6) * size;
          const fy = (cy + 0.2 + hash2(cx + 3, cy + 17) * 0.6) * size;
          const dx = x - fx;
          const dy = y - fy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const radius = 0.011 + h * 0.006;
          if (d < radius * 0.3) return { ...gold, flat: true };
          if (d < radius) {
            // Five petals: a ring with five gaps.
            const angle = Math.atan2(dy, dx);
            const petal = Math.cos(angle * 5);
            if (petal > -0.45 || d < radius * 0.55) return { ...pink, flat: true };
            return { ...pinkDeep, flat: true };
          }
        }
      }
      return fabric;
    },
  },

  // ------------------------------------------------------------ miko
  // The shrine maiden: a white kosode with wide sleeves, a crimson hakama with
  // sharp pleats and a white sash (himo) with the knot at the front.
  miko: {
    label: "Miko (Shrine Maiden)",
    paint({ x, y, pieceId }) {
      const white = rgb("#f8f6f1");
      const whiteShade = rgb("#e4dfd2");
      const red = rgb("#c0273a");
      const redDeep = rgb("#8e1626");
      const cord = rgb("#efe8da");

      const isBody = GARMENT.skirt.includes(pieceId) || GARMENT.top.includes(pieceId);
      const isNeck = GARMENT.neck.includes(pieceId);

      // The white sash over the hakama.
      if ((isBody || isNeck) && y > 0.194 && y < 0.268) {
        if (Math.abs(x) < 0.032 && y > 0.208 && y < 0.252) return redDeep; // the knot
        if (y > 0.226 && y < 0.238) return whiteShade; // its fold
        return cord;
      }

      if (GARMENT.skirt.includes(pieceId)) {
        // Hakama: crimson with pleats that run all the way down.
        const pleat = (((x + 0.5) % 0.03) + 0.03) % 0.03;
        return pleat < 0.007 ? redDeep : red;
      }

      if (GARMENT.top.includes(pieceId)) {
        if (y < BODY.waist) return red; // tucked into the hakama
        // The collar of the kosode crosses at the chest, a soft white band.
        const vEdge = 0.1 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
        if (y > BODY.bust && y < BODY.neck) {
          const band = Math.abs(Math.abs(x) - vEdge);
          if (band < 0.022) return whiteShade;
        }
        return white;
      }

      if (GARMENT.neck.includes(pieceId)) return y > 0.52 ? white : whiteShade;

      if (GARMENT.arms.includes(pieceId)) {
        // The wide sleeve, the red lining shows at the wrist.
        if (y < 0.085) return redDeep;
        return white;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ furisode
  // A formal kimono: deep plum silk with large gold blossoms and a gold obi.
  furisode: {
    label: "Furisode Kimono",
    paint({ x, y, pieceId }) {
      const plum = rgb("#8e1f3c");
      const plumDeep = rgb("#6b1327");
      const cream = rgb("#f0e6cc");
      const gold = rgb("#c9a44c");
      const goldDeep = rgb("#a5813a");
      const pink = rgb("#eeb3c4");

      const isBody = GARMENT.skirt.includes(pieceId) || GARMENT.top.includes(pieceId);
      const isNeck = GARMENT.neck.includes(pieceId);

      // The obi: a wide gold sash with a darker band through its middle.
      if (isBody || isNeck) {
        if (y > 0.158 && y < 0.292) {
          if (y > 0.216 && y < 0.238) return goldDeep;
          return gold;
        }
      }

      // The collar band (eri) is cream and follows the neckline.
      if (isBody || isNeck) {
        const vEdge = 0.115 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
        const band = Math.abs(Math.abs(x) - vEdge);
        if (y > BODY.bust && y < BODY.neck && band < 0.024) return cream;
        if (isNeck && y >= BODY.neck) return cream;
      }

      if (GARMENT.arms.includes(pieceId) && y < 0.1) return cream;

      // Deep plum silk, darker at the bottom where the light does not reach.
      const fabric = y < -0.05 ? plumDeep : plum;

      // Large gold blossoms, sparser than the yukata pattern.
      const size = 0.086;
      const gx = Math.floor(x / size);
      const gy = Math.floor(y / size);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = gx + ox;
          const cy = gy + oy;
          const h = hash2(cx + 41, cy + 13);
          if (h > 0.6) continue;
          const fx = (cx + 0.2 + hash2(cx + 5, cy + 2) * 0.6) * size;
          const fy = (cy + 0.2 + hash2(cx + 9, cy + 21) * 0.6) * size;
          const dx = x - fx;
          const dy = y - fy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const radius = 0.015 + h * 0.008;
          if (d < radius * 0.35) return { ...goldDeep, flat: true };
          if (d < radius) {
            const angle = Math.atan2(dy, dx);
            if (Math.cos(angle * 6) > -0.5) return { ...gold, flat: true };
            return { ...pink, flat: true };
          }
        }
      }
      return fabric;
    },
  },

  // ------------------------------------------------------------ blazer
  // The other school uniform: a navy blazer over a white shirt with a red
  // ribbon and a grey pleated skirt.
  blazer: {
    label: "School Blazer",
    paint({ x, y, pieceId }) {
      const navy = rgb("#232f4e");
      const navyDeep = rgb("#18213a");
      const white = rgb("#f4f4f8");
      const grey = rgb("#59606f");
      const greyDeep = rgb("#474d5a");
      const line = rgb("#7b8397");
      const red = rgb("#c3263b");
      const redDeep = rgb("#8f1728");
      const gold = rgb("#c9a44c");

      if (GARMENT.skirt.includes(pieceId)) {
        const t = (y - BODY.hem) / (BODY.waist - BODY.hem);
        if (t > 0.9) return navyDeep;
        const pleat = (((x + 0.5) % 0.032) + 0.032) % 0.032;
        if (pleat < 0.008) return greyDeep;
        // A fine check: one thin line across every few centimetres.
        if (((y + 1) % 0.05) < 0.0045) return line;
        return grey;
      }

      if (GARMENT.arms.includes(pieceId)) {
        // The blazer sleeve, a white piping above the cuff.
        if (y < 0.09) return navyDeep;
        if (y < 0.108) return white;
        return navy;
      }

      if (GARMENT.neck.includes(pieceId)) {
        return y > 0.5 ? white : red;
      }

      if (GARMENT.top.includes(pieceId)) {
        const vEdge = 0.1 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
        // The ribbon of the shirt, a small triangle at the collar.
        if (y > 0.44 && y < 0.52) {
          const half = 0.036 * ((y - 0.44) / 0.08);
          if (Math.abs(x) < half) return y > 0.492 ? redDeep : red;
        }
        if (y > BODY.bust) {
          const edge = Math.abs(Math.abs(x) - vEdge);
          if (edge < 0.016) return navyDeep; // the lapel line
          if (Math.abs(x) > vEdge) return navy;
        }
        // A gold button on the front seam.
        if (y > 0.21 && y < 0.42) {
          if (Math.abs(x) < 0.012 && (Math.abs(y - 0.254) < 0.013 || Math.abs(y - 0.33) < 0.013)) {
            return gold;
          }
          if (Math.abs(x) < 0.004) return navyDeep; // the opening
        }
        // The blazer is closed: below the collar it is navy all the way down.
        return navy;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ europe
  // A European evening gown: a fitted emerald bodice with a lace chemisette,
  // gold buttons, a high lace collar, sleeves with lace cuffs and a full skirt
  // with a lace hem.
  europe: {
    label: "European Gown",
    paint({ x, y, pieceId }) {
      const emerald = rgb("#1f4d3e");
      const emeraldDeep = rgb("#163a2f");
      const emeraldLight = rgb("#2a6350");
      const cream = rgb("#efe6d2");
      const creamDeep = rgb("#d7cab0");
      const gold = rgb("#c9a44c");
      const rose = rgb("#c96a86");

      // The lace is cream with small openwork holes, so it reads as lace and
      // not as a flat white band.
      const lace = hash2(Math.floor(x * 150), Math.floor(y * 150)) > 0.8 ? creamDeep : cream;

      const isNeck = GARMENT.neck.includes(pieceId);

      // The high collar around the throat.
      if (isNeck) return y > 0.5 ? lace : emerald;

      if (GARMENT.arms.includes(pieceId)) {
        // The sleeve, the lace cuff shows at the wrist.
        if (y < 0.098) return lace;
        if (y < 0.114) return creamDeep;
        if (y > 0.5) return emeraldLight; // the sleeve cap
        return emerald;
      }

      if (GARMENT.skirt.includes(pieceId)) {
        // The lace ruffle at the hem and the gold trim above it.
        if (y < -0.135) return lace;
        if (y < -0.115) return gold;
        const panel = (((x + 0.5) % 0.055) + 0.055) % 0.055;
        if (panel < 0.004) return emeraldDeep;
        return emerald;
      }

      if (GARMENT.top.includes(pieceId)) {
        // The lace shoulder yoke.
        if (y > 0.505) return lace;

        // A V of lace above the bust, with the brooch at the throat.
        if (y > BODY.bust && y < 0.53) {
          const vEdge = 0.1 * clamp((y - BODY.bust) / (BODY.neck - BODY.bust), 0, 1);
          if (Math.abs(x) < vEdge) {
            if (y > 0.452 && y < 0.5 && Math.abs(x) < 0.019) return rose;
            return lace;
          }
        }

        // The gold buttons down the front of the bodice and its seam.
        if (y > 0.215 && y < 0.44) {
          if (
            Math.abs(x) < 0.011 &&
            (Math.abs(y - 0.42) < 0.011 ||
              Math.abs(y - 0.368) < 0.011 ||
              Math.abs(y - 0.316) < 0.011 ||
              Math.abs(y - 0.264) < 0.011)
          ) {
            return gold;
          }
          if (Math.abs(x) < 0.0035) return emeraldDeep;
        }

        // The waist belt, with a gold line under it.
        if (y > BODY.waist && y < 0.238) return emeraldLight;
        if (y > 0.238 && y < 0.246) return gold;
        return emerald;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ zero_two
  // The red pilot suit of Zero Two (Darling in the Franxx): a glossy crimson
  // bodysuit with white trim, a black chest plate and the white collar ring.
  zero_two: {
    label: "Zero Two (Pilot Suit)",
    paint({ x, y, pieceId }) {
      const red = rgb("#cf1f36");
      const redDeep = rgb("#9c1325");
      const white = rgb("#f2f0ea");
      const black = rgb("#1d1d27");
      const grey = rgb("#3b3b49");

      // The white ring the suit closes with around the throat.
      if (GARMENT.neck.includes(pieceId)) return y > 0.5 ? white : red;

      if (GARMENT.arms.includes(pieceId)) {
        // The white cuff, the sleeve and the white seam at the shoulder.
        if (y < 0.098) return white;
        if (y < 0.112) return redDeep;
        if (y > 0.512) return white;
        if (y > 0.5) return redDeep;
        return red;
      }

      if (GARMENT.skirt.includes(pieceId)) {
        // The panel seams run all the way down the suit.
        for (const sx of [-0.12, -0.041, 0.041, 0.12]) {
          if (Math.abs(x - sx) < 0.0045) return white;
        }
        return y < -0.15 ? redDeep : red;
      }

      if (GARMENT.top.includes(pieceId)) {
        // The white collar ring.
        if (y > 0.497) return white;
        // The black chest plate, edged in white.
        if (y > 0.432) {
          const edge = Math.abs(Math.abs(x) - 0.078);
          if (edge < 0.009) return white;
          if (Math.abs(x) < 0.078) return y > 0.483 ? grey : black;
        }
        // The white belt and the zip that runs down the front.
        if (y > 0.155 && y < 0.18) return white;
        if (Math.abs(x) < 0.005) return white;
        if (y < BODY.waist) {
          for (const sx of [-0.12, -0.041, 0.041, 0.12]) {
            if (Math.abs(x - sx) < 0.0045) return white;
          }
        }
        return red;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ rococo
  // A French court gown: rose silk with a cream petticoat, a laced stomacher,
  // a bertha of lace over the shoulders and a damask of small flowers.
  rococo: {
    label: "Rococo Gown",
    paint({ x, y, pieceId }) {
      const rose = rgb("#d489a0");
      const roseDeep = rgb("#b25f7c");
      const roseLight = rgb("#e7aebf");
      const cream = rgb("#f4e9d6");
      const creamDeep = rgb("#ddcbb0");
      const gold = rgb("#c9a44c");

      const lace = hash2(Math.floor(x * 150), Math.floor(y * 150)) > 0.82 ? creamDeep : cream;
      const mod = (v, m) => ((v % m) + m) % m;

      // The skirt and the part of the top below the waist are the same cloth.
      const skirtCloth = (xx, yy) => {
        if (yy < -0.168) return lace;
        if (yy < -0.15) return gold;
        if (Math.abs(xx) < 0.088) {
          if (Math.abs(Math.abs(xx) - 0.088) < 0.007) return gold;
          if (mod(yy + 1, 0.07) < 0.004) return creamDeep;
          return cream;
        }
        return rose;
      };

      if (GARMENT.neck.includes(pieceId)) return y > 0.505 ? lace : cream;

      if (GARMENT.arms.includes(pieceId)) {
        if (y < 0.104) return lace; // the lace cuff
        if (y < 0.12) return gold;
        if (y > 0.5) return roseLight; // the puff at the shoulder
        return rose;
      }

      if (GARMENT.skirt.includes(pieceId)) {
        if (Math.abs(x) < 0.088) return skirtCloth(x, y);
        // The damask: small cream flowers with a gold heart.
        const gx = Math.floor(x / 0.07);
        const gy = Math.floor(y / 0.07);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const cx = gx + ox;
            const cy = gy + oy;
            const h = hash2(cx + 3, cy + 17);
            if (h > 0.55) continue;
            const fx = (cx + 0.5 + (hash2(cx + 1, cy + 4) - 0.5) * 0.6) * 0.07;
            const fy = (cy + 0.5 + (hash2(cx + 7, cy + 2) - 0.5) * 0.6) * 0.07;
            const dx = x - fx;
            const dy = y - fy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < 0.006) return gold;
            if (d < 0.012) return roseLight;
          }
        }
        return skirtCloth(x, y);
      }

      if (GARMENT.top.includes(pieceId)) {
        if (y < BODY.waist) return skirtCloth(x, y);
        // The bertha of lace and the edge of the bodice.
        if (y > 0.49) return lace;
        if (y > 0.455) return roseLight;
        // The stomacher: cream with diagonal gold lacing.
        if (Math.abs(x) < 0.046) {
          if (Math.abs(Math.abs(x) - 0.046) < 0.006) return gold;
          if (mod(x * 26 + y * 26, 1) < 0.12) return gold;
          return cream;
        }
        if (y > 0.412) return roseLight;
        return roseDeep;
      }
      return null;
    },
  },

  // ------------------------------------------------------------ dirndl
  // The Bavarian folk dress: a white blouse, a black bodice with gold lacing,
  // a red skirt and the white apron that is tied over it.
  dirndl: {
    label: "Bavarian Dirndl",
    paint({ x, y, pieceId }) {
      const white = rgb("#f6f3ea");
      const whiteShade = rgb("#e2dccb");
      const black = rgb("#26262f");
      const blackDeep = rgb("#191921");
      const red = rgb("#a82636");
      const redDeep = rgb("#821b28");
      const gold = rgb("#cfae62");

      const mod = (v, m) => ((v % m) + m) % m;
      const apron = Math.abs(x) < 0.092;
      // The apron is the same cloth on the skirt and on the lower top.
      const apronCloth = (yy) => {
        if (yy < -0.178) return whiteShade; // its hem
        if (mod(yy + 1, 0.055) < 0.0035) return whiteShade; // the weave
        return white;
      };

      if (GARMENT.neck.includes(pieceId)) return y > 0.5 ? white : whiteShade;

      if (GARMENT.arms.includes(pieceId)) {
        if (y < 0.11) return whiteShade; // the cuff
        if (y < 0.125) return white;
        return white; // the long blouse sleeve
      }

      if (GARMENT.skirt.includes(pieceId)) {
        if (y < -0.185) return redDeep;
        return apron ? apronCloth(y) : red;
      }

      if (GARMENT.top.includes(pieceId)) {
        // The white blouse above the bodice.
        if (y > 0.452) return white;
        // The gold border at the top of the bodice.
        if (y > 0.436) return gold;
        // Below the waist the skirt takes over, the apron stays in front.
        if (y < BODY.waist) {
          if (y > 0.175 && y < 0.192) return whiteShade; // the apron's waistband
          return apron ? apronCloth(y) : red;
        }
        // The bodice: black with the gold eyelets of the lacing.
        if (Math.abs(x) < 0.032) {
          for (let i = 0; i < 5; i++) {
            if (Math.abs(y - (0.235 + i * 0.04)) < 0.007 && Math.abs(Math.abs(x) - 0.015) < 0.009) {
              return gold;
            }
          }
          if (Math.abs(x) < 0.0035) return blackDeep;
        }
        return black;
      }
      return null;
    },
  },
};

// ---------------------------------------------------------------- painting
function hex({ r, g, b }) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

/** One direction of a box filter, as a sliding sum with edge clamping. */
function boxSum(src, out, width, height, radius, horizontal) {
  const n = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const at = (line, k) => src[horizontal ? line * width + k : k * width + line];
  const put = (line, k, value) => {
    out[horizontal ? line * width + k : k * width + line] = value;
  };
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += at(line, clamp(k, 0, n - 1));
    for (let k = 0; k < n; k++) {
      put(line, k, sum);
      sum += at(line, clamp(k + radius + 1, 0, n - 1)) - at(line, clamp(k - radius, 0, n - 1));
    }
  }
}

/**
 * The brightness around every pixel of the clothing page.
 *
 * The design has to look painted, not printed: it has to keep the folds and the
 * line art of the artwork. What it must not keep is the brightness of the old
 * garment - a white blouse must not turn grey because the sleeve it replaces is
 * dark. So the shading is the *local* contrast (this pixel against its
 * neighbourhood), which is roughly 1 on a flat area, below 1 in a fold or on a
 * line and above 1 on a highlight.
 */
function buildLocalShading(base, map) {
  const { width, height, data } = base;
  const total = width * height;
  const lum = new Float32Array(total);
  const weight = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (map.piece[i] < 0 || data[i * 4 + 3] < 8) continue;
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    weight[i] = 1;
  }
  const radius = 32;
  const scratch = new Float32Array(total);
  const sumLum = new Float32Array(total);
  const sumWeight = new Float32Array(total);
  boxSum(lum, scratch, width, height, radius, true);
  boxSum(scratch, sumLum, width, height, radius, false);
  boxSum(weight, scratch, width, height, radius, true);
  boxSum(scratch, sumWeight, width, height, radius, false);
  const ref = new Float32Array(total);
  for (let i = 0; i < total; i++) ref[i] = sumWeight[i] > 0 ? sumLum[i] / sumWeight[i] : 0;
  return ref;
}

function paintOutfit(id, design, layout, base, map, options) {
  const { width, height, data } = base;
  const out = new Uint8Array(data.length);
  out.set(data);
  const shade = buildLocalShading(base, map);

  const placed = new Map();
  let painted = 0;
  let details = 0;

  for (let i = 0; i < map.piece.length; i++) {
    const pieceId = map.piece[i];
    if (pieceId < 0) continue;
    if (!BODY_PIECES.has(pieceId)) continue; // hair, hit areas, ...
    if (data[i * 4 + 3] === 0) continue;

    const x = map.bodyX[i];
    const y = map.bodyY[i];
    const colour = design.paint({ x, y, pieceId, part: layout.drawables[pieceId]?.part });
    if (!colour) continue;

    const baseLum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const ref = Math.max(10, shade[i]);
    const ratio = Math.pow(baseLum / ref, 0.85);
    const k = colour.flat ? clamp(0.8 + 0.2 * ratio, 0.7, 1.2) : clamp(ratio, 0.32, 1.55);

    out[i * 4] = clamp(Math.round(colour.r * k), 0, 255);
    out[i * 4 + 1] = clamp(Math.round(colour.g * k), 0, 255);
    out[i * 4 + 2] = clamp(Math.round(colour.b * k), 0, 255);
    // out[i * 4 + 3] stays the base alpha - the silhouette never changes.
    painted++;
    if (colour.flat) details++;
    placed.set(pieceId, (placed.get(pieceId) ?? 0) + 1);
  }

  // The silhouette must be identical, the click-through depends on it.
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] !== data[i]) throw new Error(`alpha changed at pixel ${(i - 3) / 4}`);
  }

  return { out, painted, details, placed };
}

// ---------------------------------------------------------------- main
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const options = { checks: args.includes("--checks"), coverage: args.includes("--coverage") };
const wanted = args.filter((a) => !a.startsWith("--"));
const ids = wanted.length ? wanted : Object.keys(DESIGNS);

const layout = JSON.parse(fs.readFileSync(LAYOUT, "utf8"));
const base = decodePng(fs.readFileSync(BASE_ATLAS));
console.log(`clothing page: ${base.width}x${base.height}  ${path.relative(ROOT, BASE_ATLAS)}`);
const map = buildBodyMap(layout, base.width, base.height, 1);

// Report which pieces cover the atlas, and whether two pieces share pixels.
const owners = new Map();
for (let i = 0; i < map.piece.length; i++) {
  const id = map.piece[i];
  if (id < 0 || base.data[i * 4 + 3] === 0) continue;
  if (!owners.has(id)) owners.set(id, new Set());
  owners.get(id).add(i);
}
const shared = [];
const idsOnAtlas = [...owners.keys()].sort((a, b) => a - b);
for (let a = 0; a < idsOnAtlas.length; a++) {
  for (let b = a + 1; b < idsOnAtlas.length; b++) {
    const first = owners.get(idsOnAtlas[a]);
    const second = owners.get(idsOnAtlas[b]);
    const small = first.size < second.size ? first : second;
    const other = small === first ? second : first;
    let common = 0;
    for (const i of small) if (other.has(i)) common++;
    if (common > 0) shared.push({ a: idsOnAtlas[a], b: idsOnAtlas[b], pixels: common });
  }
}
if (shared.length) {
  console.log(`shared atlas pixels between pieces: ${shared.map((s) => `#${s.a}/#${s.b}=${s.pixels}`).join(", ")}`);
} else {
  console.log("every garment piece owns its own atlas pixels");
}

if (options.coverage) {
  // How much of every piece the rasterizer found, and how much of that is
  // actually opaque in the atlas. A piece that is missing here is a piece that
  // would keep its old artwork.
  console.log("\npiece coverage (rasterized / opaque / share of the atlas):");
  for (const drawable of layout.drawables) {
    if (drawable.texture !== 1) continue;
    if (!BODY_PIECES.has(drawable.index)) continue;
    let rasterized = 0;
    let opaque = 0;
    for (let i = 0; i < map.piece.length; i++) {
      if (map.piece[i] !== drawable.index) continue;
      rasterized++;
      if (base.data[i * 4 + 3] > 0) opaque++;
    }
    console.log(
      `  #${String(drawable.index).padStart(2)} ${(drawable.part || "").padEnd(18)} rasterized=${String(rasterized).padStart(7)} opaque=${String(opaque).padStart(7)}`,
    );
  }
}

/**
 * Samples what the painted atlas will show at a point of the body. That is the
 * only way to judge the result without eyes: it reads the colour back through
 * the same body map the painting used.
 */
function swatch(out, map, x, y) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < map.piece.length; i++) {
    if (map.piece[i] < 0) continue;
    if (Math.abs(map.bodyX[i] - x) > 0.012) continue;
    if (Math.abs(map.bodyY[i] - y) > 0.012) continue;
    if (out[i * 4 + 3] < 200) continue;
    r += out[i * 4];
    g += out[i * 4 + 1];
    b += out[i * 4 + 2];
    n++;
  }
  if (!n) return "none";
  return hex({ r: r / n, g: g / n, b: b / n });
}

/** Landmarks used to read the design back: name, x, y. */
const CHECKS = [
  ["skirt hem", 0, -0.16],
  ["skirt mid", 0, 0.0],
  ["skirt waist", 0, 0.185],
  ["belly", 0, 0.3],
  ["chest", 0, 0.36],
  ["sternum", 0, 0.45],
  ["collar V", 0.09, 0.5],
  ["shoulder", 0.13, 0.51],
  ["neck", 0, 0.56],
  ["cuff", -0.11, 0.09],
  ["forearm", -0.11, 0.2],
  ["upper arm", -0.14, 0.45],
];

for (const id of ids) {
  const design = DESIGNS[id];
  if (!design) {
    console.error(`no design for outfit "${id}"`);
    process.exitCode = 1;
    continue;
  }
  const result = paintOutfit(id, design, layout, base, map);
  const target = path.join(OUTFITS, id, "texture_01.png");
  if (!dry) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, encodePng(base.width, base.height, result.out));
  }
  const perPiece = [...result.placed.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pieceId, count]) => `#${pieceId}:${(count / 1000).toFixed(0)}k`)
    .join(" ");
  console.log(`\n${dry ? "would paint" : "painted"} ${id} (${design.label})`);
  console.log(`  ${(result.painted / 1e6).toFixed(2)}M pixels, ${result.details.toLocaleString()} detail px`);
  console.log(`  ${perPiece}`);
  console.log(`  -> ${path.relative(ROOT, target)}`);
  if (options.checks) {
    for (const [name, x, y] of CHECKS) console.log(`  ${name.padEnd(12)} ${swatch(result.out, map, x, y)}`);
  }
}

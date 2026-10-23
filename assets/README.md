# Character assets

```
assets/characters/<character>/
├── base/          the Live2D model (moc3, textures, expressions, motions)
└── outfits/
    ├── yukata/    a painted outfit (outfit.json + texture_01.png)
    ├── europe/
    └── default/   the model itself, no artwork
```

The id of the folder is the id of the outfit.

## The exact files the engine loads

The engine reads the texture list of the model out of its `*.model3.json`
(`FileReferences.Textures`) and looks for every outfit in
`<character>/outfits/<outfit id>/`.

For Aria that is:

| # | Base atlas (the model)              | Size      | Outfit file that replaces it |
|---|-------------------------------------|-----------|------------------------------|
| 0 | `base/Haru.2048/texture_00.png`     | 2048x2048 | `texture_00.png`             |
| 1 | `base/Haru.2048/texture_01.png`     | 2048x2048 | `texture_01.png`             |

So an outfit folder has to end up with exactly this:

```
assets/characters/aria/outfits/<outfit id>/
├── outfit.json      optional, the label and the category for the menu
└── texture_01.png   2048x2048, PNG with an alpha channel
```

Only `texture_01.png` is shipped: it is the clothing page. Everything that is
not clothes - the face, the hair, the hands, the arms' skin and the legs - is
on `texture_00.png`, so an outfit leaves that page alone and the base atlas is
used. The size and the alpha channel of the shipped page are checked against
the base atlas; an outfit that does not fit is marked as unusable.

The file names are fixed by the model, they are **not** free. The engine reads
them from `Haru.model3.json`:

```json
"Textures": [ "Haru.2048/texture_00.png", "Haru.2048/texture_01.png" ]
```

Two layouts are accepted, both are found:

1. **flat** - `outfits/bunny/texture_00.png` (recommended)
2. **mirrored** - `outfits/bunny/Haru.2048/texture_00.png`, the same relative
   path the model uses

An atlas that is not found is simply not replaced: the base atlas stays. An
outfit may therefore replace only one of the two atlases.

### The outfits and their files

The menu is fixed by `src/outfits.ts`. Every outfit only replaces the
**clothing page** (`texture_01.png`); the face, the hair, the hands and the
skin live on `texture_00.png`, which is never shipped with an outfit, so the
base atlas stays.

| Menu entry             | Folder id   | Category | Files          |
|------------------------|-------------|----------|----------------|
| Yukata                 | `yukata`    | Japanese | `texture_01.png` |
| Sailor Uniform         | `seifuku`   | Japanese | `texture_01.png` |
| Miko (Shrine Maiden)   | `miko`      | Japanese | `texture_01.png` |
| Furisode Kimono        | `furisode`  | Japanese | `texture_01.png` |
| School Blazer          | `blazer`    | Japanese | `texture_01.png` |
| Zero Two (Pilot Suit)  | `zero_two`  | Anime    | `texture_01.png` |
| European Gown          | `europe`    | European | `texture_01.png` |
| Rococo Gown            | `rococo`    | European | `texture_01.png` |
| Bavarian Dirndl        | `dirndl`    | European | `texture_01.png` |
| Default (Office Suit)  | `default`   | Default  | -              |

The folder name is the id, the name in the menu comes from `outfit.json`.
A folder that is not in the preset list is not offered, so the menu always
shows the same set.

## What the artwork has to be

An outfit is **not** a second sprite that is drawn on top of her and it is
**not** a sprite sheet with frames. Aria is one Live2D mesh
(`base/Haru.moc3`), her body, her face and every pose live in that mesh, and
the artwork of the mesh lives in the two texture atlases.

An outfit is therefore a **new set of texture atlases with the same UV
layout**. The mesh, the physics, the expressions and the motions are never
touched, only the pixels of the atlases are replaced. That is why switching an
outfit can never move her head or break the alignment of the overlay.

The rules for the artwork:

* **the file name has to be the same** as the atlas it replaces
  (`texture_00.png`),
* **the pixel size has to be exactly the same** as the base atlas (2048x2048
  here). The mesh addresses the pixels by UV coordinates, a different size
  would stretch the drawing. The backend reads the size out of the png header
  and marks an outfit that does not fit as unusable,
* **the alpha channel has to stay the same.** The silhouette of the character
  is the alpha of the atlases, and the click through of the overlay is built
  from it. If an outfit gets a different alpha, the click through breaks. The
  placeholder generator checks that the alpha is byte for byte the same as the
  base atlas,
* **the drawing has to stay inside the same UV layout.** Only the clothes are
  painted differently, the head, the hands and the face keep their place.

`outfit.json` is optional:

```json
{
  "label": "Zero Two (Pilot Suit)",
  "category": "Anime",
  "order": 1
}
```

Without it the name is made out of the folder name (`yukata` -> `Yukata`) and
the category is `Custom`.

An outfit without its atlases is still listed in the menu, but it is marked as
missing. Picking it falls back to the default outfit.

The `default` folder does not need any artwork: the default outfit is the
model itself.

## Painting the outfits

The clothed outfits are painted by `tools/paint-outfits.mjs`, not by hand.
Every pixel of the clothing page knows which piece of the mesh it belongs to
and where on the body it sits, because the mesh of every drawable was exported
to `tools/uv-layout.json` (positions, uvs, triangle indices, uv box).

That allows a design to be written in **body space** - "the skirt is below the
waist", "the collar is a V at the neck" - and every atlas pixel is then
painted from that description:

```powershell
node tools/paint-outfits.mjs                 # paint every design
node tools/paint-outfits.mjs yukata rococo   # paint only these
node tools/paint-outfits.mjs --dry europe    # report only, write nothing
node tools/paint-outfits.mjs --checks miko   # read the design back at landmarks
node tools/paint-outfits.mjs --coverage      # which pixels every piece owns
```

The painter

* keeps the alpha channel of the base atlas byte for byte (asserted, not
  assumed), so the click-through silhouette never changes,
* keeps the shading of the base art as a *local* high pass (folds, seams and
  line art survive; the old garment's brightness does not),
* maps UV `v` to PNG row `(1 - v) * height`, because Pixi uploads the atlases
  flipped - reading `v` directly paints every design upside down,
* never touches `texture_00.png` (face, hair, hands, legs).

`tools/preview-outfit.mjs` verifies the result on the running app: it switches
the outfit over CDP, reads the live mesh and prints an ASCII map of the body
(`--map`), the atlas colour of every piece at a point (`--probe x,y`) or the
colours down the body (`--strip`).

To paint a new outfit by hand, open the base atlas in an image editor, paint
the clothes over the garment pixels and save it as
`outfits/<id>/texture_01.png` with the same pixel size. The alpha channel has
to be the base atlas's alpha - `--coverage` and `--checks` show whether the
paint landed on the clothing pieces only.

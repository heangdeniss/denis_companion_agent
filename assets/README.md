# Character assets

```
assets/characters/<character>/
├── base/          the Live2D model (moc3, textures, expressions, motions)
└── outfits/
    ├── default/
    ├── bunny/
    └── ...
```

The id of the folder is the id of the outfit. The ones the menu offers are
`default`, `bunny`, `knit`, `qipao`, `streetwear`, `smart_casual`,
`gothic_maid` and `vintage_swing`.

## How an outfit works

Aria is a Live2D model. Her body, her face and every pose live in one mesh
(`base/*.moc3`) and the artwork of that mesh lives in the texture atlases
(`base/*.2048/texture_00.png`, `texture_01.png`).

An outfit is therefore **not** a second sprite that is drawn on top of her.
An outfit is a **new set of texture atlases that use the same UV layout**:

```
outfits/bunny/
├── outfit.json          label and category for the menu
├── texture_00.png       replaces base/*.2048/texture_00.png
└── texture_01.png       replaces base/*.2048/texture_01.png
```

The rules for the artwork:

* the file name has to be the same as the atlas it replaces (`texture_00.png`),
* the pixel size has to be **exactly** the same as the base atlas
  (2048x2048 here) - the mesh addresses the pixels by UV coordinates, a
  different size would stretch the drawing,
* the drawing itself has to stay inside the same UV layout, only the clothes
  are painted differently. The head, the hands and the face keep their
  place.

The atlas may also be put at the same path the model uses
(`outfits/bunny/Haru.2048/texture_00.png`), both are found.

Because only the pixels are replaced and the mesh, the physics, the
expressions and the motions are left alone, switching an outfit can never
move her head or break the alignment of the overlay.

`outfit.json` is optional:

```json
{
  "label": "Bunny Suit",
  "category": "Sexy",
  "order": 1
}
```

An outfit without its atlases is still listed in the menu, but it is marked
as missing. Picking it falls back to the default outfit.

The `default` folder does not need any artwork: the default outfit is the
model itself.

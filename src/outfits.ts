import type { OutfitEntry } from "./types";

/** The id of the outfit that is always there. */
export const DEFAULT_OUTFIT = "default";

/**
 * The outfits that are offered in the menu.
 *
 * The list is fixed, so the menu always looks the same. Whether an outfit can
 * be worn depends on the artwork that is in the assets folder - the backend
 * reports that for every outfit.
 */
export const OUTFIT_PRESETS: OutfitPreset[] = [
  { id: "default", label: "Default (Office Suit)", category: "Default" },
  { id: "bunny", label: "Bunny Suit", category: "Sexy" },
  { id: "knit", label: "Off-Shoulder Knit", category: "Sexy" },
  { id: "qipao", label: "Qipao", category: "Sexy" },
  { id: "streetwear", label: "Streetwear Hoodie", category: "Modern" },
  { id: "smart_casual", label: "Smart Casual", category: "Modern" },
  { id: "gothic_maid", label: "Gothic Maid", category: "Vintage" },
  { id: "vintage_swing", label: "50s Retro Swing", category: "Vintage" },
];

/** The order of the categories in the menu. */
export const OUTFIT_CATEGORIES = ["Default", "Sexy", "Modern", "Vintage"];

export interface OutfitPreset {
  id: string;
  label: string;
  category: string;
}

/** An outfit of the menu: a preset plus what the backend found. */
export interface OutfitOption extends OutfitEntry {
  /** True when the outfit can be worn right now. */
  available: boolean;
}

/**
 * Merges the presets with the outfits that were found in the assets folder.
 *
 * A preset without artwork is still listed, it is marked as missing and
 * picking it falls back to the default outfit.
 */
export function mergeOutfits(found: OutfitEntry[]): OutfitOption[] {
  const byId = new Map(found.map((entry) => [entry.id, entry]));
  const options: OutfitOption[] = [];

  for (const preset of OUTFIT_PRESETS) {
    const entry = byId.get(preset.id);
    options.push({
      id: preset.id,
      label: entry?.label || preset.label,
      category: entry?.category || preset.category,
      path: entry?.path ?? "",
      textures: entry?.textures ?? [],
      // The default outfit is the model itself, it is always there.
      available: preset.id === DEFAULT_OUTFIT || Boolean(entry?.available),
      problem:
        entry?.problem ??
        (preset.id === DEFAULT_OUTFIT ? "" : "no artwork yet"),
    });
  }

  // Outfits that are not part of the presets are shown as well, they come
  // from the assets folder.
  for (const entry of found) {
    if (options.some((option) => option.id === entry.id)) continue;
    options.push({ ...entry });
  }

  return options;
}

/**
 * Groups the outfits for the menu: one group per category, the categories
 * keep the order of `OUTFIT_CATEGORIES`.
 */
export function groupOutfits(
  options: OutfitOption[],
): { category: string; items: OutfitOption[] }[] {
  const byCategory = new Map<string, OutfitOption[]>();
  for (const option of options) {
    const list = byCategory.get(option.category) ?? [];
    list.push(option);
    byCategory.set(option.category, list);
  }

  const groups: { category: string; items: OutfitOption[] }[] = [];
  for (const category of OUTFIT_CATEGORIES) {
    const items = byCategory.get(category);
    if (!items?.length) continue;
    groups.push({ category, items });
    byCategory.delete(category);
  }
  // Categories that are not part of the fixed order come last.
  for (const [category, items] of byCategory) {
    groups.push({ category, items });
  }
  return groups;
}

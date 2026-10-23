import type { OutfitEntry } from "./types";

/** The id of the outfit that is always there. */
export const DEFAULT_OUTFIT = "default";

/**
 * The outfits that are offered in the menu.
 *
 * The list is fixed, so the menu always looks the same. Whether an outfit can
 * be worn depends on the artwork that is in the assets folder - the backend
 * reports that for every outfit.
 *
 * Every outfit in the list is a painted version of the clothing page of the
 * model (texture_01): the body, the face and the hair are never touched.
 */
export const OUTFIT_PRESETS: OutfitPreset[] = [
  { id: "yukata", label: "Yukata", category: "Japanese" },
  { id: "seifuku", label: "Sailor Uniform", category: "Japanese" },
  { id: "miko", label: "Miko (Shrine Maiden)", category: "Japanese" },
  { id: "furisode", label: "Furisode Kimono", category: "Japanese" },
  { id: "blazer", label: "School Blazer", category: "Japanese" },
  { id: "zero_two", label: "Zero Two (Pilot Suit)", category: "Anime" },
  { id: "europe", label: "European Gown", category: "European" },
  { id: "rococo", label: "Rococo Gown", category: "European" },
  { id: "dirndl", label: "Bavarian Dirndl", category: "European" },
  { id: "default", label: "Default (Office Suit)", category: "Default" },
];

/** The order of the categories in the menu. */
export const OUTFIT_CATEGORIES = ["Japanese", "Anime", "European", "Default"];

export interface OutfitPreset {
  id: string;
  label: string;
  category: string;
}

/** An outfit of the menu: a preset plus what the backend found. */
export interface OutfitOption extends OutfitEntry {
  /** True when the outfit can be worn right now. */
  available: boolean;
  /**
   * True when the outfit folder holds the clothing page.
   *
   * An outfit without artwork is not an error: the base clothes stay on and
   * the menu marks it, so it is clear that it still has to be painted.
   */
  hasArtwork: boolean;
}

/**
 * Merges the presets with the outfits that were found in the assets folder.
 *
 * Only the presets are offered: an outfit folder that is not in the list is
 * ignored, so the menu stays the fixed set that the app ships with. A preset
 * without artwork is still listed, it is marked as missing and picking it
 * falls back to the default outfit.
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
      available: preset.id === DEFAULT_OUTFIT || (entry ? entry.available : true),
      hasArtwork:
        preset.id === DEFAULT_OUTFIT || (entry?.textures.length ?? 0) > 0,
      problem: entry?.problem ?? "",
    });
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

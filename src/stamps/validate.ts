/**
 * Structural validation for `StampsConfig`. Returns a flat list of
 * human-readable problem descriptions (empty when the config is valid);
 * this module never throws.
 */
import { IMPLEMENTED_LAYER_TYPES, type StampsConfig } from '@/core/types';
import { isValidHexColor } from './color';

/** Validate a `StampsConfig` and return a list of problems found. */
const IMPLEMENTED_LAYER_TYPE_SET = new Set<string>(IMPLEMENTED_LAYER_TYPES);

export function validateStampsConfig(cfg: StampsConfig): string[] {
  const problems: string[] = [];

  const definitionIds = new Set<string>();
  for (const def of cfg.definitions) {
    if (definitionIds.has(def.id)) {
      problems.push(`duplicate stamp definition id: "${def.id}"`);
    }
    definitionIds.add(def.id);

    if (def.layers.length === 0) {
      problems.push(`stamp "${def.id}" has no layers`);
    }

    for (const layer of def.layers) {
      if (!IMPLEMENTED_LAYER_TYPE_SET.has(layer.type)) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has unimplemented type "${layer.type}"`);
        continue;
      }

      if (layer.type === 'text' || layer.type === 'pageNumber') {
        if (layer.size <= 0) {
          problems.push(`stamp "${def.id}" layer "${layer.id}" has non-positive size (${layer.size})`);
        }
        if (!isValidHexColor(layer.color)) {
          problems.push(`stamp "${def.id}" layer "${layer.id}" has an invalid colour "${layer.color}"`);
        }
      }
      if (layer.type === 'text' && layer.text.length === 0) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has empty text`);
      }
      if (layer.type === 'pageNumber' && layer.template.length === 0) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has an empty template`);
      }
      if (layer.type === 'image' && layer.src.length === 0) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has an empty image src`);
      }
      if (layer.type === 'image' && layer.width !== undefined && layer.width <= 0) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has non-positive width (${layer.width})`);
      }
      if (layer.type === 'image' && layer.height !== undefined && layer.height <= 0) {
        problems.push(`stamp "${def.id}" layer "${layer.id}" has non-positive height (${layer.height})`);
      }
    }
  }

  const instanceIds = new Set<string>();
  for (const inst of cfg.instances) {
    if (instanceIds.has(inst.id)) {
      problems.push(`duplicate stamp instance id: "${inst.id}"`);
    }
    instanceIds.add(inst.id);

    if (!definitionIds.has(inst.stampId)) {
      problems.push(`instance "${inst.id}" references unknown stampId "${inst.stampId}"`);
    }
  }

  return problems;
}

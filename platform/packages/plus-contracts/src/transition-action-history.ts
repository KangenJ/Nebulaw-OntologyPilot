import type { CompiledDefinition } from './types.js';
import { array, fields, oneOf, requireContract, text } from './validation.js';

/** Full policy body becomes part of the independently approved recipe. This
 * structural validator cannot establish native inventory or runtime authority. */
export interface TransitionActionHistoryContract {
  version: 'plus-native-action-interval-policy-v1' | 'plus-native-action-interval-policy-v2' | 'plus-native-action-interval-policy-v3'; id: string;
  rootType: string; rootEpisodeLink: string; nativeActions: string[];
  inventory: 'TENANT_WIDE'; orphanPolicy: 'REJECT_INTERVAL';
}
export function validateTransitionActionHistoryContract(raw: unknown, compiled: CompiledDefinition): TransitionActionHistoryContract {
  const path = '$transitionActionHistory', r = fields(raw, ['version', 'id', 'rootType', 'rootEpisodeLink', 'nativeActions', 'inventory', 'orphanPolicy'], path);
  // v2 explicitly opts into root/interval semantic dependencies after full
  // native inventory requalification. Recipe/component hashes bind this change.
  // v3 additionally separates historical request authorization snapshots from
  // semantic dependencies. Every use still requires fresh native qualification;
  // this version does not authorize replaying a saved permission certificate.
  oneOf(r.version, ['plus-native-action-interval-policy-v1', 'plus-native-action-interval-policy-v2', 'plus-native-action-interval-policy-v3'], path + '.version');
  oneOf(r.inventory, ['TENANT_WIDE'], path + '.inventory');
  oneOf(r.orphanPolicy, ['REJECT_INTERVAL'], path + '.orphanPolicy');
  for (const k of ['id', 'rootType', 'rootEpisodeLink']) text(r[k], path + '.' + k, 2000);
  array(r.nativeActions, 1, 32, path + '.nativeActions');
  r.nativeActions.forEach(a => text(a, path + '.nativeActions', 2000));
  requireContract(new Set(r.nativeActions).size === r.nativeActions.length && r.rootType === compiled.definition.rootType
    && compiled.definition.actions.every(a => (r.nativeActions as unknown[]).includes(a.nativeAction)),
    'TRANSITION_ACTION_HISTORY_CONTRACT', path, 'Exact root and every bound native action must be inventoried, including controls excluded from fitting');
  return structuredClone(r) as unknown as TransitionActionHistoryContract;
}

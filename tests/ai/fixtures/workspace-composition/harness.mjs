// Earlier behavior cases run through the copied CURRENT harness and CURRENT UI.
import {harness as currentHarness, fullDrawOracle} from '../../workspace-activation-harness.mjs';
export {fullDrawOracle};
export function harness(source, options={}) {
 return currentHarness(source,undefined,{...options,reduced:options.reducedMotion ?? true});
}

import { HooksConfigMap } from './hooks/balancer-hook-event-subscriber';
import { Step } from './types';

export function getUniqueHookNames(hooksConfigMap: HooksConfigMap): string {
  // Use Object.values to get all HookConfig objects
  // Then map to extract just the names
  // Use Set to get unique names
  // Convert back to array and join with comma
  return Array.from(
    new Set(Object.values(hooksConfigMap).map(hook => hook.apiName)),
  ).join(', ');
}

/**
 * Removes adjacent pairs of buffer steps that form circular swaps.
 * Only removes pairs where both steps have isBuffer=true and
 * first step's tokenIn equals second step's tokenOut.
 *
 * @param steps - Array of sequential swap steps
 * @returns Filtered array with circular buffer pairs removed
 */
export function removeCircularStepPairs(steps: Step[]): Step[] {
  const result: Step[] = [];
  let i = 0;

  while (i < steps.length) {
    const currentStep = steps[i];
    const nextStep = steps[i + 1];

    // Check if current step and next step form a circular pair AND both are buffer steps
    const isCircularPair =
      nextStep !== undefined &&
      currentStep.swapInput.tokenIn === nextStep.swapInput.tokenOut &&
      currentStep.isBuffer &&
      nextStep.isBuffer;

    if (isCircularPair) {
      // Skip both steps (they cancel each other out)
      i += 2;
    } else {
      // Keep this step
      result.push(currentStep);
      i += 1;
    }
  }

  return result;
}

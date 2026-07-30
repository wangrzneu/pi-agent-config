let planModeActive = false;

export function setPlanModeActive(active: boolean): void {
  planModeActive = active;
}

export function isPlanModeActive(): boolean {
  return planModeActive;
}

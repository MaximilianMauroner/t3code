export type ParkingNavigationDecision<T> =
  | { readonly type: "none" }
  | { readonly type: "select"; readonly destination: T }
  | { readonly type: "clear" };

export function resolveParkingNavigation<T>(input: {
  readonly parkedKey: string;
  readonly selectedKeyBefore: string | null;
  readonly selectedKeyAfter: string | null;
  readonly succeeded: boolean;
  readonly destination: T | null;
}): ParkingNavigationDecision<T> {
  if (
    !input.succeeded ||
    input.selectedKeyBefore !== input.parkedKey ||
    input.selectedKeyAfter !== input.parkedKey
  ) {
    return { type: "none" };
  }
  return input.destination === null
    ? { type: "clear" }
    : { type: "select", destination: input.destination };
}

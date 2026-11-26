type MigrationRow = { readonly id: number; readonly name: string };

/**
 * Preflight must refuse old V2 previews. Their previous adoption routine moved
 * ids into 55?56, which are already occupied by released J1 migrations.
 * A conversion would need a verified copy with explicit history provenance.
 */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  return history.some(({ id, name }) => (id === 53 || id === 54) && name === "OrchestrationV2")
    ? null
    : history;
}

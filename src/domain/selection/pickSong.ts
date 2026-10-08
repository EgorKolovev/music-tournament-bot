// Выдача песни в отборе (docs/architecture.md, раздел 5): из пула убираются песни этого матча
// и песни, присланные или уже известные любому из игроков; затем случайная среди наименее использованных.
// Сложность песни в выборе не участвует.

export interface PoolSong {
  id: string;
  ownerIds: readonly string[];
}

export interface SelectionContext {
  playerIds: readonly string[];
  usedInMatch: ReadonlySet<string>;
  knownByPlayers: ReadonlySet<string>;
}

export function eligibleSongs<T extends PoolSong>(pool: readonly T[], context: SelectionContext): T[] {
  return pool.filter(
    (song) =>
      !context.usedInMatch.has(song.id) &&
      !context.knownByPlayers.has(song.id) &&
      !song.ownerIds.some((owner) => context.playerIds.includes(owner)),
  );
}

export function pickLeastUsed<T extends PoolSong>(
  candidates: readonly T[],
  usage: ReadonlyMap<string, number>,
  random: () => number,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const minUsage = Math.min(...candidates.map((song) => usage.get(song.id) ?? 0));
  const leastUsed = candidates.filter((song) => (usage.get(song.id) ?? 0) === minUsage);
  return leastUsed[Math.floor(random() * leastUsed.length)];
}

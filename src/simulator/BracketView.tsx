import { playersOf, type Bracket, type Results, type Slot } from '../domain/bracket/bracket.ts';

interface Props {
  bracket: Bracket;
  results: Results;
  names: Map<string, string>;
  roundTitles?: string[];
  // Подсветка матча, который идёт сейчас, и интерактивных игроков.
  activeMatchId?: string;
  highlight?: Set<string>;
  // Проходы без игры занимают много места в больших сетках — их можно свернуть.
  hideByes?: boolean;
}

export function BracketView({ bracket, results, names, roundTitles, activeMatchId, highlight, hideByes }: Props) {
  const label = (slot: Slot, matchId: string, index: 0 | 1) => {
    const pair = playersOf(bracket, results, matchId);
    const id = pair?.[index] ?? (slot.kind === 'player' ? slot.id : undefined);
    if (id) return { id, text: names.get(id) ?? id };
    if (slot.kind === 'bye') return { id: undefined, text: 'проход' };
    return { id: undefined, text: '…' };
  };

  return (
    <div className="bracket">
      {bracket.rounds.map((round, r) => {
        const matches = hideByes ? round.filter((m) => !m.isBye) : round;
        const byes = round.length - matches.length;
        return (
          <div key={r} className="bracket-round">
            <div className="bracket-title">{roundTitles?.[r] ?? `${r + 1}-й круг`}</div>
            {matches.map((match) => {
              const winner = results[match.id];
              return (
                <div key={match.id} className={`bracket-match${match.id === activeMatchId ? ' active' : ''}`}>
                  {([0, 1] as const).map((i) => {
                    const { id, text } = label(match.slots[i], match.id, i);
                    const classes = [
                      'bracket-slot',
                      winner && id === winner ? 'won' : '',
                      winner && id && id !== winner ? 'lost' : '',
                      id && highlight?.has(id) ? 'me' : '',
                    ];
                    return (
                      <div key={i} className={classes.filter(Boolean).join(' ')}>
                        {text}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {byes > 0 && <div className="muted small">+ {byes} без игры</div>}
          </div>
        );
      })}
    </div>
  );
}

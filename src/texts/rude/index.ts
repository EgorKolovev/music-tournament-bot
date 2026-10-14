import type { Style } from '../index.ts';
import { commands } from './commands.ts';
import { draw } from './draw.ts';
import { events } from './events.ts';
import { final } from './final.ts';
import { intake } from './intake.ts';
import { leave } from './leave.ts';
import { match } from './match.ts';
import { registration } from './registration.ts';

// Ругательный стиль — в духе Куно из Disco Elysium. Бот говорит о себе в третьем лице («Ботик»,
// никогда «я»), задирается, но на деле не злой: «Ботику похуй… ладно, не похуй», «Ботик уважает».
// Мат — про ситуацию, песни и файлы; человека не оскорбляем.

export const rude: Style = {
  name: '🤬 Ругательный',
  sample: 'Ебать, ты в финале! Ботик уважает.',
  warning: [
    'Мат почти в каждом сообщении. Бот зовёт себя «Ботик», задирается и матерится — по-дружески: про песни, файлы и ситуацию, а не про тебя.',
    '',
    'Примерно так:',
    '• «Ебаная песня, как там её, бляяя?»',
    '• «Трек 2 проёбан: аудио сдохло, не считается.»',
    '• «Хуль ты у Ботика спрашиваешь? Нет такой команды.»',
  ].join('\n'),
  texts: { registration, intake, draw, match, final, commands, leave, events },
};
